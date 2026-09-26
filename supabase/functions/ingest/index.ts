// Ingestion, as a Supabase Edge Function.
//
// Two ways this gets invoked:
//
// 1. Background sweep (pg_cron, every ~15 minutes): a plain GET/POST with no
//    device_id. Polls every ENABLED row in corvina_connections -- each one a
//    separate Corvina Cloud organization connected from the app's Settings
//    screen -- and every device/tag under it. This is what keeps devices
//    nobody currently has open "steady": not live, but never stale for more
//    than ~15 minutes.
//
// 2. On-demand single-device poll (called directly from the browser): a GET
//    with ?device_id=<connectionId>::<rawDeviceId>. Polls just that one
//    device, right now, with higher concurrency since it isn't competing
//    with 10 other devices for the same rate-limit budget. The frontend
//    calls this the moment someone opens a device's tag view, and every ~15s
//    afterwards while they stay on it, so the device they're actually
//    looking at feels live. Closing that view stops the on-demand polling
//    and the device goes back to just the background sweep.
//
// Concurrency is intentionally modest on the background sweep (a handful of
// requests in flight at once, not dozens): Corvina's own API rate-limits us
// with HTTP 429 when we hammer it too hard, and a 429'd request is silently
// skipped for that cycle. A 429 is retried a couple of times with a short
// backoff before giving up. Splitting "background steady" from "on-demand
// live" is what actually fixes the rate limiting -- previously every cycle
// tried to pull ALL devices' tags at once regardless of whether anyone was
// watching, which is what kept tripping Corvina's limiter.
//
// Device/tag ids are namespaced with the connection's id ("<connId>::...")
// so two different organizations' devices never collide, even if Corvina
// reuses the same raw device id across accounts.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// How many Corvina API calls we allow in flight at once, and across how
// many devices at once, during the background sweep. Kept low on purpose --
// see note above.
const TAG_FETCH_CONCURRENCY = 4;
const DEVICE_CONCURRENCY = 2;
const MAX_RETRIES_ON_RATE_LIMIT = 3;

