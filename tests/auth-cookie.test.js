const { test } = require("node:test");
const assert = require("node:assert/strict");

// Loads only the auth controller (no app/database), so the cookie options can
// be checked for both environments. The live frontend and backend are on
// different Vercel subdomains, which browsers treat as different sites, so the
// production cookie MUST be Secure + SameSite=None or the browser drops it and
// every request after login comes back 401.
const { getCookieOptions } = require("../src/controllers/auth.controller");

test("production cookie is HttpOnly, Secure and SameSite=None (cross-site)", () => {
  assert.deepEqual(getCookieOptions(true), {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });
});

test("development cookie is HttpOnly but not Secure and SameSite=Lax (local HTTP)", () => {
  assert.deepEqual(getCookieOptions(false), {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
  });
});

test("SameSite=None is always paired with Secure (required by browsers)", () => {
  const prod = getCookieOptions(true);
  assert.equal(prod.sameSite, "none");
  assert.equal(
    prod.secure,
    true,
    "SameSite=None without Secure is rejected by browsers"
  );
});
