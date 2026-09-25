const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Self-migrating on purpose: schema.sql only runs once, the first time the
// Postgres container starts, so adding a column later needs this instead
// of a Docker rebuild. IF NOT EXISTS makes it safe to run on every start.
async function ensureSchema() {
  await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS geo_lng DOUBLE PRECISION;
  `);
  // One-time cleanup: earlier runs stored Corvina's [0, 0] "no GPS fix yet"
  // placeholder as a real position (see index.js). Clear any rows still
  // carrying that placeholder so the map stops showing a device sitting in
  // the Gulf of Guinea. New polls no longer write it in the first place.
  await pool.query(`
    UPDATE devices SET geo_lat = NULL, geo_lng = NULL
    WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL
      AND abs(geo_lat) < 0.01 AND abs(geo_lng) < 0.01;
  `);
}
const ready = ensureSchema().catch((err) => {
  console.error("Schema migration failed:", err.message);
});

async function upsertDevice(device) {
  await ready;
  await pool.query(
    `INSERT INTO devices (id, name, online, last_seen_at, geo_lat, geo_lng)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           online = EXCLUDED.online,
           last_seen_at = now(),
           geo_lat = COALESCE(EXCLUDED.geo_lat, devices.geo_lat),
           geo_lng = COALESCE(EXCLUDED.geo_lng, devices.geo_lng)`,
    [device.id, device.name, device.online ?? true, device.geoLat ?? null, device.geoLng ?? null]
  );
}

async function upsertTag(tag) {
  // display_name/unit are only set on the FIRST insert (a starting point
  // from Corvina's own tag definition) -- on conflict they're deliberately
  // left alone, so edits made in the Tag Management screen are never
  // overwritten by the ingestion service on a later poll or restart.
  await pool.query(
    `INSERT INTO tags (id, device_id, source_name, data_type, display_name, unit)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET source_name = EXCLUDED.source_name,
           data_type = EXCLUDED.data_type`,
    [
      tag.id,
      tag.deviceId,
      tag.name,
      tag.dataType ?? "number",
      tag.displayName ?? null,
      tag.unit ?? null,
    ]
  );
}

async function writeValue(tagId, value, timestamp) {
  const isNumeric = typeof value === "number";
  const isBool = typeof value === "boolean";
  const numeric = isNumeric ? value : null;
  const bool = isBool ? value : null;
  const text = !isNumeric && !isBool ? String(value) : null;
  const ts = timestamp ? new Date(timestamp) : new Date();

  await pool.query(
    `INSERT INTO latest_values (tag_id, value_numeric, value_text, value_bool, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tag_id) DO UPDATE
       SET value_numeric = EXCLUDED.value_numeric,
           value_text = EXCLUDED.value_text,
           value_bool = EXCLUDED.value_bool,
           updated_at = EXCLUDED.updated_at`,
    [tagId, numeric, text, bool, ts]
  );

  await pool.query(
    `INSERT INTO tag_history (time, tag_id, value_numeric, value_text, value_bool)
     VALUES ($1, $2, $3, $4, $5)`,
    [ts, tagId, numeric, text, bool]
  );
}

module.exports = { pool, upsertDevice, upsertTag, writeValue };
