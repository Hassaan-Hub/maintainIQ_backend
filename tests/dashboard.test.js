const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/harness");

let base;
let server;
let adminCookie;
let userCookie;
let techACookie;
let techAId;
let asset;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
  userCookie = (await h.createAndLogin(base, "user")).cookie;
  const techA = await h.createAndLogin(base, "technician");
  techACookie = techA.cookie;
  techAId = techA.user.id;
  asset = (await h.createAsset(base, adminCookie)).asset;
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("dashboard stats require admin access", async () => {
  let res = await h.request(base, "GET", "/api/dashboard/stats");
  assert.equal(res.status, 401);

  res = await h.request(base, "GET", "/api/dashboard/stats", { cookie: userCookie });
  assert.equal(res.status, 403);
});

test("dashboard stats are computed from the database", async () => {
  const expectedAssets = await h.Asset.countDocuments({});
  const expectedRequests = await h.MaintenanceRequest.countDocuments({});

  const res = await h.request(base, "GET", "/api/dashboard/stats", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.assets.total, expectedAssets);
  assert.equal(res.json.requests.total, expectedRequests);
  assert.deepEqual(Object.keys(res.json.assets.byStatus).sort(), [
    "active",
    "maintenance",
    "retired",
  ]);
  assert.deepEqual(Object.keys(res.json.requests.byStatus).sort(), [
    "cancelled",
    "closed",
    "in_progress",
    "open",
    "resolved",
  ]);
  assert.ok(Number.isInteger(res.json.requests.overdue));
  assert.ok(Number.isInteger(res.json.requests.unassigned));
  assert.ok(Number.isInteger(res.json.requests.upcoming));
});

test("technician workload reflects assignments", async () => {
  const created = await h.request(base, "POST", "/api/maintenance-requests", {
    cookie: userCookie,
    body: { asset: asset.id, title: `Workload ${h.nextId()}`, description: "d" },
  });
  await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${created.json.request.id}/assign`,
    { cookie: adminCookie, body: { technicianId: techAId } }
  );

  const res = await h.request(base, "GET", "/api/dashboard/technicians", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const entry = res.json.technicians.find((t) => t.technician.id === techAId);
  assert.ok(entry, "the technician should appear in the workload list");
  assert.ok(entry.total >= 1);
  assert.ok(entry.open >= 1);

  const asUser = await h.request(base, "GET", "/api/dashboard/technicians", { cookie: userCookie });
  assert.equal(asUser.status, 403);
});

test("recommendations surface overdue and upcoming work", async () => {
  const overdueDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const upcomingDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  const overdue = await h.request(base, "POST", "/api/maintenance-requests", {
    cookie: userCookie,
    body: { asset: asset.id, title: `Overdue ${h.nextId()}`, description: "d", dueDate: overdueDate },
  });
  const upcoming = await h.request(base, "POST", "/api/maintenance-requests", {
    cookie: userCookie,
    body: { asset: asset.id, title: `Upcoming ${h.nextId()}`, description: "d", dueDate: upcomingDate },
  });

  const maintenanceAsset = await h.createAsset(base, adminCookie, { status: "maintenance" });

  const res = await h.request(base, "GET", "/api/dashboard/recommendations", {
    cookie: adminCookie,
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.overdue.requests.some((r) => r.id === overdue.json.request.id));
  assert.ok(res.json.upcoming.requests.some((r) => r.id === upcoming.json.request.id));
  assert.ok(
    res.json.assetsInMaintenance.assets.some((a) => a.id === maintenanceAsset.asset.id)
  );

  const asUser = await h.request(base, "GET", "/api/dashboard/recommendations", {
    cookie: userCookie,
  });
  assert.equal(asUser.status, 403);
});

test("my-workload is available to technicians and admins", async () => {
  let res = await h.request(base, "GET", "/api/dashboard/my-workload", { cookie: techACookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.technicianId, techAId);
  assert.ok(res.json.total >= 1);

  res = await h.request(base, "GET", "/api/dashboard/my-workload", { cookie: userCookie });
  assert.equal(res.status, 403);

  res = await h.request(
    base,
    "GET",
    `/api/dashboard/my-workload?technicianId=${techAId}`,
    { cookie: adminCookie }
  );
  assert.equal(res.status, 200);
  assert.equal(res.json.technicianId, techAId);
});
