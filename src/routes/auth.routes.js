const express = require("express");
const {
  registerUser,
  loginUser,
  getCurrentUser,
  logoutUser,
} = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { createAuthLimiter } = require("../middleware/rate-limit.middleware");

const router = express.Router();

// Rate-limit the credential endpoints to slow down brute-force attempts. The
// windows/ceilings are configurable via env.

// Login: 15 minutes / 20 failed attempts per IP by default. Successful logins
// are not counted, so only repeated failures trigger the limit.
const AUTH_RATE_LIMIT_WINDOW_MS =
  parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20;

// Register: 1 hour / 10 attempts per IP by default (account creation is rarer).
const REGISTER_RATE_LIMIT_WINDOW_MS =
  parseInt(process.env.REGISTER_RATE_LIMIT_WINDOW_MS, 10) || 60 * 60 * 1000;
const REGISTER_RATE_LIMIT_MAX =
  parseInt(process.env.REGISTER_RATE_LIMIT_MAX, 10) || 10;

const loginLimiter = createAuthLimiter({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
});

const registerLimiter = createAuthLimiter({
  windowMs: REGISTER_RATE_LIMIT_WINDOW_MS,
  max: REGISTER_RATE_LIMIT_MAX,
});

// POST /api/auth/register - creates a new user account.
router.post("/register", registerLimiter, registerUser);

// POST /api/auth/login - verifies credentials and sets the auth cookie.
router.post("/login", loginLimiter, loginUser);

// GET /api/auth/me - returns the logged-in user (requires authentication).
router.get("/me", requireAuth, getCurrentUser);

// POST /api/auth/logout - clears the auth cookie.
router.post("/logout", logoutUser);

module.exports = router;
