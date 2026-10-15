// Loaded before the app (via `node --require` in the test script and from the
// test harness) so the auth rate limiter does not throttle the many
// login/register calls the suite makes from 127.0.0.1.
//
// Rate limiting stays ENABLED during tests; only the ceiling is raised so the
// suite itself is not limited. A dedicated test exercises the limiter with its
// own low limit.
if (!process.env.AUTH_RATE_LIMIT_MAX) {
  process.env.AUTH_RATE_LIMIT_MAX = "1000000";
}

if (!process.env.AUTH_RATE_LIMIT_WINDOW_MS) {
  process.env.AUTH_RATE_LIMIT_WINDOW_MS = "60000";
}

// Same idea for the register and public endpoints, which the suite also calls
// many times from 127.0.0.1.
if (!process.env.REGISTER_RATE_LIMIT_MAX) {
  process.env.REGISTER_RATE_LIMIT_MAX = "1000000";
}

if (!process.env.PUBLIC_RATE_LIMIT_MAX) {
  process.env.PUBLIC_RATE_LIMIT_MAX = "1000000";
}

// Same for the image-upload signature endpoint, which the suite also calls.
if (!process.env.UPLOAD_RATE_LIMIT_MAX) {
  process.env.UPLOAD_RATE_LIMIT_MAX = "1000000";
}
