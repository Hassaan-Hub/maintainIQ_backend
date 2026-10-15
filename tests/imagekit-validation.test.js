const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const h = require("./helpers/harness");
const imagekit = require("../src/config/imagekit");

// A fixed, test-only endpoint. Every test runs against this value; the real
// environment is saved before and restored after the file.
const IMAGEKIT_ENV = {
  IMAGEKIT_PUBLIC_KEY: "ik_public_test",
  IMAGEKIT_PRIVATE_KEY: "ik_private_test",
  IMAGEKIT_URL_ENDPOINT: "https://ik.imagekit.io/maintainiq_test",
};
const ENDPOINT = IMAGEKIT_ENV.IMAGEKIT_URL_ENDPOINT;
const savedImagekitEnv = {};

let server;
let base;
let adminCookie;

// ImageKit deletion is mocked at the module boundary (no network). The mock
// records each call so tests can assert exactly which files were deleted.
const originalDeleteFile = imagekit.deleteFile;
let deleteCalls = [];
let deleteImpl;

const applyImagekitEnv = () => {
  for (const key of Object.keys(IMAGEKIT_ENV)) {
    process.env[key] = IMAGEKIT_ENV[key];
  }
};

const clearImagekitEnv = () => {
  for (const key of Object.keys(IMAGEKIT_ENV)) {
    delete process.env[key];
  }
};

// Lets queued microtasks (the fire-and-forget delete) run before assertions.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const createAsset = (body = {}) =>
  h.request(base, "POST", "/api/assets", {
    cookie: adminCookie,
    body: {
      name: "Image asset",
      assetCode: `T${h.nextId()}`,
      category: "General",
      location: "Room 1",
      ...body,
    },
  });

const patchAsset = (id, body) =>
  h.request(base, "PATCH", `/api/assets/${id}`, { cookie: adminCookie, body });

before(async () => {
  for (const key of Object.keys(IMAGEKIT_ENV)) {
    savedImagekitEnv[key] = process.env[key];
  }
  applyImagekitEnv();

  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
});

beforeEach(() => {
  deleteCalls = [];
  deleteImpl = async () => ({ ok: true, status: 204 });
  imagekit.deleteFile = async (fileId) => {
    deleteCalls.push(fileId);
    return deleteImpl(fileId);
  };
});

after(async () => {
  imagekit.deleteFile = originalDeleteFile;

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

test("accepts a valid ImageKit URL together with a file id", async () => {
  const imageUrl = `${ENDPOINT}/assets/pump.jpg`;
  const res = await createAsset({ imageUrl, imageFileId: "file_abc-123_XYZ" });

  assert.equal(res.status, 201);
  assert.equal(res.json.asset.imageUrl, imageUrl);
  assert.equal(res.json.asset.imageFileId, "file_abc-123_XYZ");
  assert.equal(deleteCalls.length, 0);
});

test("rejects an http (non-https) URL", async () => {
  const res = await createAsset({
    imageUrl: "http://ik.imagekit.io/maintainiq_test/assets/pump.jpg",
  });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /https/i);
});

test("rejects a URL on a different host", async () => {
  const res = await createAsset({ imageUrl: "https://example.com/assets/pump.jpg" });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /ImageKit endpoint/i);
});

test('rejects "https://ik.imagekit.io.evil.com/..." (suffix host)', async () => {
  const res = await createAsset({
    imageUrl: "https://ik.imagekit.io.evil.com/assets/pump.jpg",
  });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /ImageKit endpoint/i);
});

test('rejects "https://ik.imagekit.io@evil.com/..." (credentials)', async () => {
  const res = await createAsset({
    imageUrl: "https://ik.imagekit.io@evil.com/assets/pump.jpg",
  });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /credentials/i);
});

test("rejects a host whose path shares the endpoint prefix (path trick)", async () => {
  const res = await createAsset({
    imageUrl: "https://ik.imagekit.io/maintainiq_test_evil/assets/pump.jpg",
  });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /ImageKit endpoint/i);
});

test("accepts a URL nested under the endpoint path", async () => {
  const imageUrl = `${ENDPOINT}/nested/deep/pump.jpg`;
  const res = await createAsset({ imageUrl });

  assert.equal(res.status, 201);
  assert.equal(res.json.asset.imageUrl, imageUrl);
});

