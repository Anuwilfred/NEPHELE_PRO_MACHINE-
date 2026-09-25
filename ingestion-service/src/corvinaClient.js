// Talks to Corvina Cloud.
//
// Unlike the first version of this file, these endpoint shapes are no
// longer a guess -- they were captured directly from Corvina's own web app
// (exorin.app.corvina.io) while it was loaded and logged in, by watching
// its network requests. Two things are still assumptions, flagged below,
// because reading the actual response bodies wasn't possible without
// pulling the session's auth token out of browser storage, which the
// browser tooling correctly refuses to do (tokens are credentials).
//
// CONFIRMED:
//   Devices list  : GET {base}/svc/mappings/api/v1/devices
//                       ?organization={orgResourceId}&page=0&pageSize=100
//   Tag value/history:
//                   GET {base}/svc/platform/api/v1/organizations/{orgId}/devices/{deviceId}/tags
//                       ?modelPath={deviceName}:1/{tagPath}&limit=1                (latest)
//                       ?modelPath={deviceName}:1/{tagPath}&limit=1000&since=..&to=..  (history)
//   Two separate org identifiers are both needed:
//     orgResourceId - a string like "exorin.technologyventure" (used as a query param)
//     orgId         - a numeric id like "329738"                (used in the URL path)
//
// CONFIRMED (2026-09-25, real run against the account):
//   - The API key works as X-Api-Key directly -- no 401/403, no token
//     exchange needed.
//   - The devices-list response is a page object, but the array of devices
//     is under a field literally called "data" (i.e. { number, data: [...] }),
//     NOT "content" or "items" like the first guess assumed. That's why
//     earlier runs reported "0 devices" -- the API was returning real
//     devices all along, the parsing just didn't know where to find them.
//   - A device object's fields (from a real example):
//       deviceId, label (this is the display name), groups (array),
//       modelName, modelId, connected, isGateway, deleted,
//       configurationApplied, attributes: { vpn_connected, alarms, ... }
//     There is no "name" field -- always use "label".
//   - The Tristar device: label="Tristar", group "Tristar-UAE".
//   - Tag value/history response shape (confirmed against real Tristar
//     tags): an array with ONE entry:
//       [{ deviceId, modelPath, types: ["datetime", "<double|integer>"],
//          header: ["timestamp", "value"],
//          data: [[epochMs, value], ...] }]
//     `data` holds the actual points as [timestamp, value] pairs (NOT
//     {value, timestamp} objects like the first guess assumed). With
//     limit:1 there's just one pair; with a history call there are many,
//     in `data`.
//
// CONFIRMED (2026-09-25): the "list every tag for a device" endpoint IS
// findable -- it just isn't under /devices. Every device object has a
// "presetId" field (e.g. Tristar's is "gyMbYgl39h"). That id is fetched as:
//   GET {base}/svc/mappings/api/v1/presets/{presetId}
// The response's real tag list is buried at response.value.json.properties
// -- a FLAT object whose keys are already full paths like
// "Application/DCDC/DC1301_st_dcu_p" (not nested -- the slashes are part
// of the literal key, no need to walk/join anything). Each entry has
// { type, mode, label, unit, datalink: { source } }. For Tristar this
// returned all 63 real tags (tagSeed.js only ever had 18, hand-copied from
// one screenful of Corvina's Explore screen -- that file is now obsolete,
// listTags() below replaces it).
//
// "Tristar" is a device label in its own right (group "Tristar-UAE"), not
// just a name for a group of other devices.

const axios = require("axios");

class CorvinaClient {
  constructor(config) {
    this.config = config;
    this.http = axios.create({ baseURL: config.apiBaseUrl, timeout: 10_000 });
  }

  _authHeaders() {
    // AUTH_MODE=apiKey is the only mode this project uses (a personal API
    // key generated from IAM > Users > API Keys). See the ASSUMED note
    // above about whether this header is accepted as-is.
    return { "X-Api-Key": this.config.apiKey };
  }

  async listDevices() {
    const headers = this._authHeaders();
    const { data } = await this.http.get("/svc/mappings/api/v1/devices", {
      headers,
      params: {
        organization: this.config.orgResourceId,
        page: 0,
        pageSize: 100,
      },
    });
    // CONFIRMED: the array is at data.data (a page object shaped like
    // { number: 0, data: [...] }). content/items are kept as fallbacks in
    // case a different account/endpoint version ever shapes it differently.
    return Array.isArray(data) ? data : data.data || data.content || data.items || [];
  }

  // Every real tag for a device, discovered from Corvina itself -- no
  // hand-maintained list needed. `device` is one entry from listDevices()
  // (must have .presetId). Returns [{ path, type, label, unit }, ...].
  async listTags(device) {
    if (!device.presetId) {
      throw new Error(`Device ${device.label || device.deviceId} has no presetId.`);
    }
    const headers = this._authHeaders();
    const { data } = await this.http.get(
      `/svc/mappings/api/v1/presets/${device.presetId}`,
      { headers }
    );
    const properties = data?.value?.json?.properties || {};
    return Object.entries(properties).map(([path, def]) => ({
      path,
      type: def.type || "string",
      label: def.label || null,
      unit: def.unit || null,
    }));
  }

  // Latest single value for one tag.
  async getLatestValue(deviceId, deviceName, tagPath) {
    return this._getTagValues(deviceId, deviceName, tagPath, { limit: 1 });
  }

  // History for one tag between two ISO timestamps.
  // NOTE: in the captured traffic, `since` was the MORE RECENT timestamp
  // and `to` was the OLDER one (i.e. reversed from what the names suggest)
  // -- confirm this before trusting a wide date range.
  async getHistory(deviceId, deviceName, tagPath, sinceISO, toISO) {
    return this._getTagValues(deviceId, deviceName, tagPath, {
      limit: 1000,
      since: sinceISO,
      to: toISO,
    });
  }

  async _getTagValues(deviceId, deviceName, tagPath, extraParams) {
    const headers = this._authHeaders();
    const modelPath = `${deviceName}:1/${tagPath}`;
    const { data } = await this.http.get(
      `/svc/platform/api/v1/organizations/${this.config.orgId}/devices/${deviceId}/tags`,
      { headers, params: { modelPath, ...extraParams } }
    );
    return data;
  }
}

module.exports = { CorvinaClient };
