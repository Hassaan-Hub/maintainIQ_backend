const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const h = require("./helpers/harness");

let base;
let server;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("register creates a user without exposing the password", async () => {
  const id = h.makeIdentity();
  const res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: id.username, email: id.email, password: id.password },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.username, id.username);
  assert.equal(res.json.user.role, "user");
  assert.equal(res.json.user.password, undefined);
});

test("register rejects a duplicate username/email with 409", async () => {
  const id = h.makeIdentity();
  const body = { username: id.username, email: id.email, password: id.password };
  await h.request(base, "POST", "/api/auth/register", { body });
  const res = await h.request(base, "POST", "/api/auth/register", { body });
  assert.equal(res.status, 409);
});

test("register validates username, email and password", async () => {
  let res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: "ab", email: "valid@example.test", password: "secret1" },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: "validname", email: "not-an-email", password: "secret1" },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: "validname", email: "b@example.test", password: "123" },
  });
  assert.equal(res.status, 400);
});

test("register cannot self-assign a privileged role", async () => {
  const id = h.makeIdentity();
  const res = await h.request(base, "POST", "/api/auth/register", {
    body: { username: id.username, email: id.email, password: id.password, role: "admin" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, "user");
});

test("login sets an HttpOnly cookie and hides the password", async () => {
  const { credentials } = await h.createUserDirect("user");
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie().join(";")
    : response.headers.get("set-cookie");
  assert.match(setCookie, /token=/);
  assert.match(setCookie, /HttpOnly/i);
  const json = await response.json();
  assert.equal(json.user.password, undefined);
});

test("login rejects a wrong password and an unknown email with 401", async () => {
  const { credentials } = await h.createUserDirect("user");
  let res = await h.request(base, "POST", "/api/auth/login", {
    body: { email: credentials.email, password: "definitely-wrong" },
  });
  assert.equal(res.status, 401);

  res = await h.request(base, "POST", "/api/auth/login", {
    body: { email: `nobody.${h.RUN_ID}@example.test`, password: "whatever" },
  });
  assert.equal(res.status, 401);
});

test("logout clears the auth cookie", async () => {
  const response = await fetch(base + "/api/auth/logout", { method: "POST" });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie().join(";")
    : response.headers.get("set-cookie");
  assert.match(setCookie, /token=;/);
});

test("/me requires authentication", async () => {
  const res = await h.request(base, "GET", "/api/auth/me");
  assert.equal(res.status, 401);
});

test("/me returns the current user for a valid cookie", async () => {
  const { user, cookie } = await h.createAndLogin(base, "user");
  const res = await h.request(base, "GET", "/api/auth/me", { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.id, user.id);
  assert.equal(res.json.user.password, undefined);
});

test("/me rejects an invalid token", async () => {
  const res = await h.request(base, "GET", "/api/auth/me", {
    cookie: "token=not.a.valid.jwt",
  });
  assert.equal(res.status, 401);
});

test("/me rejects an expired token", async () => {
  const { user } = await h.createUserDirect("user");
  const token = jwt.sign({ sub: user.id, role: "user" }, process.env.JWT_SECRET, {
    expiresIn: -10,
  });
  const res = await h.request(base, "GET", "/api/auth/me", {
    cookie: `token=${token}`,
  });
  assert.equal(res.status, 401);
});
