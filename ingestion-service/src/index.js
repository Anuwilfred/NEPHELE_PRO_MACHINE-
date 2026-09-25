require("dotenv").config();
const { CorvinaClient } = require("./corvinaClient");
const { upsertDevice, upsertTag, writeValue } = require("./db");

const config = {
  apiBaseUrl: process.env.CORVINA_API_BASE_URL,
  apiKey: process.env.CORVINA_API_KEY,
  orgId: process.env.CORVINA_ORG_ID,
  orgResourceId: process.env.CORVINA_ORG_RESOURCE_ID,
};

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 5000);

// Which devices to poll TAG VALUES for, matched by Corvina's device
// "label". Empty array = every device Corvina returns. Every device is
// always recorded (for the Devices tile view / online status) regardless
// of this list -- this only controls which ones we also pull live tag
// data for. Narrow it back down (e.g. ["Tristar"]) if polling everything
// turns out to be too slow or noisy.
const MONITORED_DEVICE_LABELS = [];

const client = new CorvinaClient(config);

const knownTags = new Set();
// deviceId -> [{ path, type, label, unit }]. A device's tag model rarely
// changes, so this is fetched once per process rather than every poll;
// restart the service to pick up a model change.
const deviceTagsCache = new Map();

// A tag has no confirmed opaque id of its own (see corvinaClient.js), so
// build a stable one from the device id + its path.
function tagId(deviceId, tagPath) {
  return `${deviceId}::${tagPath}`;
}

function mapDataType(corvinaType) {
  if (corvinaType === "double" || corvinaType === "integer") return "number";
  if (corvinaType === "boolean") return "bool";
  return "string";
}

async function pollOneDevice(device) {
  const deviceId = device.deviceId;
  const deviceName = device.label;

  if (!deviceTagsCache.has(deviceId)) {
    const tags = await client.listTags(device);
    deviceTagsCache.set(deviceId, tags);
    console.log(`Discovered ${tags.length} tag(s) for ${deviceName}.`);
  }
  const tags = deviceTagsCache.get(deviceId);

  for (const tag of tags) {
    const id = tagId(deviceId, tag.path);
    if (!knownTags.has(id)) {
      await upsertTag({
        id,
        deviceId,
        name: tag.path,
        dataType: mapDataType(tag.type),
        displayName: tag.label,
        unit: tag.unit,
      });
      knownTags.add(id);
    }

    try {
      const result = await client.getLatestValue(deviceId, deviceName, tag.path);
      // CONFIRMED (2026-09-25, real run against Tristar): the response is
      // an array with one entry shaped like:
      //   { deviceId, modelPath, types: ["datetime", "<double|integer>"],
      //     header: ["timestamp", "value"], data: [[epochMs, value], ...] }
      // `data` is the list of points (with limit:1, just the latest one).
      const entry = Array.isArray(result) ? result[0] : null;
      const row = entry?.data?.[0];
      if (row && row.length >= 2) {
        const [timestampMs, value] = row;
        await writeValue(id, value, timestampMs);
      } else {
        console.warn(`Unexpected shape for ${tag.path}:`, JSON.stringify(result).slice(0, 300));
      }
    } catch (err) {
      // One bad tag shouldn't stop the rest of this device's tags.
      console.warn(`  Tag ${tag.path} on ${deviceName} failed:`, err.response?.status || err.message);
    }
  }

  return tags.length;
}

async function pollOnce() {
  const devices = await client.listDevices();

  // Every device is recorded regardless of MONITORED_DEVICE_LABELS, so the
  // Devices tile view always shows true online/offline status for all of
  // them, even ones we don't pull tag values for.
  for (const device of devices) {
    // geoLocation, when Corvina has it, comes as [lat, lng] on the
    // device's own attributes -- no separate GPS tag needed for the map.
    // CONFIRMED (2026-09-25): a device that has never gotten a GPS fix
    // reports [0, 0] here rather than leaving the field empty -- that's
    // "Null Island" in the Gulf of Guinea, not a real position, so it's
    // treated the same as "no fix" instead of being stored/plotted.
    const geo = device.attributes?.geoLocation;
    const hasFix =
      Array.isArray(geo) &&
      geo.length >= 2 &&
      !(Math.abs(geo[0]) < 0.01 && Math.abs(geo[1]) < 0.01);
    await upsertDevice({
      id: device.deviceId,
      name: device.label,
      online: device.connected,
      geoLat: hasFix ? geo[0] : null,
      geoLng: hasFix ? geo[1] : null,
    });
  }

  const targets =
    MONITORED_DEVICE_LABELS.length === 0
      ? devices
      : devices.filter((d) => MONITORED_DEVICE_LABELS.includes(d.label));

  let totalTags = 0;
  let devicesOk = 0;

  for (const device of targets) {
    try {
      totalTags += await pollOneDevice(device);
      devicesOk++;
    } catch (err) {
      // A device with no presetId, or a transient error, shouldn't stop
      // the rest of the fleet from being polled.
      console.warn(`Skipping device ${device.label}:`, err.response?.status || err.message);
    }
  }

  console.log(
    `[${new Date().toISOString()}] polled ${devicesOk}/${targets.length} device(s), ${totalTags} tag(s)`
  );
}

async function main() {
  console.log("Ingestion service starting. Poll interval:", pollIntervalMs, "ms");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      console.error(
        "Poll failed:",
        status ? `HTTP ${status}` : err.message,
        body ? JSON.stringify(body).slice(0, 300) : ""
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

main();
