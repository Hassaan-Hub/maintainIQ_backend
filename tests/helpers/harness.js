const dns = require("dns");
const path = require("path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

// Atlas SRV lookups need a public resolver on some networks; mirror server.js.
dns.setServers(["1.1.1.1"]);

// Load the real .env (variable names only; values are never printed).
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

// Raise the auth rate-limit ceiling before the app (and its limiter) is loaded
// so the suite's own login/register traffic is not throttled.
require("../setup-env");

const app = require("../../src/app");
const User = require("../../src/models/user.model");
const Asset = require("../../src/models/asset.model");
const MaintenanceRequest = require("../../src/models/maintenance-request.model");

// Every test run gets its own prefix so records are easy to find and remove.
const RUN_ID = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let counter = 0;

// Connects the default mongoose connection to an isolated test database so the
// developer's real data is never touched.
const connectTestDatabase = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set; tests need a database connection.");
  }
  const dbName = process.env.MONGO_TEST_DB || "maintainiq_test";
  await mongoose.connect(uri, { dbName });
};

// Disconnects the test database connection.
const disconnectTestDatabase = async () => {
  await mongoose.disconnect();
};

// Starts the Express app on an ephemeral port and returns { server, base }.
const startTestServer = async () => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
};

// Closes the test server.
const stopTestServer = async (server) => {
  await new Promise((resolve) => server.close(resolve));
};

// Returns the next unique suffix for generated test records.
const nextId = () => {
  counter += 1;
  return `${RUN_ID}_${counter}`;
};

// Produces unique, safe test credentials for a new record.
const makeIdentity = () => {
  const id = nextId();
  return {
    id,
    username: `t${id}`,
    email: `t${id}@example.test`,
    password: "Passw0rd!test",
  };
};

// Creates a user directly in the database (any role) and returns it. Used to
// bootstrap the first admin/technician, since public registration is "user".
const createUserDirect = async (role = "user") => {
  const identity = makeIdentity();
  const password = await bcrypt.hash(identity.password, 10);
  const user = await User.create({
    username: identity.username,
    email: identity.email,
    password,
    role,
  });
  return { user, credentials: identity };
};

// Makes a small JSON HTTP request against the running test server.
const request = async (base, method, routePath, { cookie, body } = {}) => {
  const headers = {};
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(base + routePath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch (_) {
    json = null;
  }
  return { status: response.status, json };
};

// Extracts the auth cookie string from a login/register response.
const cookieFrom = (response) => {
  const cookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return cookies.map((value) => value.split(";")[0]).join("; ");
};

// Logs in with raw fetch so the Set-Cookie header can be captured (the shared
// request helper drops headers).
const login = async (base, email, password) => {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email} with status ${response.status}`);
  }
  return cookieFrom(response);
};

// Creates a logged-in user of the given role and returns its auth cookie.
const createAndLogin = async (base, role = "user") => {
  const { user, credentials } = await createUserDirect(role);
  const cookie = await login(base, credentials.email, credentials.password);
  return { user, cookie, credentials };
};

// Creates an asset through the API as an admin and returns the response.
const createAsset = async (base, adminCookie, overrides = {}) => {
  const id = nextId();
  const payload = {
    name: overrides.name || `Test Asset ${id}`,
    assetCode: overrides.assetCode || `T${id}`,
    category: overrides.category || "General",
    location: overrides.location || "Room 1",
  };
  if (overrides.status) {
    payload.status = overrides.status;
  }
  const res = await request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: payload,
  });
  return { res, payload, asset: res.json && res.json.asset };
};

// Deletes every record created by this test run (and nothing else).
const cleanup = async () => {
  const users = await User.find({ username: new RegExp(`^t${RUN_ID}_`) }).select("_id");
  const assets = await Asset.find({ assetCode: new RegExp(`^T${RUN_ID}_`) }).select("_id");
  const userIds = users.map((u) => u._id);
  const assetIds = assets.map((a) => a._id);

  const requests = await MaintenanceRequest.deleteMany({
    $or: [{ reportedBy: { $in: userIds } }, { asset: { $in: assetIds } }],
  });
  const removedAssets = await Asset.deleteMany({ _id: { $in: assetIds } });
  const removedUsers = await User.deleteMany({ _id: { $in: userIds } });

  return {
    requests: requests.deletedCount,
    assets: removedAssets.deletedCount,
    users: removedUsers.deletedCount,
  };
};

module.exports = {
  RUN_ID,
  app,
  User,
  Asset,
  MaintenanceRequest,
  connectTestDatabase,
  disconnectTestDatabase,
  startTestServer,
  stopTestServer,
  nextId,
  makeIdentity,
  createUserDirect,
  createAndLogin,
  createAsset,
  request,
  login,
  cookieFrom,
  cleanup,
};
