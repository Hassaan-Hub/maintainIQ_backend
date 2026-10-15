const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const h = require("./helpers/harness");
const imagekit = require("../src/config/imagekit");

// The ImageKit env keys are saved and restored so this file never leaks config
// into other test files (they run one file at a time, but be tidy anyway).
const ENV_KEYS = [
  "IMAGEKIT_PUBLIC_KEY",
  "IMAGEKIT_PRIVATE_KEY",
  "IMAGEKIT_URL_ENDPOINT",
  "IMAGEKIT_UPLOAD_FOLDER",
];
const originalEnv = {};

let server;
let base;
let adminCookie;
let userCookie;

const setImageKitEnv = ({
  publicKey = "ik_public_test",
  privateKey = "ik_private_test",
  urlEndpoint = "https://ik.imagekit.io/maintainiq_test",
  folder,
} = {}) => {
  process.env.IMAGEKIT_PUBLIC_KEY = publicKey;
  process.env.IMAGEKIT_PRIVATE_KEY = privateKey;
  process.env.IMAGEKIT_URL_ENDPOINT = urlEndpoint;
  if (folder === undefined) {
    delete process.env.IMAGEKIT_UPLOAD_FOLDER;
  } else {
    process.env.IMAGEKIT_UPLOAD_FOLDER = folder;
  }
};

const clearImageKitEnv = () => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
};

before(async () => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }

  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
  adminCookie = (await h.createAndLogin(base, "admin")).cookie;
  userCookie = (await h.createAndLogin(base, "user")).cookie;
});

after(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("isConfigured reflects whether all required keys are present", () => {
  clearImageKitEnv();
  assert.equal(imagekit.isConfigured(), false);

  setImageKitEnv();
  assert.equal(imagekit.isConfigured(), true);

  delete process.env.IMAGEKIT_PRIVATE_KEY;
  assert.equal(imagekit.isConfigured(), false);

  clearImageKitEnv();
});

test("getAuthParams returns a verifiable HMAC-SHA1 signature valid for under an hour", () => {
  setImageKitEnv({ privateKey: "secret_key" });

  const params = imagekit.getAuthParams();
  const expectedSignature = crypto
    .createHmac("sha1", "secret_key")
    .update(`${params.token}${params.expire}`)
    .digest("hex");

  assert.equal(params.signature, expectedSignature);
  assert.match(params.token, /^[0-9a-f-]{36}$/);
  assert.equal(params.publicKey, "ik_public_test");
  assert.equal(params.uploadUrl, "https://upload.imagekit.io/api/v1/files/upload");

  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.ok(params.expire > nowSeconds, "expire should be in the future");
  assert.ok(
    params.expire <= nowSeconds + 60 * 60,
    "expire should be less than an hour ahead"
  );

  clearImageKitEnv();
});

test("getAuthParams uses a unique token on every call", () => {
  setImageKitEnv();
  const first = imagekit.getAuthParams();
  const second = imagekit.getAuthParams();
  assert.notEqual(first.token, second.token);
  clearImageKitEnv();
});

test("getAuthParams honours a custom upload folder", () => {
  setImageKitEnv({ folder: "/custom/folder" });
  assert.equal(imagekit.getAuthParams().folder, "/custom/folder");
  clearImageKitEnv();
});

test("deleteFile sends a DELETE with Basic auth and reports a 204 as success", async () => {
  setImageKitEnv({ privateKey: "priv_key" });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { status: 204 };
  };

  try {
    const result = await imagekit.deleteFile("file_abc123");

    assert.equal(result.ok, true);
    assert.equal(result.status, 204);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.imagekit.io/v1/files/file_abc123"
    );
    assert.equal(calls[0].options.method, "DELETE");
    assert.equal(
      calls[0].options.headers.Authorization,
      "Basic " + Buffer.from("priv_key:").toString("base64")
    );
  } finally {
    global.fetch = originalFetch;
    clearImageKitEnv();
  }
});

test("deleteFile reports a non-204 response as failure without throwing", async () => {
  setImageKitEnv({ privateKey: "priv_key" });

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ status: 404 });
    const result = await imagekit.deleteFile("missing_file");

    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  } finally {
    global.fetch = originalFetch;
    clearImageKitEnv();
  }
});

test("deleteFile swallows network errors and returns a failure", async () => {
  setImageKitEnv({ privateKey: "priv_key" });

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error("network down");
    };
    const result = await imagekit.deleteFile("file_x");

    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
  } finally {
    global.fetch = originalFetch;
    clearImageKitEnv();
  }
});

test("deleteFile is a no-op when no private key or file id is given", async () => {
  clearImageKitEnv();

  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    return { status: 204 };
  };

  try {
    assert.equal((await imagekit.deleteFile("file_x")).ok, false);

    setImageKitEnv();
    assert.equal((await imagekit.deleteFile("")).ok, false);
    assert.equal(called, false, "fetch must not be called without config");
  } finally {
    global.fetch = originalFetch;
    clearImageKitEnv();
  }
});

test("GET /api/uploads/auth requires authentication", async () => {
  setImageKitEnv();

  const res = await h.request(base, "GET", "/api/uploads/auth");
  assert.equal(res.status, 401);

  clearImageKitEnv();
});

test("GET /api/uploads/auth is admin-only", async () => {
  setImageKitEnv();

  const res = await h.request(base, "GET", "/api/uploads/auth", {
    cookie: userCookie,
  });
  assert.equal(res.status, 403);

  clearImageKitEnv();
});

test("GET /api/uploads/auth returns 503 when ImageKit is not configured", async () => {
  clearImageKitEnv();

  const res = await h.request(base, "GET", "/api/uploads/auth", {
    cookie: adminCookie,
  });

  assert.equal(res.status, 503);
  assert.equal(typeof res.json.message, "string");
});

test("GET /api/uploads/auth returns signed params to an admin when configured", async () => {
  setImageKitEnv({ privateKey: "route_secret" });

  const res = await h.request(base, "GET", "/api/uploads/auth", {
    cookie: adminCookie,
  });

  assert.equal(res.status, 200);
  assert.ok(res.json.upload, "response should wrap params in `upload`");

  const { upload } = res.json;
  const expectedSignature = crypto
    .createHmac("sha1", "route_secret")
    .update(`${upload.token}${upload.expire}`)
    .digest("hex");

  assert.equal(upload.signature, expectedSignature);
  assert.equal(upload.publicKey, "ik_public_test");
  assert.equal(upload.urlEndpoint, "https://ik.imagekit.io/maintainiq_test");
  assert.equal(upload.uploadUrl, "https://upload.imagekit.io/api/v1/files/upload");
  assert.ok(upload.expire > Math.floor(Date.now() / 1000));

  clearImageKitEnv();
});
