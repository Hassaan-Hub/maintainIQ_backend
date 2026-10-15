const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const h = require("./helpers/harness");

// Second end-to-end file: access-control and destructive-flow coverage that the
// happy-path flow does not exercise.
let server;
let base;
let admin;
let user;
let otherUser;
let technician;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  admin = await h.createAndLogin(base, "admin");
  user = await h.createAndLogin(base, "user");
  otherUser = await h.createAndLogin(base, "user");
  technician = await h.createAndLogin(base, "technician");
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

const report = (cookie, assetId) =>
  h.request(base, "POST", "/api/maintenance-requests", {
    cookie,
    body: {
      asset: assetId,
      title: "Integration issue",
      description: "Something is broken and needs attention.",
    },
  });

test("guards reject unauthenticated and wrong-role callers", async () => {
  // Unauthenticated -> 401.
  let res = await h.request(base, "GET", "/api/assets");
  assert.equal(res.status, 401);

  res = await h.request(base, "POST", "/api/assets", {
    body: { name: "x", assetCode: `T${h.nextId()}`, category: "c", location: "l" },
  });
  assert.equal(res.status, 401);

  // Authenticated but not an admin -> 403.
  res = await h.request(base, "POST", "/api/assets", {
    cookie: user.cookie,
    body: { name: "x", assetCode: `T${h.nextId()}`, category: "c", location: "l" },
  });
  assert.equal(res.status, 403);

  res = await h.request(base, "GET", "/api/users", { cookie: user.cookie });
  assert.equal(res.status, 403);

  res = await h.request(base, "GET", "/api/dashboard/stats", { cookie: user.cookie });
  assert.equal(res.status, 403);

  res = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${new mongoose.Types.ObjectId().toString()}/assign`,
    { cookie: user.cookie, body: { technicianId: technician.user.id } }
  );
  assert.equal(res.status, 403);

  res = await h.request(
    base,
    "DELETE",
    `/api/assets/${new mongoose.Types.ObjectId().toString()}`,
    { cookie: technician.cookie }
  );
  assert.equal(res.status, 403);
});

test("only the owner (or an admin) can cancel a request", async () => {
  const { asset } = await h.createAsset(base, admin.cookie);
  const created = await report(user.cookie, asset.id);
  assert.equal(created.status, 201);
  const id = created.json.request.id;

  // A different logged-in user may not cancel someone else's request.
  const forbidden = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${id}/cancel`,
    { cookie: otherUser.cookie, body: {} }
  );
  assert.equal(forbidden.status, 403);

  // The owner can.
  const cancelled = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${id}/cancel`,
    { cookie: user.cookie, body: {} }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.request.status, "cancelled");
});

test("admin can delete a maintenance request", async () => {
  const { asset } = await h.createAsset(base, admin.cookie);
  const created = await report(user.cookie, asset.id);
  assert.equal(created.status, 201);
  const id = created.json.request.id;

  const deleted = await h.request(base, "DELETE", `/api/maintenance-requests/${id}`, {
    cookie: admin.cookie,
  });
  assert.equal(deleted.status, 200);

  const gone = await h.request(base, "GET", `/api/maintenance-requests/${id}`, {
    cookie: admin.cookie,
  });
  assert.equal(gone.status, 404);
});

test("asset delete is blocked while requests exist, then succeeds once removed", async () => {
  const { asset } = await h.createAsset(base, admin.cookie);
  const created = await report(user.cookie, asset.id);
  assert.equal(created.status, 201);
  const requestId = created.json.request.id;

  // Blocked while the asset still has a request.
  let res = await h.request(base, "DELETE", `/api/assets/${asset.id}`, {
    cookie: admin.cookie,
  });
  assert.equal(res.status, 409);

  // Remove the request, then the asset can go.
  const delRequest = await h.request(
    base,
    "DELETE",
    `/api/maintenance-requests/${requestId}`,
    { cookie: admin.cookie }
  );
  assert.equal(delRequest.status, 200);

  res = await h.request(base, "DELETE", `/api/assets/${asset.id}`, {
    cookie: admin.cookie,
  });
  assert.equal(res.status, 200);

  const gone = await h.request(base, "GET", `/api/assets/${asset.id}`, {
    cookie: admin.cookie,
  });
  assert.equal(gone.status, 404);
});
