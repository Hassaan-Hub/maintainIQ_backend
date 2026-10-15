const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./helpers/harness");

let base;
let server;
let adminCookie;
let userCookie;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
  userCookie = (await h.createAndLogin(base, "user")).cookie;
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("user management requires authentication", async () => {
  const res = await h.request(base, "GET", "/api/users");
  assert.equal(res.status, 401);
});

test("user management is admin-only", async () => {
  const res = await h.request(base, "GET", "/api/users", { cookie: userCookie });
  assert.equal(res.status, 403);
});

test("admin can create a technician account", async () => {
  const id = h.makeIdentity();
  const res = await h.request(base, "POST", "/api/users", {
    cookie: adminCookie,
    body: { username: id.username, email: id.email, password: id.password, role: "technician" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, "technician");
  assert.equal(res.json.user.password, undefined);
});

test("admin create validates input and duplicates", async () => {
  const id = h.makeIdentity();
  const body = { username: id.username, email: id.email, password: id.password, role: "technician" };
  await h.request(base, "POST", "/api/users", { cookie: adminCookie, body });

  let res = await h.request(base, "POST", "/api/users", { cookie: adminCookie, body });
  assert.equal(res.status, 409);

  res = await h.request(base, "POST", "/api/users", {
    cookie: adminCookie,
    body: { username: `${id.username}b`, email: `${id.email}`, password: "secret1", role: "wizard" },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "POST", "/api/users", {
    cookie: adminCookie,
    body: { username: `${id.username}c`, password: "secret1", role: "user" },
  });
  assert.equal(res.status, 400);
});

test("admin can list and filter users", async () => {
  const created = await h.createUserDirect("technician");

  const all = await h.request(base, "GET", "/api/users", { cookie: adminCookie });
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.json.users));
  assert.ok(all.json.pagination.total >= 1);
  assert.ok(all.json.users.every((u) => u.password === undefined));

  const filtered = await h.request(base, "GET", "/api/users?role=technician", {
    cookie: adminCookie,
  });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.users.every((u) => u.role === "technician"));
  assert.ok(filtered.json.users.some((u) => u.id === created.user.id));
});

test("admin can change another user's role", async () => {
  const { user } = await h.createUserDirect("user");
  const res = await h.request(base, "PATCH", `/api/users/${user.id}/role`, {
    cookie: adminCookie,
    body: { role: "technician" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.role, "technician");
});

test("an admin cannot change their own role", async () => {
  const me = await h.request(base, "GET", "/api/auth/me", { cookie: adminCookie });
  const res = await h.request(base, "PATCH", `/api/users/${me.json.user.id}/role`, {
    cookie: adminCookie,
    body: { role: "user" },
  });
  assert.equal(res.status, 400);
});

test("role update validates id, role and existence", async () => {
  let res = await h.request(base, "PATCH", "/api/users/not-an-id/role", {
    cookie: adminCookie,
    body: { role: "technician" },
  });
  assert.equal(res.status, 400);

  const fresh = new mongoose.Types.ObjectId().toString();
  res = await h.request(
    base,
    "PATCH",
    `/api/users/6acf1a3250fd9ad2a2e328e4/role`,
    { cookie: adminCookie, body: { role: "bogus" } }
  );
  assert.equal(res.status, 400);

  res = await h.request(base, "PATCH", `/api/users/${fresh}/role`, {
    cookie: adminCookie,
    body: { role: "technician" },
  });
  assert.equal(res.status, 404);
});

test("non-admins cannot change roles", async () => {
  const { user } = await h.createUserDirect("user");
  const res = await h.request(base, "PATCH", `/api/users/${user.id}/role`, {
    cookie: userCookie,
    body: { role: "admin" },
  });
  assert.equal(res.status, 403);
});
