// While you had Corvina's own "Data > Explore" screen open and expanded
// Tristar, the browser made a request to:
//   GET /svc/mappings/api/v1/presets/gyMbYgl39h
// This is very likely the REAL "list every tag for a device" endpoint we
// never had confirmed before (tagSeed.js was a hand-copied stand-in).
// This script tries fetching that preset directly with the API key, to
// see its full structure and every tag path it contains.

require("dotenv").config();
const fs = require("fs");
const axios = require("axios");

const apiBaseUrl = process.env.CORVINA_API_BASE_URL;
const apiKey = process.env.CORVINA_API_KEY;

const PRESET_ID = "gyMbYgl39h"; // seen while Tristar was expanded in Explore

async function main() {
  const http = axios.create({ baseURL: apiBaseUrl, timeout: 10_000 });
  const headers = { "X-Api-Key": apiKey };

  console.log(`Fetching /svc/mappings/api/v1/presets/${PRESET_ID} ...`);
  try {
    const { data } = await http.get(`/svc/mappings/api/v1/presets/${PRESET_ID}`, { headers });
    fs.writeFileSync("preset-full.json", JSON.stringify(data, null, 2));
    console.log("HTTP 200. Saved full response to preset-full.json (in this same folder).");

    // Also print a flat list of every leaf tag path, so we can see the
    // scope right away without scrolling a huge nested JSON dump.
    const paths = [];
    function walk(node, prefix) {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object" && "type" in value && "mode" in value) {
          paths.push(prefix ? `${prefix}/${key}` : key);
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
          walk(value, prefix ? `${prefix}/${key}` : key);
        }
      }
    }
    walk(data, "");
    console.log(`\nFound ${paths.length} leaf tag(s):`);
    paths.forEach((p) => console.log(" -", p));
  } catch (err) {
    console.log("FAILED:", err.response?.status, JSON.stringify(err.response?.data || err.message).slice(0, 500));
  }
}

main();
