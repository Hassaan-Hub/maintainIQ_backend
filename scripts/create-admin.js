const path = require("path");
const dns = require("dns");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

// Atlas SRV lookups need a public resolver on some networks; mirror server.js.
dns.setServers(["1.1.1.1"]);

// Load the real .env (variable names only; values are never printed).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const User = require("../src/models/user.model");

const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Removes any credentials from an error message before it is printed.
const hideSecrets = (text) => text.replace(/\/\/([^:@/]+):([^@/]+)@/g, "//<redacted>@");

// Reads the new admin's details from CLI args or environment variables and
// creates (or promotes) that account to the admin role. No secrets are logged.
// ADMIN_DB optionally targets a different database (used for testing).
const run = async () => {
  const username = process.argv[2] || process.env.ADMIN_USERNAME;
  const email = process.argv[3] || process.env.ADMIN_EMAIL;
  const password = process.argv[4] || process.env.ADMIN_PASSWORD;

  if (!username || !email || !password) {
    console.error(
      "Usage: node scripts/create-admin.js <username> <email> <password>\n" +
        "   or: ADMIN_USERNAME=.. ADMIN_EMAIL=.. ADMIN_PASSWORD=.. node scripts/create-admin.js"
    );
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("Password must be at least 6 characters.");
    process.exit(1);
  }

  if (!EMAIL_REGEX.test(email)) {
    console.error("Please provide a valid email address.");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Add it to your .env file.");
    process.exit(1);
  }

  await mongoose.connect(uri, process.env.ADMIN_DB ? { dbName: process.env.ADMIN_DB } : {});

  const cleanUsername = username.trim();
  const cleanEmail = email.trim().toLowerCase();

  const existing = await User.findOne({
    $or: [{ username: cleanUsername }, { email: cleanEmail }],
  });

  if (existing) {
    existing.role = "admin";
    await existing.save();
    console.log(`Promoted existing account to admin: ${existing.username}`);
  } else {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const admin = await User.create({
      username: cleanUsername,
      email: cleanEmail,
      password: hashedPassword,
      role: "admin",
    });
    console.log(`Created admin account: ${admin.username}`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (error) => {
  console.error("Failed to create admin:", hideSecrets(String(error.message)));
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