// The on-demand path only ever polls one device at a time, so it can afford
// a bit more concurrency without tripping Corvina's limiter.
const ON_DEMAND_TAG_CONCURRENCY = 6;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function corvinaHeaders(conn) {
  return { "X-Api-Key": conn.api_key };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function corvinaGet(conn, path, params) {
  const url = new URL(conn.api_base_url + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt <= MAX_RETRIES_ON_RATE_LIMIT; attempt++) {
    const res = await fetch(url, { headers: corvinaHeaders(conn) });
    if (res.status === 429) {
      if (attempt === MAX_RETRIES_ON_RATE_LIMIT) {
        throw new Error("Corvina " + path + " -> HTTP 429 (rate limited, out of retries)");
      }
      await sleep(300 * (attempt + 1) + Math.floor(Math.random() * 200));
      continue;
    }
    if (!res.ok) {
      throw new Error("Corvina " + path + " -> HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    }
    return res.json();
  }
}

// Runs fn(item) over items with at most `limit` calls in flight at once.
async function mapWithConcurrency(items, limit, fn) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        await fn(items[current], current);
      } catch (_err) {
        // individual item failures are handled/logged by fn itself
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

async function listDevices(conn) {
  const data = await corvinaGet(conn, "/svc/mappings/api/v1/devices", {
    organization: conn.org_resource_id,
    page: 0,
    pageSize: 100,
  });
  return Array.isArray(data) ? data : data.data || data.content || data.items || [];
}

async function listTags(conn, device) {
  if (!device.presetId) throw new Error("Device " + (device.label || device.deviceId) + " has no presetId.");
  const data = await corvinaGet(conn, "/svc/mappings/api/v1/presets/" + device.presetId, {});
  const properties = data?.value?.json?.properties || {};
  return Object.entries(properties).map(([path, def]) => ({
    path,
    type: def.type || "string",
    label: def.label || null,
    unit: def.unit || null,
  }));
}

async function getLatestValue(conn, rawDeviceId, deviceName, tagPath) {
  const modelPath = deviceName + ":1/" + tagPath;
  return corvinaGet(conn, "/svc/platform/api/v1/organizations/" + conn.org_id + "/devices/" + rawDeviceId + "/tags", {
    modelPath,
    limit: 1,
  });
}

function namespacedDeviceId(conn, rawDeviceId) {
  return conn.id + "::" + rawDeviceId;
}
function tagId(deviceId, tagPath) {
  return deviceId + "::" + tagPath;
}

function mapDataType(corvinaType) {
  if (corvinaType === "double" || corvinaType === "integer") return "number";
  if (corvinaType === "boolean") return "bool";
  return "string";
}

async function upsertDevice(device) {
  const { data: existing } = await supabase.from("devices").select("geo_lat, geo_lng").eq("id", device.id).maybeSingle();
  await supabase.from("devices").upsert({
    id: device.id,
    name: device.name,
    online: device.online,
    last_seen_at: new Date().toISOString(),
    geo_lat: device.geoLat ?? existing?.geo_lat ?? null,
    geo_lng: device.geoLng ?? existing?.geo_lng ?? null,
  });
}

async function upsertTag(tag) {
  const { data: existing } = await supabase.from("tags").select("id").eq("id", tag.id).maybeSingle();
  if (existing) {
    await supabase.from("tags").update({ source_name: tag.name, data_type: tag.dataType }).eq("id", tag.id);
  } else {
    await supabase.from("tags").insert({
      id: tag.id,
      device_id: tag.deviceId,
      source_name: tag.name,
      data_type: tag.dataType,
      display_name: tag.displayName,
      unit: tag.unit,
    });
  }
}

async function writeValue(tid, value, timestampMs) {
  const isNumeric = typeof value === "number";
  const isBool = typeof value === "boolean";
  const numeric = isNumeric ? value : null;
  const bool = isBool ? value : null;
  const text = !isNumeric && !isBool ? String(value) : null;
  const ts = new Date(timestampMs || Date.now()).toISOString();

  // Corvina often keeps returning the same last-known sample between polls
  // (the underlying device just hasn't produced a new reading yet). Skip
  // the history insert when it's the exact same reading we already have on
  // record, so tag_history only grows on a genuinely new sample instead of
  // filling up with identical duplicate rows every cycle.
  const { data: existing } = await supabase
    .from("latest_values")
    .select("updated_at, value_numeric, value_text, value_bool")
    .eq("tag_id", tid)
    .maybeSingle();

  const unchanged =
    existing &&
    existing.updated_at === ts &&
    existing.value_numeric === numeric &&
    existing.value_text === text &&
    existing.value_bool === bool;

  await supabase.from("latest_values").upsert({
    tag_id: tid, value_numeric: numeric, value_text: text, value_bool: bool, updated_at: ts,
  });

  if (!unchanged) {
    await supabase.from("tag_history").insert({
      time: ts, tag_id: tid, value_numeric: numeric, value_text: text, value_bool: bool,
    });
  }
}

async function pollOneDevice(conn, device, tagConcurrency = TAG_FETCH_CONCURRENCY) {
  const rawDeviceId = device.deviceId;
  const deviceName = device.label;
  const deviceId = namespacedDeviceId(conn, rawDeviceId);
  const tags = await listTags(conn, device);

  await mapWithConcurrency(tags, tagConcurrency, async (tag) => {
    const id = tagId(deviceId, tag.path);
    await upsertTag({
      id,
      deviceId,
      name: tag.path,
      dataType: mapDataType(tag.type),
      displayName: tag.label,
      unit: tag.unit,
    });

    try {
      const result = await getLatestValue(conn, rawDeviceId, deviceName, tag.path);
      const entry = Array.isArray(result) ? result[0] : null;
      const row = entry?.data?.[0];
      if (row && row.length >= 2) {
        const [timestampMs, value] = row;
        await writeValue(id, value, timestampMs);
      }
    } catch (err) {
      console.warn("[" + conn.name + "] Tag " + tag.path + " on " + deviceName + " failed:", err.message);
    }
  });
  return tags.length;
}

async function upsertDeviceFromCorvina(conn, device) {
  const geo = device.attributes?.geoLocation;
  const hasFix = Array.isArray(geo) && geo.length >= 2 && !(Math.abs(geo[0]) < 0.01 && Math.abs(geo[1]) < 0.01);
  await upsertDevice({
    id: namespacedDeviceId(conn, device.deviceId),
    name: device.label,
    online: !!device.connected,
    geoLat: hasFix ? geo[0] : null,
    geoLng: hasFix ? geo[1] : null,
  });
}

async function pollOnceForConnection(conn) {
  const devices = await listDevices(conn);

  await mapWithConcurrency(devices, DEVICE_CONCURRENCY, async (device) => {
    await upsertDeviceFromCorvina(conn, device);
  });

  let totalTags = 0;
  await mapWithConcurrency(devices, DEVICE_CONCURRENCY, async (device) => {
    try {
      totalTags += await pollOneDevice(conn, device);
    } catch (err) {
      console.warn("[" + conn.name + "] Skipping device " + device.label + ":", err.message);
    }
  });
  console.log("[" + new Date().toISOString() + "] [" + conn.name + "] background sweep: polled " + devices.length + " device(s), " + totalTags + " tag(s)");
}

async function pollOnce() {
  const { data: connections, error } = await supabase
    .from("corvina_connections")
    .select("id, name, api_base_url, api_key, org_id, org_resource_id")
    .eq("enabled", true);
  if (error) {
    console.error("Could not load corvina_connections:", error.message);
    return;
  }
  if (!connections || connections.length === 0) {
    console.log("No enabled Corvina connections yet -- add one from the app's Settings screen.");
    return;
  }
  await mapWithConcurrency(connections, 3, async (conn) => {
    try {
      await pollOnceForConnection(conn);
    } catch (err) {
      console.warn("[" + conn.name + "] connection failed this cycle:", err.message);
    }
  });
}

// Polls exactly one device, right now, at higher concurrency than the
// background sweep uses. namespacedId is "<connectionId>::<rawDeviceId>",
// which is exactly the `devices.id` the frontend already has in hand.
async function pollDeviceOnDemand(namespacedId) {
  const sep = namespacedId.indexOf("::");
  if (sep === -1) throw new Error("device_id must be '<connectionId>::<deviceId>'");
  const connId = namespacedId.slice(0, sep);
  const rawDeviceId = namespacedId.slice(sep + 2);

  const { data: conn, error } = await supabase
    .from("corvina_connections")
    .select("id, name, api_base_url, api_key, org_id, org_resource_id")
    .eq("id", connId)
    .eq("enabled", true)
    .maybeSingle();
  if (error || !conn) throw new Error("Unknown or disabled connection: " + connId);

  const devices = await listDevices(conn);
  const device = devices.find((d) => d.deviceId === rawDeviceId);
  if (!device) throw new Error("Device " + rawDeviceId + " not found in " + conn.name);

  await upsertDeviceFromCorvina(conn, device);
  const tagCount = await pollOneDevice(conn, device, ON_DEMAND_TAG_CONCURRENCY);
  console.log("[" + new Date().toISOString() + "] [" + conn.name + "] on-demand: " + device.label + " -> " + tagCount + " tag(s)");
  return { ok: true, device: device.label, tags: tagCount };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  try {
    const url = new URL(req.url);
    const deviceId = url.searchParams.get("device_id");
    if (deviceId) {
      const result = await pollDeviceOnDemand(deviceId);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }
    await pollOnce();
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  } catch (err) {
    console.error("Poll failed:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }
});
