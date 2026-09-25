// Now that we have the REAL Tristar device (label="Tristar",
// deviceId=O_eufU4VukXZRIQewo30Qw, group "Tristar-UAE"), this fetches the
// devices list again (to get it dynamically rather than hardcoding the id),
// then tries the tag-value endpoint against a few of the seeded tag paths
// to confirm the modelPath format actually returns real data.

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
  const client = new CorvinaClient(config);
  const devices = await client.listDevices();
  const tristar = devices.find((d) => d.label === "Tristar");

  if (!tristar) {
    console.log("Could not find a device with label exactly 'Tristar'. Devices seen:");
    devices.forEach((d) => console.log(" -", d.label));
    return;
  }

  console.log("Found Tristar:", JSON.stringify(tristar, null, 2).slice(0, 500));
  console.log("");

  const pathsToTry = tagSeed.Tristar.slice(0, 3); // just the first 3, enough to confirm the shape
  for (const tagPath of pathsToTry) {
    console.log(`--- ${tagPath} ---`);
    try {
      const result = await client.getLatestValue(tristar.deviceId, tristar.label, tagPath);
      console.log("  OK:", JSON.stringify(result, null, 2).slice(0, 600));
    } catch (err) {
      console.log("  FAILED:", err.response?.status, JSON.stringify(err.response?.data || err.message).slice(0, 500));
    }
    console.log("");
  }
}

main();
