// Diagnostic: the main test showed the API key is VALID (no 401/403), but
// the devices list came back empty (0 devices). That almost always means
// the "organization" query parameter isn't matching what Corvina expects.
// This script tries several parameter variations against the same endpoint
// and prints the raw response for each, so we can see which one (if any)
// actually returns devices, instead of guessing one at a time.

require("dotenv").config();
const axios = require("axios");

const apiBaseUrl = process.env.CORVINA_API_BASE_URL;
const apiKey = process.env.CORVINA_API_KEY;
const orgId = process.env.CORVINA_ORG_ID;
const orgResourceId = process.env.CORVINA_ORG_RESOURCE_ID;

const http = axios.create({ baseURL: apiBaseUrl, timeout: 10_000 });
const headers = { "X-Api-Key": apiKey };

const attempts = [
  { label: "organization=<orgResourceId>", params: { organization: orgResourceId, page: 0, pageSize: 100 } },
  { label: "organization=<orgId numeric>", params: { organization: orgId, page: 0, pageSize: 100 } },
  { label: "organizationId=<orgId numeric>", params: { organizationId: orgId, page: 0, pageSize: 100 } },
  { label: "orgId=<orgId numeric>", params: { orgId: orgId, page: 0, pageSize: 100 } },
  { label: "no organization param at all", params: { page: 0, pageSize: 100 } },
  { label: "organization=<orgResourceId>, bigger pageSize, no page", params: { organization: orgResourceId, pageSize: 500 } },
];

async function tryOne(attempt) {
  console.log(`\n--- ${attempt.label} ---`);
  console.log("  params:", JSON.stringify(attempt.params));
  try {
    const res = await http.get("/svc/mappings/api/v1/devices", { headers, params: attempt.params });
    const data = res.data;
    const list = Array.isArray(data) ? data : data.content || data.items || null;
    console.log("  HTTP", res.status);
    if (list) {
      console.log(`  -> ${list.length} device(s)`);
      if (list.length > 0) {
        console.log("  First device raw:", JSON.stringify(list[0], null, 2).slice(0, 800));
      }
    } else {
      console.log("  Raw body (not a recognized list shape):", JSON.stringify(data, null, 2).slice(0, 800));
    }
    // Always show total-count-ish fields if present, they help even when list is empty.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const { content, items, ...rest } = data;
      console.log("  Other top-level fields:", JSON.stringify(rest).slice(0, 300));
    }
  } catch (err) {
    console.log("  FAILED:", err.response?.status, JSON.stringify(err.response?.data || err.message).slice(0, 500));
  }
}

async function main() {
  console.log("Config -- orgId:", orgId, " orgResourceId:", orgResourceId);
  for (const attempt of attempts) {
    await tryOne(attempt);
  }
  console.log("\nDone. Paste this whole output back.");
}

main();
