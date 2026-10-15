const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./helpers/harness");

let base;
let server;
let adminCookie;
let userACookie;
let userBCookie;
let techACookie;
let techBCookie;
let techAId;
let techBId;
let assetA;
let assetB;

const createRequest = (cookie, body) =>
  h.request(base, "POST", "/api/maintenance-requests", { cookie, body });

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
  userACookie = (await h.createAndLogin(base, "user")).cookie;
  userBCookie = (await h.createAndLogin(base, "user")).cookie;

  const techA = await h.createAndLogin(base, "technician");
  const techB = await h.createAndLogin(base, "technician");
  techACookie = techA.cookie;
  techBCookie = techB.cookie;
  techAId = techA.user.id;
  techBId = techB.user.id;

  assetA = (await h.createAsset(base, adminCookie, { category: "HVAC", location: "Roof" })).asset;
  assetB = (await h.createAsset(base, adminCookie, { category: "Electrical", location: "Basement" })).asset;
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("creating a request requires authentication", async () => {
  const res = await createRequest(null, {
    asset: assetA.id,
    title: "x",
    description: "y",
  });
  assert.equal(res.status, 401);
});

test("request creation validates its input", async () => {
  let res = await createRequest(userACookie, {
    asset: "not-an-id",
    title: "x",
    description: "y",
  });
  assert.equal(res.status, 400);

  res = await createRequest(userACookie, {
    asset: new mongoose.Types.ObjectId().toString(),
    title: "x",
    description: "y",
  });
  assert.equal(res.status, 404);

  res = await createRequest(userACookie, { asset: assetA.id, description: "y" });
  assert.equal(res.status, 400);

  res = await createRequest(userACookie, {
    asset: assetA.id,
    title: "x",
    description: "y",
    priority: "urgent",
  });
  assert.equal(res.status, 400);

  res = await createRequest(userACookie, {
    asset: assetA.id,
    title: "x",
    description: "y",
    dueDate: "not-a-date",
  });
  assert.equal(res.status, 400);
});

test("creation ignores spoofed reporter/status and defaults category/location", async () => {
  const res = await createRequest(userACookie, {
    asset: assetA.id,
    title: "Leaking pipe",
    description: "Water near valve",
    reportedBy: "000000000000000000000000",
    status: "closed",
    assignedTechnician: techAId,
  });
  assert.equal(res.status, 201);
  const request = res.json.request;
  assert.equal(request.reportedBy.email, undefined);
  assert.equal(request.reportedBy.role, "user");
  assert.equal(request.status, "open");
  assert.equal(request.assignedTechnician, null);
  assert.equal(request.category, "HVAC");
  assert.equal(request.location, "Roof");
  assert.notEqual(request.reportedBy.id, "000000000000000000000000");
});

test("a user lists only their own requests with filters and pagination", async () => {
  await createRequest(userACookie, { asset: assetA.id, title: "A one", description: "d", priority: "high" });
  await createRequest(userACookie, { asset: assetB.id, title: "A two", description: "d" });
  await createRequest(userBCookie, { asset: assetA.id, title: "B one", description: "d" });

  const mine = await h.request(base, "GET", "/api/maintenance-requests/my", { cookie: userACookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.json.requests.every((r) => r.reportedBy.role === "user"));

  const high = await h.request(base, "GET", "/api/maintenance-requests/my?priority=high", {
    cookie: userACookie,
  });
  assert.equal(high.status, 200);
  assert.ok(high.json.requests.every((r) => r.priority === "high"));

  const paged = await h.request(base, "GET", "/api/maintenance-requests/my?limit=1&page=1", {
    cookie: userACookie,
  });
  assert.equal(paged.status, 200);
  assert.equal(paged.json.requests.length, 1);
});

test("request detail access is owner/admin/assigned only", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;

  let res = await h.request(base, "GET", `/api/maintenance-requests/${id}`, { cookie: userACookie });
  assert.equal(res.status, 200);

  res = await h.request(base, "GET", `/api/maintenance-requests/${id}`, { cookie: userBCookie });
  assert.equal(res.status, 404);

  res = await h.request(base, "GET", `/api/maintenance-requests/${id}`, { cookie: adminCookie });
  assert.equal(res.status, 200);

  res = await h.request(base, "GET", "/api/maintenance-requests/bad-id", { cookie: adminCookie });
  assert.equal(res.status, 400);

  res = await h.request(
    base,
    "GET",
    `/api/maintenance-requests/${new mongoose.Types.ObjectId().toString()}`,
    { cookie: adminCookie }
  );
  assert.equal(res.status, 404);
});

