const { IS_PRODUCTION } = require("./env");

// The deployed frontend. Always allowed in production so a misconfigured
// FRONTEND_URL cannot break credentialed requests from the live UI.
// This is a public URL, not a secret.
const PRODUCTION_FRONTEND_URL = "https://maintain-iq-frontend-one.vercel.app";

// Vite dev-server origins; allowed only outside production.
const LOCAL_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const normalizeOrigin = (value) =>
  String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();

const parseOriginList = (value) =>
  String(value || "")
    .split(",")
    .map(normalizeOrigin)
    .filter((origin) => origin && origin !== "*");

// Builds the set of browser origins allowed to call the API with credentials.
// Never contains "*": the Fetch spec forbids a wildcard together with
// Access-Control-Allow-Credentials, and an explicit allowlist is required.
const buildAllowedOrigins = ({
  frontendUrl = process.env.FRONTEND_URL,
  extraOrigins = process.env.ALLOWED_ORIGINS,
  isProduction = IS_PRODUCTION,
} = {}) => {
  const origins = new Set();

  const primary = normalizeOrigin(frontendUrl);
  if (primary && primary !== "*") {
    origins.add(primary);
  }

  for (const origin of parseOriginList(extraOrigins)) {
    origins.add(origin);
  }

  if (isProduction) {
    origins.add(normalizeOrigin(PRODUCTION_FRONTEND_URL));
  } else {
    for (const origin of LOCAL_DEV_ORIGINS) {
      origins.add(origin);
    }
  }

  return origins;
};

// CORS options for the Express app. Credentialed requests are only allowed
// from the explicit allowlist; any other Origin simply receives no CORS
// headers, so the browser refuses to share the response (the request itself
// is not blocked, which keeps non-browser clients unaffected). Requests
// without an Origin header (curl, server-to-server) are always allowed.
const createCorsOptions = (allowedOrigins) => ({
  credentials: true,
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    return callback(null, allowedOrigins.has(normalizeOrigin(origin)));
  },
});

const corsOptions = createCorsOptions(buildAllowedOrigins());

module.exports = {
  PRODUCTION_FRONTEND_URL,
  LOCAL_DEV_ORIGINS,
  normalizeOrigin,
  buildAllowedOrigins,
  createCorsOptions,
  corsOptions,
};
