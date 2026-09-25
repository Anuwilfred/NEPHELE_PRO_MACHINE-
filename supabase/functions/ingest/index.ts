// Ingestion, as a Supabase Edge Function.
//
// Polls every ENABLED row in the corvina_connections table -- each one is a
// separate Corvina Cloud organization an admin connected from the app's
// Settings screen (Devices -> add a connection). pg_cron calls this
// function every 2 minutes; each call polls every connected organization in
// a tight loop (every ~7s) for up to ~130s before returning (free-plan
// wall-clock cap is 150s). Net effect: data lands every 7-10 seconds.
//
// Device/tag ids are namespaced with the connection's id ("<connId>::...")
// so two different organizations' devices never collide, even if Corvina
// reuses the same raw device id across accounts.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const POLL_INTERVAL_MS = 7000;
const MAX_WALL_CLOCK_MS = 130000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function corvinaHeaders(conn) {
  return { "X-Api-Key": conn.api_key };
}

async function corvinaGet(conn, path, params) {
  const url = new URL(conn.api_base_url + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: corvinaHeaders(conn) });
  if (!res.ok) {
    throw new Error("Corvina " + path + " -> HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  }
  return res.json();
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

  await supabase.from("latest_values").upsert({
    tag_id: tid, value_numeric: numeric, value_text: text, value_bool: bool, updated_at: ts,
  });
  await supabase.from("tag_history").insert({
    time: ts, tag_id: tid, value_numeric: numeric, value_text: text, value_bool: bool,
  });
}

async function pollOneDevice(conn, device) {
  const rawDeviceId = device.deviceId;
  const deviceName = device.label;
  const deviceId = namespacedDeviceId(conn, rawDeviceId);
  const tags = await listTags(conn, device);

  for (const tag of tags) {
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
  }
  return tags.length;
}

async function pollOnceForConnection(conn) {
  const devices = await listDevices(conn);

  for (const device of devices) {
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

  let totalTags = 0;
  for (const device of devices) {
    try {
      totalTags += await pollOneDevice(conn, device);
    } catch (err) {
      console.warn("[" + conn.name + "] Skipping device " + device.label + ":", err.message);
    }
  }
  console.log("[" + new Date().toISOString() + "] [" + conn.name + "] polled " + devices.length + " device(s), " + totalTags + " tag(s)");
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
  for (const conn of connections) {
    try {
      await pollOnceForConnection(conn);
    } catch (err) {
      console.warn("[" + conn.name + "] connection failed this cycle:", err.message);
    }
  }
}

Deno.serve(async (_req) => {
  const deadline = Date.now() + MAX_WALL_CLOCK_MS;
  let cycles = 0;
  while (Date.now() < deadline) {
    try {
      await pollOnce();
      cycles++;
    } catch (err) {
      console.error("Poll failed:", err.message);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }
  return new Response(JSON.stringify({ ok: true, cycles }), {
    headers: { "Content-Type": "application/json" },
  });
});
