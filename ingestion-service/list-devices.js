// Now that we know the devices list DOES return real data (it was a
// parsing bug, not an empty account), this prints every device's label and
// groups so we can see how "Tristar" actually shows up -- as a device name
// itself, or as the vessel/grouping that owns several per-subsystem devices
// like DMC_Grid_Converter01.

require("dotenv").config();
const { CorvinaClient } = require("./src/corvinaClient");

const config = {
  apiBaseUrl: process.env.CORVINA_API_BASE_URL,
  apiKey: process.env.CORVINA_API_KEY,
  orgId: process.env.CORVINA_ORG_ID,
  orgResourceId: process.env.CORVINA_ORG_RESOURCE_ID,
};

async function main() {
  const client = new CorvinaClient(config);
  const devices = await client.listDevices();
  console.log(`Got ${devices.length} device(s) total.\n`);

  devices.forEach((d, i) => {
    console.log(
      `${i + 1}. label="${d.label}"  deviceId=${d.deviceId}  groups=${JSON.stringify(d.groups)}  connected=${d.connected}  modelName=${d.modelName}`
    );
  });

  const needle = "tristar";
  const matches = devices.filter((d) => {
    const haystack = JSON.stringify(d).toLowerCase();
    return haystack.includes(needle);
  });
  console.log(`\nDevices mentioning "Tristar" anywhere in their data: ${matches.length}`);
  matches.forEach((d) => console.log("  ->", d.label, d.deviceId));

  if (devices.length > 0) {
    console.log("\n--- Trying a tag fetch against the first device, to confirm the tags endpoint shape too ---");
    const first = devices[0];
    // We don't know this device's real tag paths, so this is just to see
    // what kind of response/error we get -- 200 with data, or 404/400
    // telling us the modelPath format needs adjusting for this device.
    try {
      const result = await client.getLatestValue(first.deviceId, first.label, "Application/test");
      console.log("Tag call result:", JSON.stringify(result, null, 2).slice(0, 500));
    } catch (err) {
      console.log("Tag call failed (expected if the path is wrong):", err.response?.status, JSON.stringify(err.response?.data || err.message).slice(0, 500));
    }
  }
}

main();
