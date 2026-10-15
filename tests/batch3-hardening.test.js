const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const h = require("./helpers/harness");
const {
  createAuthLimiter,
  createRateLimiter,
} = require("../src/middleware/rate-limit.middleware");

let base;
let server;
let adminCookie;
let userCookie;
let techCookie;
let techId;
let asset;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
  userCookie = (await h.createAndLogin(base, "user")).cookie;
  const tech = await h.createAndLogin(base, "technician");
  techCookie = tech.cookie;
  techId = tech.user.id;
  asset = (await h.createAsset(base, adminCookie)).asset;
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

// Creates a maintenance request through the API.
const createRequest = (cookie, body) =>
  h.request(base, "POST", "/api/maintenance-requests", { cookie, body });

const newRequestBody = (assetId, overrides = {}) => ({
  asset: assetId,
  title: `Req ${h.nextId()}`,
  description: "Something needs attention.",
  ...overrides,
});

// Starts a tiny standalone express app with the given limiter on an ephemeral
// port. Returns its URL and a close() promise.
const startMiniServer = async (limiter, handler) => {
  const mini = express();
  mini.get("/x", limiter, handler);
  const instance = await new Promise((resolve) => {
    const s = mini.listen(0, () => resolve(s));
  });
  const { port } = instance.address();
  return {
    url: `http://127.0.0.1:${port}/x`,
    close: () => new Promise((resolve) => instance.close(resolve)),
  };
};

// Logs in via raw fetch and returns the cookie's Max-Age plus the token's exp.
const readCookieLifetime = async (email, password) => {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie().join(";")
    : response.headers.get("set-cookie");
  const maxAgeMatch = setCookie.match(/Max-Age=(\d+)/i);
  assert.ok(maxAgeMatch, "expected a Max-Age attribute on the auth cookie");
  const token = setCookie.match(/token=([^;]+)/)[1];
  return { maxAge: Number(maxAgeMatch[1]), exp: jwt.decode(token).exp };
};

test("updateRequest rejects a non-string dueDate (number and boolean)", async () => {
  const created = await createRequest(userCookie, newRequestBody(asset.id));
  const id = created.json.request.id;

  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { dueDate: 1700000000000 },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { dueDate: true },
  });
  assert.equal(res.status, 400);
});

test("updateRequest rejects explicit null category and location", async () => {
  const created = await createRequest(userCookie, newRequestBody(asset.id));
  const id = created.json.request.id;

  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { category: null },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { location: null },
  });
  assert.equal(res.status, 400);
});

test("updateRequest logs one 'updated' entry naming changed fields only", async () => {
  const created = await createRequest(userCookie, newRequestBody(asset.id));
  const id = created.json.request.id;
  const dueDate = "2027-03-04T05:06:07.000Z";

  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { title: "Brand new title", dueDate },
  });
  assert.equal(res.status, 200);

  let history = await h.request(base, "GET", `/api/maintenance-requests/${id}/history`, {
    cookie: adminCookie,
  });
  assert.equal(history.status, 200);
  const updated = history.json.history.filter((e) => e.action === "updated");
  assert.equal(updated.length, 1, "exactly one updated entry expected");
  assert.ok(updated[0].note.includes("title"), "note should name title");
  assert.ok(updated[0].note.includes("dueDate"), "note should name dueDate");

  // Sending the identical values again is accepted but logs nothing new.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { title: "Brand new title", dueDate },
  });
  assert.equal(res.status, 200);

  history = await h.request(base, "GET", `/api/maintenance-requests/${id}/history`, {
    cookie: adminCookie,
  });
  const updatedAgain = history.json.history.filter((e) => e.action === "updated");
  assert.equal(updatedAgain.length, 1, "unchanged values must not be logged");
});

