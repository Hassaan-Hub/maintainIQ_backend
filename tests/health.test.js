const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/harness");

let base;
let server;

before(async () => {
  await h.connectTestDatabase();
  ({ server, base } = await h.startTestServer());
});

after(async () => {
  await h.cleanup();
  await h.stopTestServer(server);
  await h.disconnectTestDatabase();
});

test("GET /api/health returns ok", async () => {
  const res = await h.request(base, "GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "ok");
});

test("unknown route returns a JSON 404", async () => {
  const res = await h.request(base, "GET", "/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.ok(res.json.message);
});

test("malformed JSON body returns 400", async () => {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ not valid json ",
  });
  assert.equal(response.status, 400);
});