test("admin list supports search, filters and is admin-only", async () => {
  const created = await createRequest(userACookie, {
    asset: assetB.id,
    title: `Searchable ${h.nextId()}`,
    description: "d",
    category: "Plumbing",
    priority: "critical",
  });
  assert.equal(created.status, 201);

  const asUser = await h.request(base, "GET", "/api/maintenance-requests", { cookie: userACookie });
  assert.equal(asUser.status, 403);

  const search = await h.request(
    base,
    "GET",
    `/api/maintenance-requests?search=${encodeURIComponent(created.json.request.title)}`,
    { cookie: adminCookie }
  );
  assert.equal(search.status, 200);
  assert.ok(search.json.requests.some((r) => r.id === created.json.request.id));

  const filter = await h.request(
    base,
    "GET",
    `/api/maintenance-requests?asset=${assetB.id}&priority=critical`,
    { cookie: adminCookie }
  );
  assert.equal(filter.status, 200);
  assert.ok(filter.json.requests.every((r) => r.priority === "critical"));

  const paged = await h.request(base, "GET", "/api/maintenance-requests?limit=1", {
    cookie: adminCookie,
  });
  assert.equal(paged.status, 200);
  assert.equal(paged.json.requests.length, 1);
});

test("admin update validates fields, rejects empty updates and enforces transitions", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;

  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { priority: "high", title: "Updated title" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.priority, "high");
  assert.equal(res.json.request.title, "Updated title");

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: {},
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { foo: "bar" },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { status: "bogus" },
  });
  assert.equal(res.status, 400);

  // open -> resolved is valid; resolved -> cancelled is not.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { status: "resolved" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.status, "resolved");

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { status: "cancelled" },
  });
  assert.equal(res.status, 400);
});

test("admin update cannot change the asset or reporter", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;

  const res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { asset: assetB.id, reportedBy: "000000000000000000000000", title: "keep asset" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.asset.id, assetA.id);
  assert.equal(res.json.request.reportedBy.id, created.json.request.reportedBy.id);
});

test("assignment validates the technician and supports reassignment", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;

  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: userACookie,
    body: { technicianId: techAId },
  });
  assert.equal(res.status, 403);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: "not-an-id" },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: new mongoose.Types.ObjectId().toString() },
  });
  assert.equal(res.status, 404);

  const adminId = (await h.request(base, "GET", "/api/auth/me", { cookie: adminCookie })).json.user.id;
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: adminId },
  });
  assert.equal(res.status, 400, "assigning a non-technician must fail");

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: techAId },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.assignedTechnician.id, techAId);

  // Reassign to another technician.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: techBId },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.assignedTechnician.id, techBId);

  // Reassigning to the same technician is rejected.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: techBId },
  });
  assert.equal(res.status, 400);

  // Unassign, then unassigning again is rejected.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: null },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.assignedTechnician, null);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: null },
  });
  assert.equal(res.status, 400);
});

test("technicians see only their own assignments", async () => {
  const created = await createRequest(userACookie, toBody(assetA, { title: `Assigned ${h.nextId()}` }));
  const id = created.json.request.id;
  await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: techAId },
  });

  const mine = await h.request(base, "GET", "/api/maintenance-requests/assigned", { cookie: techACookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.json.requests.some((r) => r.id === id));
  assert.ok(mine.json.requests.every((r) => r.assignedTechnician.id === techAId));

  const other = await h.request(base, "GET", "/api/maintenance-requests/assigned", { cookie: techBCookie });
  assert.equal(other.status, 200);
  assert.ok(other.json.requests.every((r) => r.id !== id));

  const asUser = await h.request(base, "GET", "/api/maintenance-requests/assigned", { cookie: userACookie });
  assert.equal(asUser.status, 403);

  const asAdmin = await h.request(
    base,
    "GET",
    `/api/maintenance-requests/assigned?technicianId=${techAId}`,
    { cookie: adminCookie }
  );
  assert.equal(asAdmin.status, 200);
  assert.ok(asAdmin.json.requests.some((r) => r.id === id));
});