test("deleting an asset that still has requests returns 409 and keeps it", async () => {
  const target = (await h.createAsset(base, adminCookie)).asset;
  const created = await createRequest(userCookie, newRequestBody(target.id));
  assert.equal(created.status, 201);

  let res = await h.request(base, "DELETE", `/api/assets/${target.id}`, {
    cookie: adminCookie,
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.message, "Cannot delete an asset that has maintenance requests.");

  const stillThere = await h.request(base, "GET", `/api/assets/${target.id}`, {
    cookie: adminCookie,
  });
  assert.equal(stillThere.status, 200);

  // An asset with no requests can still be deleted.
  const clean = (await h.createAsset(base, adminCookie)).asset;
  res = await h.request(base, "DELETE", `/api/assets/${clean.id}`, {
    cookie: adminCookie,
  });
  assert.equal(res.status, 200);
});

test("createAsset rejects a non-string description", async () => {
  const res = await h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: {
      name: "Described",
      assetCode: `T${h.nextId()}`,
      category: "General",
      location: "Room 1",
      description: 123,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.message, "description must be text.");
});

test("public lookup rejects an overlong asset code with 404", async () => {
  const res = await h.request(base, "GET", `/api/public/assets/${"A".repeat(41)}`);
  assert.equal(res.status, 404);
});

test("workload endpoints add closed/cancelled counts without dropping old fields", async () => {
  const statuses = ["open", "in_progress", "resolved", "closed", "cancelled"];
  for (const status of statuses) {
    const created = await createRequest(userCookie, newRequestBody(asset.id));
    assert.equal(created.status, 201);
    await h.MaintenanceRequest.updateOne(
      { _id: created.json.request.id },
      { $set: { assignedTechnician: techId, status } }
    );
  }

  const techRes = await h.request(base, "GET", "/api/dashboard/technicians", {
    cookie: adminCookie,
  });
  assert.equal(techRes.status, 200);
  const entry = techRes.json.technicians.find((t) => t.technician.id === techId);
  assert.ok(entry, "technician entry should exist");
  for (const name of statuses) {
    assert.equal(entry[name], 1, `technicians.${name} should be 1`);
  }
  assert.equal(entry.total, statuses.length, "total keeps its meaning");

  const myRes = await h.request(base, "GET", "/api/dashboard/my-workload", {
    cookie: techCookie,
  });
  assert.equal(myRes.status, 200);
  for (const name of statuses) {
    assert.equal(myRes.json[name], 1, `my-workload.${name} should be 1`);
  }
  assert.equal(myRes.json.total, statuses.length);
});

test("a freshly loaded user has no password property yet can still log in", async () => {
  const { user, credentials } = await h.createUserDirect("user");

  const fresh = await h.User.findOne({ _id: user._id });
  assert.equal(fresh.password, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(fresh.toObject(), "password"),
    false
  );

  const cookie = await h.login(base, credentials.email, credentials.password);
  const me = await h.request(base, "GET", "/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, credentials.email);
});

test("login cookie Max-Age tracks the token's remaining lifetime", async () => {
  const { credentials } = await h.createUserDirect("user");

  // Default configuration: the cookie lifetime matches the token's own expiry.
  const def = await readCookieLifetime(credentials.email, credentials.password);
  const defRemaining = Math.round(def.exp - Date.now() / 1000);
  assert.ok(
    Math.abs(def.maxAge - defRemaining) <= 5,
    `default maxAge ${def.maxAge} vs remaining ${defRemaining}`
  );

  // A non-default lifetime proves Max-Age follows the token, not a fixed value.
  const original = process.env.JWT_EXPIRES_IN;
  try {
    process.env.JWT_EXPIRES_IN = "2h";
    const short = await readCookieLifetime(credentials.email, credentials.password);
    const shortRemaining = Math.round(short.exp - Date.now() / 1000);
    assert.ok(
      Math.abs(short.maxAge - shortRemaining) <= 5,
      `maxAge ${short.maxAge} vs remaining ${shortRemaining}`
    );
    assert.ok(Math.abs(short.maxAge - 7200) <= 10, `expected ~7200ms, got ${short.maxAge}`);
  } finally {
    if (original === undefined) {
      delete process.env.JWT_EXPIRES_IN;
    } else {
      process.env.JWT_EXPIRES_IN = original;
    }
  }
});

test("skipSuccessfulRequests only counts failed attempts toward the limit", async () => {
  const failing = await startMiniServer(
    createAuthLimiter({ windowMs: 60000, max: 2, skipSuccessfulRequests: true }),
    (req, res) => (req.query.fail === "1" ? res.status(401).json({}) : res.json({}))
  );
  try {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${failing.url}?fail=1`);
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 429]);
  } finally {
    await failing.close();
  }

  const succeeding = await startMiniServer(
    createAuthLimiter({ windowMs: 60000, max: 2, skipSuccessfulRequests: true }),
    (req, res) => res.json({ ok: true })
  );
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(succeeding.url);
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
  } finally {
    await succeeding.close();
  }
});

test("the public limiter returns 429 after its limit", async () => {
  const mini = await startMiniServer(
    createRateLimiter({ windowMs: 60000, max: 3 }),
    (req, res) => res.json({ ok: true })
  );
  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(mini.url);
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  } finally {
    await mini.close();
  }
});
