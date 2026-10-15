const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const h = require("./helpers/harness");
const { createAuthLimiter } = require("../src/middleware/rate-limit.middleware");

// The isolated app server (ephemeral port) used by the HTTP assertions.
let base;
let server;

// The auth limiter is exercised on its own on the standard test port. Checked
// to be free before binding (see the run notes).
const RATE_LIMIT_PORT = 3100;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

// Creates a user directly in the database with an arbitrary (possibly
// legacy/short) password, so we can prove old accounts still work.
const createUserWithPassword = async (password, role = "user") => {
  const id = h.nextId();
  const username = `t${id}`;
  const email = `t${id}@example.test`;
  const hashed = await bcrypt.hash(password, 10);
  const user = await h.User.create({ username, email, password: hashed, role });
  return { user, username, email, password };
};

test("register and login with no body return 400, not 500", async () => {
  const register = await h.request(base, "POST", "/api/auth/register");
  assert.equal(register.status, 400);

  const login = await h.request(base, "POST", "/api/auth/login");
  assert.equal(login.status, 400);
});

test("an oversized email is rejected quickly with 400", async () => {
  const longEmail = `${"a".repeat(100_000)}@example.test`;
  const started = Date.now();
  const res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: "bigmailuser", email: longEmail, password: "12345678" },
  });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 400);
  assert.ok(elapsed < 1000, `expected < 1000ms, took ${elapsed}ms`);
});

test("password policy rejects 7 and 73 chars and accepts 8", async () => {
  const tooShort = h.makeIdentity();
  let res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: tooShort.username, email: tooShort.email, password: "1".repeat(7) },
  });
  assert.equal(res.status, 400);

  const tooLong = h.makeIdentity();
  res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: tooLong.username, email: tooLong.email, password: "1".repeat(73) },
  });
  assert.equal(res.status, 400);

  const ok = h.makeIdentity();
  res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: ok.username, email: ok.email, password: "1".repeat(8) },
  });
  assert.equal(res.status, 201);
});

test("an existing account with a legacy short password can still log in", async () => {
  const legacy = await createUserWithPassword("short12");
  const cookie = await h.login(base, legacy.email, "short12");
  assert.ok(cookie.length > 0);

  const res = await h.request(base, "GET", "/api/auth/me", { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, legacy.email);
});

test("a token whose user no longer exists is rejected with 401", async () => {
  const { user, cookie } = await h.createAndLogin(base, "user");
  await h.User.deleteOne({ _id: user._id });

  const res = await h.request(base, "GET", "/api/auth/me", { cookie });
  assert.equal(res.status, 401);
});

test("a demoted admin's old token loses access (403 on GET /api/users)", async () => {
  const { user, cookie } = await h.createAndLogin(base, "admin");

  // The role in the database is authoritative; the still-valid token says admin.
  await h.User.updateOne({ _id: user._id }, { $set: { role: "user" } });

  const res = await h.request(base, "GET", "/api/users", { cookie });
  assert.equal(res.status, 403);
});

test("tokens signed with the wrong secret or algorithm are rejected with 401", async () => {
  const { user } = await h.createUserDirect("user");
  const payload = { sub: user.id, role: user.role };

  const wrongSecret = jwt.sign(payload, `${process.env.JWT_SECRET}-nope`, {
    algorithm: "HS256",
  });
  let res = await h.request(base, "GET", "/api/auth/me", {
    cookie: `token=${wrongSecret}`,
  });
  assert.equal(res.status, 401);

  const wrongAlg = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: "HS384" });
  res = await h.request(base, "GET", "/api/auth/me", {
    cookie: `token=${wrongAlg}`,
  });
  assert.equal(res.status, 401);
});

test("changing your own role is blocked even with an uppercase id", async () => {
  const { user, cookie } = await h.createAndLogin(base, "admin");
  const upperId = user.id.toUpperCase();

  const res = await h.request(base, "PATCH", `/api/users/${upperId}/role`, {
    cookie,
    body: { role: "user" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.message, "You cannot change your own role.");
});

test("a lowercase bearer scheme is accepted", async () => {
  const { credentials, user } = await h.createUserDirect("user");
  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1d",
  });

  const response = await fetch(base + "/api/auth/me", {
    headers: { Authorization: `bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.user.email, credentials.email);
});

test("the auth limiter returns 429 after the limit", async () => {
  const mini = express();
  mini.get("/ping", createAuthLimiter({ windowMs: 60_000, max: 3 }), (req, res) =>
    res.json({ ok: true })
  );

  const miniServer = await new Promise((resolve, reject) => {
    const instance = mini.listen(RATE_LIMIT_PORT, () => resolve(instance));
    instance.once("error", reject);
  });

  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(`http://127.0.0.1:${RATE_LIMIT_PORT}/ping`);
      statuses.push(response.status);
      if (i === 3) {
        const body = await response.json();
        assert.deepEqual(body, { message: "Too many attempts. Please try again later." });
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  } finally {
    await new Promise((resolve) => miniServer.close(resolve));
  }
});