test("assigned technician can drive the status workflow", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;
  await h.request(base, "PATCH", `/api/maintenance-requests/${id}/assign`, {
    cookie: adminCookie,
    body: { technicianId: techAId },
  });

  // A different technician is not allowed.
  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: techBCookie,
    body: { status: "in_progress" },
  });
  assert.equal(res.status, 403);

  // Regular users cannot reach the endpoint at all.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: userACookie,
    body: { status: "in_progress" },
  });
  assert.equal(res.status, 403);

  // The assigned technician can move open -> in_progress.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: techACookie,
    body: { status: "in_progress", note: "Started work" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.status, "in_progress");

  // Setting the same status again is rejected.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: techACookie,
    body: { status: "in_progress" },
  });
  assert.equal(res.status, 400);

  // Technicians cannot cancel.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: techACookie,
    body: { status: "cancelled" },
  });
  assert.equal(res.status, 403);

  // Invalid enum value.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: techACookie,
    body: { status: "bogus" },
  });
  assert.equal(res.status, 400);

  // in_progress -> resolved is valid.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/status`, {
    cookie: techACookie,
    body: { status: "resolved" },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.request.resolvedAt);
});

test("history records server-side changes and cannot be forged", async () => {
  const created = await createRequest(userACookie, {
    ...toBody(assetA),
    history: [{ action: "cancelled", by: "000000000000000000000000" }],
  });
  const id = created.json.request.id;

  await h.request(base, "PATCH", `/api/maintenance-requests/${id}`, {
    cookie: adminCookie,
    body: { priority: "critical" },
  });

  const res = await h.request(base, "GET", `/api/maintenance-requests/${id}/history`, {
    cookie: userACookie,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.history[0].action, "created");
  assert.equal(res.json.history[0].by.role, "user");
  assert.ok(res.json.history.some((e) => e.action === "priority_changed"));
  // The forged entry never appears.
  assert.ok(res.json.history.every((e) => e.by.id !== "000000000000000000000000"));

  const other = await h.request(base, "GET", `/api/maintenance-requests/${id}/history`, {
    cookie: userBCookie,
  });
  assert.equal(other.status, 404);
});

test("owners and admins can cancel, others cannot", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;

  let res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/cancel`, {
    cookie: userBCookie,
  });
  assert.equal(res.status, 403);

  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/cancel`, {
    cookie: userACookie,
    body: { note: "No longer needed" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.status, "cancelled");

  // Already cancelled -> not cancellable again.
  res = await h.request(base, "PATCH", `/api/maintenance-requests/${id}/cancel`, {
    cookie: userACookie,
  });
  assert.equal(res.status, 400);

  // Admin can cancel someone else's open request.
  const another = await createRequest(userBCookie, toBody(assetA));
  res = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${another.json.request.id}/cancel`,
    { cookie: adminCookie }
  );
  assert.equal(res.status, 200);
});

test("delete is admin-only and leaves its asset and reporter", async () => {
  const created = await createRequest(userACookie, toBody(assetA));
  const id = created.json.request.id;

  let res = await h.request(base, "DELETE", `/api/maintenance-requests/${id}`, { cookie: userACookie });
  assert.equal(res.status, 403);

  res = await h.request(base, "DELETE", `/api/maintenance-requests/${id}`, { cookie: adminCookie });
  assert.equal(res.status, 200);

  res = await h.request(base, "GET", `/api/maintenance-requests/${id}`, { cookie: adminCookie });
  assert.equal(res.status, 404);

  const asset = await h.Asset.findById(assetA.id);
  assert.ok(asset, "asset must survive request deletion");
});

// Small builder for a valid request body against the given asset.
function toBody(asset, overrides = {}) {
  return {
    asset: asset.id,
    title: overrides.title || `Request ${h.nextId()}`,
    description: overrides.description || "Something needs attention.",
    ...overrides,
  };
}
