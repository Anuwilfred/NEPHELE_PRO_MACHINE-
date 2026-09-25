require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ensureAuthSchema, bootstrapFirstAdmin, requireAuth, requireAdmin, createAuthRouter } = require("./auth");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Accounts/sessions/invites schema, and the first admin account (from
// ADMIN_EMAIL/ADMIN_PASSWORD, set once at install time) if none exists yet.
// Every route below that touches real data is registered AFTER this promise
// resolves, so nothing can race a request in against a half-migrated table.
const authReady = (async () => {
  await ensureAuthSchema(pool);
  await bootstrapFirstAdmin(pool);
})().catch((err) => {
  console.error("Auth schema/bootstrap failed:", err.message);
});

// Phase 2: serves the Tag Management page (plain HTML/React, no build step)
// at http://localhost:3000/ -- same origin as the API, so no CORS needed
// for the browser calls it makes. accept-invite.html and the login screen
// itself must stay reachable WITHOUT a session, everything else in here is
// gated by requireAuth below.
app.use(express.static(path.join(__dirname, "..", "..", "web-app")));

app.use(async (req, res, next) => {
  await authReady;
  next();
});

app.use("/api/auth", createAuthRouter(express, pool));

// Proves the whole pipe end to end: Corvina -> Ingestion Service ->
// Postgres -> here -> whatever calls this endpoint (curl, a browser,
// or eventually the dashboard's widgets).
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/tags/latest", requireAuth(pool), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.display_name, t.source_name, t.unit, t.device_id,
              v.value_numeric, v.value_text, v.value_bool, v.updated_at
       FROM tags t
       LEFT JOIN latest_values v ON v.tag_id = t.id
       ORDER BY t.device_id, t.source_name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- Devices (tile view) -------------------------------------------------

// One row per device: online/offline status (as last reported by
// Corvina), how many tags we know about, and when we last heard from it.
// This is what the Devices tile screen reads.
app.get("/api/devices", requireAuth(pool), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.name, d.online, d.last_seen_at, d.geo_lat, d.geo_lng,
              COUNT(t.id) AS tag_count
       FROM devices d
       LEFT JOIN tags t ON t.device_id = d.id
       GROUP BY d.id, d.name, d.online, d.last_seen_at, d.geo_lat, d.geo_lng
       ORDER BY d.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- Phase 2: Tag Management --------------------------------------------

// Full tag list with all editable metadata, current value, and the
// device's friendly name -- what the Tag Management screen reads.
// ?device_id=<id> narrows it to one device (used by the device drill-down).
app.get("/api/tags", requireAuth(pool), async (req, res) => {
  try {
    const { deviceId } = req.query.device_id ? { deviceId: req.query.device_id } : {};
    const whereClause = deviceId ? "WHERE t.device_id = $1" : "";
    const params = deviceId ? [deviceId] : [];
    const { rows } = await pool.query(
      `SELECT t.id, t.device_id, d.name AS device_name, t.source_name,
              t.display_name, t.unit, t.data_type,
              t.min_value, t.max_value, t.alarm_low, t.alarm_high,
              v.value_numeric, v.value_text, v.value_bool, v.updated_at
       FROM tags t
       JOIN devices d ON d.id = t.device_id
       LEFT JOIN latest_values v ON v.tag_id = t.id
       ${whereClause}
       ORDER BY d.name, t.source_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Edit a tag's friendly metadata -- the only things a person changes on
// this screen. Anything not sent in the body is left as-is.
const EDITABLE_TAG_FIELDS = [
  "display_name",
  "unit",
  "min_value",
  "max_value",
  "alarm_low",
  "alarm_high",
];

app.patch("/api/tags/:id", requireAuth(pool), requireAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = Object.keys(req.body || {}).filter((key) =>
    EDITABLE_TAG_FIELDS.includes(key)
  );

  if (updates.length === 0) {
    return res.status(400).json({ message: "No editable fields provided." });
  }

  const setClause = updates.map((field, i) => `${field} = $${i + 2}`).join(", ");
  const values = updates.map((field) => req.body[field]);

  try {
    const { rows } = await pool.query(
      `UPDATE tags SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Tag not found." });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend API listening on :${port}`));
