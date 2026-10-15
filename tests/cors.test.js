const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// This file runs in its own process under `node --test`, so the environment is
// configured BEFORE the app (and its module-load-time CORS options) is
// required. It simulates the deployed setup: FRONTEND_URL points at the live
// frontend; NODE_ENV stays non-production so the local Vite origins are also
// allowed (the production-only branch is covered by the unit tests below).
const PRODUCTION_ORIGIN = "https://maintain-iq-frontend-one.vercel.app";
process.env.FRONTEND_URL = PRODUCTION_ORIGIN;
delete process.env.ALLOWED_ORIGINS;

const {
  PRODUCTION_FRONTEND_URL,
  LOCAL_DEV_ORIGINS,
  normalizeOrigin,
  buildAllowedOrigins,
  createCorsOptions,
} = require("../src/config/cors");
const app = require("../src/app");

// ---------------------------------------------------------------------------
// Unit tests: the allowlist builder (pure function, explicit inputs).
// ---------------------------------------------------------------------------

test("normalizeOrigin trims, lowercases and strips trailing slashes", () => {
  assert.equal(normalizeOrigin("  https://A.Example.com// "), "https://a.example.com");
  assert.equal(normalizeOrigin(undefined), "");
});

test("production allowlist contains the configured and the live frontend origin", () => {
  const origins = buildAllowedOrigins({
    frontendUrl: "https://other-frontend.example.com",
    extraOrigins: "",
    isProduction: true,
  });
  assert.ok(origins.has("https://other-frontend.example.com"));
  assert.ok(origins.has(normalizeOrigin(PRODUCTION_FRONTEND_URL)));
});

test("production allowlist does not include local dev origins", () => {
  const origins = buildAllowedOrigins({
    frontendUrl: PRODUCTION_FRONTEND_URL,
    extraOrigins: "",
    isProduction: true,
  });
  for (const origin of LOCAL_DEV_ORIGINS) {
    assert.ok(!origins.has(origin), `production must not allow ${origin}`);
  }
});

test("a wrong FRONTEND_URL in production still keeps the live frontend allowed", () => {
  const origins = buildAllowedOrigins({
    frontendUrl: "http://localhost:5173",
    extraOrigins: "",
    isProduction: true,
  });
  assert.ok(origins.has(normalizeOrigin(PRODUCTION_FRONTEND_URL)));
});

test("non-production allowlist includes the local Vite origins", () => {
  const origins = buildAllowedOrigins({
    frontendUrl: PRODUCTION_FRONTEND_URL,
    extraOrigins: "",
    isProduction: false,
  });
  for (const origin of LOCAL_DEV_ORIGINS) {
    assert.ok(origins.has(origin), `dev must allow ${origin}`);
  }
});

test("ALLOWED_ORIGINS adds extra origins and drops empties, spaces and wildcards", () => {
  const origins = buildAllowedOrigins({
    frontendUrl: PRODUCTION_FRONTEND_URL,
    extraOrigins: " https://staging.example.com , *, ,http://localhost:4173",
    isProduction: true,
  });
  assert.ok(origins.has("https://staging.example.com"));
  assert.ok(origins.has("http://localhost:4173"));
  assert.ok(!origins.has("*"));
  assert.ok(!origins.has(""));
});

test("FRONTEND_URL is never allowed as a wildcard either", () => {
  const origins = buildAllowedOrigins({
    frontendUrl: "*",
    extraOrigins: "",
    isProduction: false,
  });
  assert.ok(!origins.has("*"));
});

// ---------------------------------------------------------------------------
// Unit tests: the cors origin callback (allowed / disallowed / no origin).
// ---------------------------------------------------------------------------

test("origin callback allows allowlisted origins and rejects others", async () => {
  const options = createCorsOptions(new Set([PRODUCTION_ORIGIN]));
  const decide = (origin) =>
    new Promise((resolve, reject) => {
      options.origin(origin, (err, allowed) => (err ? reject(err) : resolve(allowed)));
    });
  assert.equal(await decide(PRODUCTION_ORIGIN), true);
  assert.equal(await decide("https://evil.example.com"), false);
  assert.equal(await decide(undefined), true); // non-browser / same-origin
});

// ---------------------------------------------------------------------------
// Integration tests: real CORS headers on the running app (dev-mode config).
// ---------------------------------------------------------------------------

const PORT = 3101;
let server;

before(async () => {
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(PORT, () => resolve(instance));
    instance.once("error", reject);
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const rawRequest = (method, path, { headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, method, path, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });

test("allowed origin (live frontend) gets Access-Control-Allow-Origin + credentials", async () => {
  const res = await rawRequest("GET", "/api/health", {
    headers: { Origin: PRODUCTION_ORIGIN },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], PRODUCTION_ORIGIN);
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.notEqual(res.headers["access-control-allow-origin"], "*");
});

test("local Vite origin is allowed in development", async () => {
  const res = await rawRequest("GET", "/api/health", {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});

test("a disallowed origin gets no CORS headers (browser will block)", async () => {
  const res = await rawRequest("GET", "/api/health", {
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
});

test("preflight OPTIONS from an allowed origin returns 204 with CORS headers", async () => {
  const res = await rawRequest("OPTIONS", "/api/auth/login", {
    headers: {
      Origin: PRODUCTION_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], PRODUCTION_ORIGIN);
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.ok(
    String(res.headers["access-control-allow-methods"]).includes("POST"),
    "preflight must allow POST"
  );
  assert.ok(
    String(res.headers["access-control-allow-headers"]).includes("content-type"),
    "preflight must allow the content-type header"
  );
});

test("preflight OPTIONS from a disallowed origin gets no CORS approval", async () => {
  const res = await rawRequest("OPTIONS", "/api/auth/login", {
    headers: {
      Origin: "https://evil.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
});
