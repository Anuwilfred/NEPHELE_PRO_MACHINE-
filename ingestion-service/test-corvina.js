// Standalone connectivity test -- no Docker, no Postgres, no docker-compose.
// Just: does this API key correctly pull real data from Corvina?
//
// Run directly with Node.js on your own PC (needs Node installed, and
// `npm install` run once in this folder):
//
//   node test-corvina.js
//
require("dotenv").config();
const { CorvinaClient } = require("./src/corvinaClient");
const tagSeed = require("./src/tagSeed");

const config = {
  apiBaseUrl: process.env.CORVINA_API_BASE_URL,
  apiKey: process.env.CORVINA_API_KEY,
  orgId: process.env.CORVINA_ORG_ID,
  orgResourceId: process.env.CORVINA_ORG_RESOURCE_ID,
};

async function main() {
  console.log("Testing Corvina connection...");
  console.log("  Base URL:", config.apiBaseUrl);
  console.log("  Org ID:", config.orgId, " Org resource ID:", config.orgResourceId);
  console.log("");

  const client = new CorvinaClient(config);

  console.log("Step 1: listing devices...");
  let devices;
  try {
    devices = await client.listDevices();
    console.log(`  OK -- got ${devices.length} device(s).`);
    console.log(
      "  Names:",
      devices.map((d) => d.name || d.label || d.id || d.deviceId)
    );
  } catch (err) {
    console.error("  FAILED:", err.response?.status, err.response?.data || err.message);
    console.error("\nStopping here -- fix this before testing tag values.");
    return;
  }

  console.log("");
  console.log("Step 2: fetching one tag's latest value for Tristar...");
  const tristar = devices.find((d) => (d.name || d.label) === "Tristar");
  if (!tristar) {
    console.warn("  Couldn't find a device named exactly 'Tristar' in the list above.");
    console.warn("  Check the 'Names' printed in Step 1 and adjust tagSeed.js if needed.");
    return;
  }
  const deviceId = tristar.deviceId || tristar.id;
  const tagPath = tagSeed.Tristar[0];
  try {
    const result = await client.getLatestValue(deviceId, "Tristar", tagPath);
    console.log(`  OK -- response for ${tagPath}:`);
    console.log(JSON.stringify(result, null, 2).slice(0, 1000));
  } catch (err) {
    console.error("  FAILED:", err.response?.status, err.response?.data || err.message);
  }
}

main();
