const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const app = require("../src/app");

// This file exercises only header/body-parser/error-handler behaviour, so it
// needs no database. It binds to the previously-used isolated test port.
const PORT = 3100;
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

// Minimal raw HTTP helper built on the core http module (no dependencies).
const rawRequest = (method, path, { headers = {}, body } = {}) =>
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
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

test("GET /api/health returns 200", async () => {
  const res = await rawRequest("GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).status, "ok");
});

test("an unknown route returns a JSON 404", async () => {
  const res = await rawRequest("GET", "/api/definitely-not-a-route");
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { message: "Route not found." });
});

test("malformed JSON returns 400 Invalid JSON payload", async () => {
  const res = await rawRequest("POST", "/api/auth/login", {
    headers: { "Content-Type": "application/json" },
    body: "{ not valid json ",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { message: "Invalid JSON payload." });
});

test("a JSON body larger than 1mb returns 413", async () => {
  const res = await rawRequest("POST", "/api/auth/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a".repeat(1_100_000) }),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.body), { message: "Request body is too large." });
});

test("responses do not include an x-powered-by header", async () => {
  const res = await rawRequest("GET", "/api/health");
  assert.equal(res.headers["x-powered-by"], undefined);
});