test("rejects a non-string imageUrl", async () => {
  const res = await createAsset({ imageUrl: 123 });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /imageUrl must be a string/i);
});

test("rejects a non-string imageFileId", async () => {
  const res = await createAsset({
    imageUrl: `${ENDPOINT}/assets/pump.jpg`,
    imageFileId: 42,
  });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /imageFileId must be a string/i);
});

test("rejects an imageFileId without an imageUrl", async () => {
  const res = await createAsset({ imageFileId: "file_only" });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /non-empty imageUrl/i);
});

test("rejects an imageFileId with invalid characters", async () => {
  const res = await createAsset({
    imageUrl: `${ENDPOINT}/assets/pump.jpg`,
    imageFileId: "file bad id!",
  });

  assert.equal(res.status, 400);
  assert.match(res.json.message, /imageFileId may only contain/i);
});

test("accepts empty image fields (no image)", async () => {
  const res = await createAsset({ imageUrl: "", imageFileId: "" });

  assert.equal(res.status, 201);
  assert.equal(res.json.asset.imageUrl, "");
  assert.equal(res.json.asset.imageFileId, "");
  assert.equal(deleteCalls.length, 0);
});

test("clearing the image deletes the stored file exactly once", async () => {
  const created = await createAsset({
    imageUrl: `${ENDPOINT}/assets/old.jpg`,
    imageFileId: "file_old",
  });
  assert.equal(created.status, 201);
  const id = created.json.asset.id;

  deleteCalls = [];
  const res = await patchAsset(id, { imageUrl: "", imageFileId: "" });

  assert.equal(res.status, 200);
  assert.equal(res.json.asset.imageUrl, "");
  assert.equal(res.json.asset.imageFileId, "");
  await flush();
  assert.deepEqual(deleteCalls, ["file_old"]);
});

test("replacing the image deletes the OLD file id", async () => {
  const created = await createAsset({
    imageUrl: `${ENDPOINT}/assets/old.jpg`,
    imageFileId: "file_old",
  });
  assert.equal(created.status, 201);
  const id = created.json.asset.id;

  deleteCalls = [];
  const res = await patchAsset(id, {
    imageUrl: `${ENDPOINT}/assets/new.jpg`,
    imageFileId: "file_new",
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.asset.imageFileId, "file_new");
  await flush();
  assert.deepEqual(deleteCalls, ["file_old"]);
});

test("deleting an asset with an image deletes its file", async () => {
  const created = await createAsset({
    imageUrl: `${ENDPOINT}/assets/gone.jpg`,
    imageFileId: "file_gone",
  });
  assert.equal(created.status, 201);
  const id = created.json.asset.id;

  deleteCalls = [];
  const res = await h.request(base, "DELETE", `/api/assets/${id}`, {
    cookie: adminCookie,
  });

  assert.equal(res.status, 200);
  await flush();
  assert.deepEqual(deleteCalls, ["file_gone"]);
});

test("a failing ImageKit delete does not break the response", async () => {
  const created = await createAsset({
    imageUrl: `${ENDPOINT}/assets/boom.jpg`,
    imageFileId: "file_boom",
  });
  assert.equal(created.status, 201);
  const id = created.json.asset.id;

  deleteCalls = [];
  deleteImpl = async () => {
    throw new Error("ImageKit delete exploded");
  };

  const res = await patchAsset(id, { imageUrl: "", imageFileId: "" });

  assert.equal(res.status, 200);
  assert.equal(res.json.asset.imageFileId, "");
  await flush();
  assert.deepEqual(deleteCalls, ["file_boom"]);
});

test("never accepts a non-empty imageUrl when ImageKit is not configured", async () => {
  clearImagekitEnv();
  try {
    const res = await createAsset({ imageUrl: `${ENDPOINT}/assets/pump.jpg` });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /not configured/i);
  } finally {
    applyImagekitEnv();
  }
});

test("accepts empty image fields even when ImageKit is not configured", async () => {
  clearImagekitEnv();
  try {
    const res = await createAsset({ imageUrl: "", imageFileId: "" });
    assert.equal(res.status, 201);
    assert.equal(res.json.asset.imageUrl, "");
  } finally {
    applyImagekitEnv();
  }
});
