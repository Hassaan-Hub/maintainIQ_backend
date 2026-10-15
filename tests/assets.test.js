const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./helpers/harness");

// Image URLs are only accepted when ImageKit is configured, so this file sets a
// test endpoint for the duration of the run and restores the real values after.
const IMAGEKIT_ENV = {
  IMAGEKIT_PUBLIC_KEY: "ik_public_test",
  IMAGEKIT_PRIVATE_KEY: "ik_private_test",
  IMAGEKIT_URL_ENDPOINT: "https://ik.imagekit.io/maintainiq_test",
};
const savedImagekitEnv = {};

let base;
let server;
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

test("asset create enforces authentication and role", async () => {
  const payload = { name: "N", assetCode: `T${h.nextId()}`, category: "C", location: "L" };
  let res = await h.request(base, "POST", "/api/assets", { body: payload });
  assert.equal(res.status, 401);

  res = await h.request(base, "POST", "/api/assets", { cookie: userCookie, body: payload });
  assert.equal(res.status, 403);
});

test("admin can create an asset and duplicates are rejected", async () => {
  const { res, payload } = await h.createAsset(base, adminCookie);
  assert.equal(res.status, 201);
  assert.equal(res.json.asset.assetCode, payload.assetCode);

  const dup = await h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: payload,
  });
  assert.equal(dup.status, 409);
});

test("asset create validates required fields and status", async () => {
  let res = await h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: { name: "Only name" },
  });
  assert.equal(res.status, 400);

  res = await h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: { name: "N", assetCode: `T${h.nextId()}`, category: "C", location: "L", status: "broken" },
  });
  assert.equal(res.status, 400);
});

test("assets can be listed, searched and paginated", async () => {
  const { payload } = await h.createAsset(base, adminCookie, { category: "HVAC" });

  const list = await h.request(base, "GET", "/api/assets?limit=2", { cookie: userCookie });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.assets));
  assert.ok(list.json.pagination.total >= 1);

  const search = await h.request(
    base,
    "GET",
    `/api/assets?search=${encodeURIComponent(payload.assetCode)}`,
    { cookie: userCookie }
  );
  assert.equal(search.status, 200);
  assert.ok(search.json.assets.some((a) => a.assetCode === payload.assetCode));

  const filter = await h.request(base, "GET", "/api/assets?category=HVAC", {
    cookie: userCookie,
  });
  assert.equal(filter.status, 200);
  assert.ok(filter.json.assets.every((a) => a.category.toLowerCase() === "hvac"));
});

test("asset detail handles valid, invalid and missing ids", async () => {
  const { asset } = await h.createAsset(base, adminCookie);

  let res = await h.request(base, "GET", `/api/assets/${asset.id}`, { cookie: userCookie });
  assert.equal(res.status, 200);

  res = await h.request(base, "GET", "/api/assets/not-an-id", { cookie: userCookie });
  assert.equal(res.status, 400);

  res = await h.request(
    base,
    "GET",
    `/api/assets/${new mongoose.Types.ObjectId().toString()}`,
    { cookie: userCookie }
  );
  assert.equal(res.status, 404);
});

test("admin update ignores immutable fields (mass assignment)", async () => {
  const { asset } = await h.createAsset(base, adminCookie);
  const other = await h.createAsset(base, adminCookie);

  const res = await h.request(base, "PATCH", `/api/assets/${asset.id}`, {
    cookie: adminCookie,
    body: {
      status: "maintenance",
      assetCode: other.payload.assetCode,
      createdBy: new mongoose.Types.ObjectId().toString(),
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.asset.status, "maintenance");
  assert.equal(res.json.asset.assetCode, asset.assetCode);

  const forbidden = await h.request(base, "PATCH", `/api/assets/${asset.id}`, {
    cookie: userCookie,
    body: { status: "retired" },
  });
  assert.equal(forbidden.status, 403);
});

test("admin can attach a valid ImageKit image to an asset", async () => {
  const assetCode = `T${h.nextId()}`;
  const imageUrl = `${IMAGEKIT_ENV.IMAGEKIT_URL_ENDPOINT}/assets/pump.jpg`;

  const res = await h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: {
      name: "Imaged asset",
      assetCode,
      category: "C",
      location: "L",
      imageUrl,
      imageFileId: "file_pump_1",
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.asset.imageUrl, imageUrl);
  assert.equal(res.json.asset.imageFileId, "file_pump_1");
});

test("asset QR is generated for logged-in users only", async () => {
  const { asset } = await h.createAsset(base, adminCookie);

  let res = await h.request(base, "GET", `/api/assets/${asset.id}/qr`, { cookie: userCookie });
  assert.equal(res.status, 200);
  assert.match(res.json.qrDataUrl, /^data:image\/png;base64,/);
  assert.match(res.json.url, new RegExp(`/assets/${asset.assetCode}$`));

  res = await h.request(base, "GET", `/api/assets/${asset.id}/qr`);
  assert.equal(res.status, 401);
});

test("public QR lookup is minimal and unauthenticated", async () => {
  const { asset } = await h.createAsset(base, adminCookie);

  const res = await h.request(base, "GET", `/api/public/assets/${asset.assetCode}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json.asset).sort(), [
    "assetCode",
    "category",
    "description",
    "imageUrl",
    "location",
    "name",
    "status",
  ]);

  const missing = await h.request(base, "GET", "/api/public/assets/NOPE-NOT-REAL");
  assert.equal(missing.status, 404);
});

test("asset delete is admin-only and returns 404 afterwards", async () => {
  const { asset } = await h.createAsset(base, adminCookie);

  let res = await h.request(base, "DELETE", `/api/assets/${asset.id}`, { cookie: userCookie });
  assert.equal(res.status, 403);

  res = await h.request(base, "DELETE", `/api/assets/${asset.id}`, { cookie: adminCookie });
  assert.equal(res.status, 200);

  res = await h.request(base, "GET", `/api/assets/${asset.id}`, { cookie: adminCookie });
  assert.equal(res.status, 404);
});
