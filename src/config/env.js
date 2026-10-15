// True in a real production deployment.
//
// NODE_ENV is the primary switch (set it to "production" in the hosting
// environment). VERCEL_ENV is also checked as a safety net: Vercel sets it to
// "production" for production deployments, so the CORS origin, the JWT-secret
// strength check and the cross-site auth cookie are enforced there even if
// NODE_ENV was left at its default value.
const IS_PRODUCTION =
  process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

module.exports = { IS_PRODUCTION };
