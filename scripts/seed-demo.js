const path = require("path");
const dns = require("dns");
const mongoose = require("mongoose");

// Atlas SRV lookups need a public resolver on some networks; mirror server.js.
dns.setServers(["1.1.1.1"]);

// Load the real .env (variable names only; values are never printed).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Asset = require("../src/models/asset.model");
const User = require("../src/models/user.model");

// Removes any credentials from an error message before it is printed.
const hideSecrets = (text) => text.replace(/\/\/([^:@/]+):([^@/]+)@/g, "//<redacted>@");

// The demo assets seeded by this script. Every code starts with "DEMO-" so the
// script can find and update exactly its own records without ever touching
// real (non-demo) asset data. Codes are stable so re-runs are idempotent.
const DEMO_ASSETS = [
  {
    assetCode: "DEMO-AC-001",
    name: "Rooftop Air Handler 1",
    category: "HVAC",
    location: "Building A - Roof",
    description: "Primary rooftop air handler serving the east wing.",
    status: "active",
  },
  {
    assetCode: "DEMO-AC-002",
    name: "Office Split Unit 204",
    category: "HVAC",
    location: "Building A - Floor 2",
    description: "Wall-mounted split unit in the open-plan office.",
    status: "maintenance",
  },
  {
    assetCode: "DEMO-EL-001",
    name: "Main Distribution Panel",
    category: "Electrical",
    location: "Building A - Basement",
    description: "Low-voltage main distribution board for the building.",
    status: "active",
  },
  {
    assetCode: "DEMO-EL-002",
    name: "Emergency Lighting Bank",
    category: "Electrical",
    location: "Building B - Stairwell",
    description: "Battery-backed emergency lighting for the stairwell.",
    status: "retired",
  },
  {
    assetCode: "DEMO-PL-001",
    name: "Domestic Water Pump",
    category: "Plumbing",
    location: "Building B - Plant Room",
    description: "Booster pump for the domestic cold-water supply.",
    status: "active",
  },
  {
    assetCode: "DEMO-PL-002",
    name: "Cooling Tower Pump",
    category: "Plumbing",
    location: "Building A - Plant Room",
    description: "Circulation pump for the cooling tower loop.",
    status: "maintenance",
  },
  {
    assetCode: "DEMO-FS-001",
    name: "Fire Sprinkler Valve Set",
    category: "Fire Safety",
    location: "Building A - Floor 1",
    description: "Zone control valve set for the sprinkler system.",
    status: "active",
  },
  {
    assetCode: "DEMO-FS-002",
    name: "Smoke Detector Network",
    category: "Fire Safety",
    location: "Building B - All Floors",
    description: "Addressable smoke detection network and panel.",
    status: "active",
  },
  {
    assetCode: "DEMO-LF-001",
    name: "Passenger Lift 1",
    category: "Elevator",
    location: "Building A - Core",
    description: "Eight-person passenger lift serving floors 1-4.",
    status: "active",
  },
  {
    assetCode: "DEMO-SE-001",
    name: "Perimeter CCTV Camera",
    category: "Security",
    location: "Building A - Entrance",
    description: "Front-entrance IP camera recording to the NVR.",
    status: "active",
  },
];

// Seeds (or refreshes) the demo assets. Requires an existing admin so the
// demo records have a valid creator and reflect a realistic setup. Upserts by
// assetCode so the script can be run repeatedly without creating duplicates,
// and only ever writes records whose code starts with "DEMO-".
const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Add it to your .env file.");
    process.exit(1);
  }

  // SEED_DEMO_DB optionally targets a different database (used for testing, so
  // the demo data never lands in the developer's real database).
  const dbName = process.env.SEED_DEMO_DB;
  await mongoose.connect(uri, dbName ? { dbName } : {});

  const admin = await User.findOne({ role: "admin" }).select("_id username");
  if (!admin) {
    console.log(
      "No admin account found, so no demo data was written.\n" +
        "Create one first, then run this again:\n" +
        "  npm run create-admin -- <username> <email> <password>"
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  let created = 0;
  let updated = 0;

  for (const demo of DEMO_ASSETS) {
    const existing = await Asset.findOne({ assetCode: demo.assetCode });

    if (existing) {
      // Refresh the demo fields but leave createdBy (and any image) untouched.
      existing.name = demo.name;
      existing.category = demo.category;
      existing.location = demo.location;
      existing.description = demo.description;
      existing.status = demo.status;
      await existing.save();
      updated += 1;
    } else {
      await Asset.create({ ...demo, createdBy: admin._id });
      created += 1;
    }
  }

  console.log(
    `Demo seed complete: ${created} created, ${updated} updated ` +
      `(${DEMO_ASSETS.length} DEMO- assets total).`
  );

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (error) => {
  console.error("Failed to seed demo data:", hideSecrets(String(error.message)));
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
