// The preset "gyMbYgl39h" clearly IS Tristar's tag model (its response
// even says "name": "Hybrid" and lists Application/STBD/... tags).
// To fetch this automatically (not hand-typed) for Tristar -- and any
// other device later -- we need to know which field on the DEVICE object
// actually equals "gyMbYgl39h". This prints Tristar's full device record
// so we can find that field.

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
  const tristar = devices.find((d) => d.label === "Tristar");
  if (!tristar) {
    console.log("Tristar not found.");
    return;
  }
  console.log("Full Tristar device record:");
  console.log(JSON.stringify(tristar, null, 2));
}

main();
