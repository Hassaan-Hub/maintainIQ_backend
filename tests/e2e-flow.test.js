const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const h = require("./helpers/harness");

// This flow stores an image URL on an asset, which is only accepted when
// ImageKit is configured. Set a test endpoint for the run and restore after.
const IMAGEKIT_ENV = {
  IMAGEKIT_PUBLIC_KEY: "ik_public_test",
  IMAGEKIT_PRIVATE_KEY: "ik_private_test",
  IMAGEKIT_URL_ENDPOINT: "https://ik.imagekit.io/maintainiq_test",
};
const savedImagekitEnv = {};

let server;
let base;
let adminCookie;
let userCookie;

before(async () => {
  for (const key of Object.keys(IMAGEKIT_ENV)) {
    savedImagekitEnv[key] = process.env[key];
    process.env[key] = IMAGEKIT_ENV[key];
  }

  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
  userCookie = (await h.createAndLogin(base, "user")).cookie;
});

after(async () => {
  for (const key of Object.keys(IMAGEKIT_ENV)) {
    if (savedImagekitEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedImagekitEnv[key];
    }
  }

  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("full lifecycle: asset -> report -> assign -> resolve -> close -> history/public/dashboard", async () => {
  // 1. Admin creates an asset, including image metadata, and it round-trips.
  const assetCode = `T${h.nextId()}`;
  const createAssetRes = await h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: {
      name: "E2E Conveyor",
      assetCode,
      category: "Machinery",
      location: "Bay 3",
      imageUrl: "https://ik.imagekit.io/maintainiq_test/e2e/conveyor.jpg",
      imageFileId: "file_e2e_conveyor",
    },
  });

  assert.equal(createAssetRes.status, 201);
  const asset = createAssetRes.json.asset;
  assert.equal(asset.imageUrl, "https://ik.imagekit.io/maintainiq_test/e2e/conveyor.jpg");
  assert.equal(asset.imageFileId, "file_e2e_conveyor");

  // 2. A regular user reports a problem against the asset.
  const createReqRes = await h.request(
    base,
    "POST",
    "/api/maintenance-requests",
    {
      cookie: userCookie,
      body: {
        asset: asset.id,
        title: "Conveyor belt slipping",
        description: "Belt slips under load near the drive pulley.",
        priority: "high",
      },
    }
  );

  assert.equal(createReqRes.status, 201);
  const request = createReqRes.json.request;
  assert.equal(request.status, "open");
  assert.equal(request.priority, "high");
  assert.equal(request.asset.assetCode, assetCode);
  const requestId = request.id;

  // 3. Admin assigns the request to a technician.
  const tech = await h.createAndLogin(base, "technician");
  const assignRes = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${requestId}/assign`,
    { cookie: adminCookie, body: { technicianId: tech.user.id } }
  );

  assert.equal(assignRes.status, 200);
  assert.equal(assignRes.json.request.assignedTechnician.id, tech.user.id);

  // 4. The assigned technician drives the workflow: open -> in_progress -> resolved.
  const inProgressRes = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${requestId}/status`,
    { cookie: tech.cookie, body: { status: "in_progress" } }
  );
  assert.equal(inProgressRes.status, 200);
  assert.equal(inProgressRes.json.request.status, "in_progress");

  const resolvedRes = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${requestId}/status`,
    { cookie: tech.cookie, body: { status: "resolved", note: "Belt re-tensioned." } }
  );
  assert.equal(resolvedRes.status, 200);
  assert.equal(resolvedRes.json.request.status, "resolved");
  assert.ok(resolvedRes.json.request.resolvedAt, "resolvedAt should be stamped");

  // 5. Admin closes the resolved request.
  const closedRes = await h.request(
    base,
    "PATCH",
    `/api/maintenance-requests/${requestId}/status`,
    { cookie: adminCookie, body: { status: "closed" } }
  );
  assert.equal(closedRes.status, 200);
  assert.equal(closedRes.json.request.status, "closed");
  assert.ok(closedRes.json.request.closedAt, "closedAt should be stamped");

  // 6. The audit history captures creation, assignment-adjacent status changes.
  const historyRes = await h.request(
    base,
    "GET",
    `/api/maintenance-requests/${requestId}/history`,
    { cookie: adminCookie }
  );
  assert.equal(historyRes.status, 200);
  const actions = historyRes.json.history.map((entry) => entry.to);
  assert.ok(historyRes.json.history.length >= 3, "history should record each step");
  assert.ok(actions.includes("in_progress"));
  assert.ok(actions.includes("resolved"));
  assert.ok(actions.includes("closed"));

  // 7. The public QR-style lookup exposes the asset (with its image) but no ids.
  const publicRes = await h.request(base, "GET", `/api/public/assets/${assetCode}`);
  assert.equal(publicRes.status, 200);
  assert.equal(publicRes.json.asset.assetCode, assetCode);
  assert.equal(
    publicRes.json.asset.imageUrl,
    "https://ik.imagekit.io/maintainiq_test/e2e/conveyor.jpg"
  );
  assert.equal(publicRes.json.asset.imageFileId, undefined);
  assert.equal(publicRes.json.asset.createdBy, undefined);

  // 8. The admin dashboard counts the new records.
  const statsRes = await h.request(base, "GET", "/api/dashboard/stats", {
    cookie: adminCookie,
  });
  assert.equal(statsRes.status, 200);
  assert.ok(statsRes.json.assets.total >= 1);
  assert.ok(statsRes.json.requests.total >= 1);
  assert.ok(statsRes.json.requests.byStatus.closed >= 1);

  // 9. A technician's workload view includes the closed assignment.
  const workloadRes = await h.request(base, "GET", "/api/dashboard/technicians", {
    cookie: adminCookie,
  });
  assert.equal(workloadRes.status, 200);
  const row = workloadRes.json.technicians.find(
    (t) => t.technician && t.technician.id === tech.user.id
  );
  assert.ok(row, "the technician should appear in the workload list");
  assert.ok(row.total >= 1);
});
