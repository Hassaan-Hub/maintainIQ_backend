const jwt = require("jsonwebtoken");
const User = require("../models/user.model");

// Name of the HttpOnly cookie that stores the authentication token. Kept here
// so the controller and middleware always agree on the same cookie name.
const AUTH_COOKIE = "token";

// Guards protected routes: reads the JWT from the auth cookie (or a Bearer
// header for API testing), verifies it, then loads the user's current role from
// MongoDB. The role is never trusted from the token or the request body, so a
// role change (or a deleted account) takes effect immediately.
const requireAuth = async (req, res, next) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error("requireAuth failed: JWT_SECRET is not set.");
    return res.status(500).json({ message: "Authentication is not configured." });
  }

  let token = req.cookies ? req.cookies[AUTH_COOKIE] : null;

  if (!token && typeof req.headers.authorization === "string") {
    const header = req.headers.authorization;
    // Match the scheme case-insensitively ("Bearer", "bearer", ...).
    if (/^bearer /i.test(header)) {
      token = header.slice(7).trim();
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Authentication required." });
  }

  let payload;
  try {
    // Pin the algorithm so a token cannot be forged by switching to "none" or
    // another signing method.
    payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired authentication." });
  }

  try {
    const user = await User.findById(payload.sub).select("role");

    if (!user) {
      return res.status(401).json({ message: "Invalid or expired authentication." });
    }

    // Identity and role come from the database, not the token.
    req.user = { id: String(user._id), role: user.role };
    return next();
  } catch (error) {
    // A malformed id (for example from an old token) is a bad login, not a
    // server error.
    if (error && error.name === "CastError") {
      return res.status(401).json({ message: "Invalid or expired authentication." });
    }

    // Anything else is unexpected: let the central error handler respond.
    return next(error);
  }
};

module.exports = { requireAuth, AUTH_COOKIE };
