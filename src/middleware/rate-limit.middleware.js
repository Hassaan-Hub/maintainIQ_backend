const rateLimit = require("express-rate-limit");

// Builds an IP-based rate limiter for the auth endpoints (register and login).
// Each call returns a fresh limiter with its own in-memory store, so different
// routes can use different windows/limits if needed.
//
// `max` is accepted as an alias for express-rate-limit v7+'s `limit` option so
// callers can use either name.
const createAuthLimiter = ({
  windowMs,
  max,
  limit,
  skipSuccessfulRequests = false,
} = {}) =>
  rateLimit({
    windowMs,
    limit: limit === undefined ? max : limit,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 429,
    message: { message: "Too many attempts. Please try again later." },
  });

module.exports = { createAuthLimiter, createRateLimiter: createAuthLimiter };
