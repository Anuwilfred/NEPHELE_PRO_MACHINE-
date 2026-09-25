// Ingestion, as a Supabase Edge Function.
//
// Replaces the old ingestion-service (a Node process that polled Corvina
// forever in a while(true) loop). An Edge Function can't run forever -- the
// free plan caps one invocation at 150 seconds of wall-clock time -- so
// instead: pg_cron calls this function every 2 minutes, and each call polls
// Corvina in a tight loop (every ~7s) for up to ~130s before returning,
// leaving a safety margin under the 150s cutoff. Net effect: data lands
// every 7-10 seconds, with only the last ~10-20s of each 2-minute window
// where nothing is happening. Close enough to real-time for a vessel
// dashboard, and genuinely free (no server of ours has to stay on).
//
// One difference from the old version worth knowing: the old process kept
// each device's tag list (deviceTagsCache) in memory for its whole life, so
// it only fetched a device's tag model once. An Edge Function invocation
// doesn't persist that between calls, so this fetches each device's preset
// (its tag list) once per 2-minute cycle instead of once ever. That's one
// extra HTTP call per device per cycle -- harmless at the scale this runs
// at, but if you ever have dozens of devices and it feels slow, that's why.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORVINA_API_BASE_URL = Deno.env.get("CORVINA_API_BASE_URL")!;
const CORVINA_API_KEY = Deno.env.get("CORVINA_API_KEY")!;
const CORVINA_ORG_ID = Deno.env.get("CORVINA_ORG_ID")!;
const CORVINA_ORG_RESOURCE_ID = Deno.env.get("CORVINA_ORG_RESOURCE_ID")!;

// Auto-provided to every Edge Function -- no need to set these yourself.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const POLL_INTERVAL_MS = 7_000;
const MAX_WALL_CLOCK_MS = 130_000; // stay under the 150s free-plan limit

// Narrow this to specific device labels (e.g. ["Tristar"]) if polling every
// device turns out to be too slow/noisy. Empty = poll tag values for all of
// them (every device is always recorded for online/offline status either way).
const MONITORED_DEVICE_LABELS: string[] = [];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function corvinaHeaders() {
  return { "X-Api-Key": CORVINA_API_KEY };
}

async function corvinaGet(path: string, params: Record<string, string | number>) {
  const url = new URL(CORVINA_API_BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: corvinaHeaders() });
  if (!res.ok) {
    throw new Error(`Corvina ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function listDevices() {
  const data = await corvinaGet("/svc/mappings/api/v1/devices", {
    organization: CORVINA_ORG_RESOURCE_ID,
    page: 0,
    pageSize: 100,
  });
  return Array.isArray(data) ? data : data.data || data.content || data.items || [];
}

async function listTags(device: any) {
  if (!device.presetId) throw new Error(`Device ${device.label || device.deviceId} has no presetId.`);
  const data = await corvinaGet(`/svc/mappings/api/v1/presets/${device.presetId}`, {});
  const properties = data?.value?.json?.properties || {};
  return Object.entries(properties).map(([path, def]: [string, any]) => ({
    path,
    type: def.type || "string",
    label: def.label || null,
    unit: def.unit || null,
  }));
}

async function getLatestValue(deviceId: string, deviceName: string, tagPath: string) {
  const modelPath = `${deviceName}:1/${tagPath}`;
  return corvinaGet(`/svc/platform/api/v1/organizations/${CORVINA_ORG_ID}/devices/${deviceId}/tags`, {
    modelPath,
    limit: 1,
  });
}

function tagId(deviceId: string, tagPath: string) {
  return `${deviceId}::${tagPath}`;
}

function mapDataType(corvinaType: string) {
  if (corvinaType === "double" || corvinaType === "integer") return "number";
  if (corvinaType === "boolean") return "bool";
  return "string";
}

async function upsertDevice(device: {
  id: string; name: string; online: boolean; geoLat: number | null; geoLng: number | null;
}) {
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

async function upsertTag(tag: {
  id: string; deviceId: string; name: string; dataType: string; displayName: string | null; unit: string | null;
}) {
  // Only set display_name/unit on first insert -- edits made in the Tag
  // Management screen must never be overwritten by a later poll. Emulated
  // here (no native "on conflict do nothing for these columns" in a single
  // upsert) by checking existence first.
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

async function writeValue(tid: string, value: unknown, timestampMs: number) {
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

async function pollOneDevice(device: any) {
  const deviceId = device.deviceId;
  const deviceName = device.label;
  const tags = await listTags(device);

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
      const result = await getLatestValue(deviceId, deviceName, tag.path);
      const entry = Array.isArray(result) ? result[0] : null;
      const row = entry?.data?.[0];
      if (row && row.length >= 2) {
        const [timestampMs, value] = row;
        await writeValue(id, value, timestampMs);
      }
    } catch (err) {
      console.warn(`Tag ${tag.path} on ${deviceName} failed:`, (err as Error).message);
    }
  }
  return tags.length;
}

async function pollOnce() {
  const devices = await listDevices();

  for (const device of devices) {
    // See ingestion-service/src/index.js history: Corvina reports [0, 0]
    // for a device with no GPS fix yet -- treated as "no position", not a
    // real spot in the Gulf of Guinea ("Null Island").
    const geo = device.attributes?.geoLocation;
    const hasFix = Array.isArray(geo) && geo.length >= 2 && !(Math.abs(geo[0]) < 0.01 && Math.abs(geo[1]) < 0.01);
    await upsertDevice({
      id: device.deviceId,
      name: device.label,
      online: !!device.connected,
      geoLat: hasFix ? geo[0] : null,
      geoLng: hasFix ? geo[1] : null,
    });
  }

  const targets = MONITORED_DEVICE_LABELS.length === 0
    ? devices
    : devices.filter((d: any) => MONITORED_DEVICE_LABELS.includes(d.label));

  let totalTags = 0;
  for (const device of targets) {
    try {
      totalTags += await pollOneDevice(device);
    } catch (err) {
      console.warn(`Skipping device ${device.label}:`, (err as Error).message);
    }
  }
  console.log(`[${new Date().toISOString()}] polled ${targets.length} device(s), ${totalTags} tag(s)`);
}

Deno.serve(async (_req) => {
  const deadline = Date.now() + MAX_WALL_CLOCK_MS;
  let cycles = 0;
  while (Date.now() < deadline) {
    try {
      await pollOnce();
      cycles++;
    } catch (err) {
      console.error("Poll failed:", (err as Error).message);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }
  return new Response(JSON.stringify({ ok: true, cycles }), {
    headers: { "Content-Type": "application/json" },
  });
});
