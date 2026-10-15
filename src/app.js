const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/auth.routes");
const assetRoutes = require("./routes/asset.routes");
const maintenanceRequestRoutes = require("./routes/maintenance-request.routes");
const userRoutes = require("./routes/user.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const publicRoutes = require("./routes/public.routes");
const uploadRoutes = require("./routes/upload.routes");
const { corsOptions } = require("./config/cors");
const { IS_PRODUCTION } = require("./config/env");

const app = express();

// Do not advertise the framework in response headers.
app.disable("x-powered-by");

// In production the public frontend origin must be configured explicitly.
if (IS_PRODUCTION && !process.env.FRONTEND_URL) {
  throw new Error("FRONTEND_URL must be set in production.");
}

// A strong JWT secret is mandatory in production; elsewhere a short secret only
// produces a warning. The secret value itself is never printed.
if (IS_PRODUCTION) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be set (at least 32 characters) in production.");
  }
} else if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.warn("JWT_SECRET is shorter than 32 characters; use a longer secret in production.");
}

// Allow only known frontend origins (see src/config/cors.js: FRONTEND_URL,
// the live frontend in production, plus optional ALLOWED_ORIGINS extras) and
// let them send/receive the auth cookie. Never a wildcard, because credentials
// are required. Preflight OPTIONS requests are answered by the cors middleware.
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Sends a simple health status so we can check that the server is running.
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "MaintainIQ backend is running." });
});

app.use("/api/auth", authRoutes);
app.use("/api/assets", assetRoutes);
app.use("/api/maintenance-requests", maintenanceRequestRoutes);
app.use("/api/users", userRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/uploads", uploadRoutes);

// Any request that reaches here did not match a route.
app.use((req, res) => {
  res.status(404).json({ message: "Route not found." });
});

// Central error handler. Bad JSON from the client becomes a 400; everything
// else becomes a generic 500 so stack traces and internals never leak.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON payload." });
  }

  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large." });
  }

  console.error("Unhandled error:", error && error.message);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
});

module.exports = app;