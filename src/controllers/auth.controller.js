const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { AUTH_COOKIE } = require("../middleware/auth.middleware");

// Cost factor used when hashing passwords (higher = slower but stronger).
const SALT_ROUNDS = 10;

// Basic email shape check: something@something.something with no spaces. The
// length is capped first (see MAX_EMAIL_LENGTH) so a huge string cannot make
// this regex do unnecessary work.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple input limits so we accept reasonable values and reject silly ones.
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 30;
const MAX_EMAIL_LENGTH = 254;
// Password policy for NEW passwords: at least 8 characters and at most 72
// (bcrypt only considers the first 72 bytes, so longer inputs are rejected).
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

// A throwaway hash used for comparison when the email is unknown. Comparing
// against it keeps the login response time roughly constant whether or not the
// account exists, so timing cannot reveal which emails are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  crypto.randomBytes(32).toString("hex"),
  SALT_ROUNDS
);

// Builds the shared cookie options. `httpOnly` keeps the token away from
// JavaScript, and `secure` is enabled only in production so local HTTP works.
const getCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
});

// Picks only the safe, non-sensitive user fields so the password hash is
// never included in an API response.
const toSafeUser = (user) => ({
  id: user._id,
  username: user.username,
  email: user.email,
  role: user.role,
});

// Handles POST /api/auth/register: validates input, rejects duplicate
// username/email, hashes the password, and creates the user without ever
// returning the password or its hash.
const registerUser = async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    const cleanUsername = typeof username === "string" ? username.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const cleanPassword = typeof password === "string" ? password : "";

    if (!cleanUsername || !cleanEmail || !cleanPassword) {
      return res
        .status(400)
        .json({ message: "username, email and password are required." });
    }

    if (
      cleanUsername.length < MIN_USERNAME_LENGTH ||
      cleanUsername.length > MAX_USERNAME_LENGTH
    ) {
      return res.status(400).json({
        message: `username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`,
      });
    }

    if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({ message: "Please provide a valid email address." });
    }

    if (cleanPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    if (cleanPassword.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
      });
    }

    const existingUser = await User.findOne({
      $or: [{ username: cleanUsername }, { email: cleanEmail }],
    });

    if (existingUser) {
      return res.status(409).json({ message: "Username or email already in use." });
    }

    const hashedPassword = await bcrypt.hash(cleanPassword, SALT_ROUNDS);

    // role is omitted on purpose: it always defaults to "user" so public
    // registration can never create an admin.
    const newUser = await User.create({
      username: cleanUsername,
      email: cleanEmail,
      password: hashedPassword,
    });

    return res.status(201).json({
      message: "User registered successfully.",
      user: toSafeUser(newUser),
    });
  } catch (error) {
    // A duplicate key error can still happen if two requests race past the
    // check above, so translate it to the same 409 response.
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "Username or email already in use." });
    }

    console.error("registerUser failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles POST /api/auth/login: verifies the credentials, then signs a JWT
// and stores it in an HttpOnly cookie. The same generic message is returned
// whether the email or the password was wrong.
const loginUser = async (req, res) => {
  try {
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.error("loginUser failed: JWT_SECRET is not set.");
      return res.status(500).json({ message: "Authentication is not configured." });
    }

    const { email, password } = req.body || {};

    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const cleanPassword = typeof password === "string" ? password : "";

    if (!cleanEmail || !cleanPassword) {
      return res.status(400).json({ message: "email and password are required." });
    }

    // password is select:false on the schema, so request it explicitly here.
    const user = await User.findOne({ email: cleanEmail }).select("+password");

    if (!user) {
      // Compare against a dummy hash so an unknown email costs the same as a
      // wrong password and cannot be told apart by response timing.
      await bcrypt.compare(cleanPassword, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const isPasswordValid = await bcrypt.compare(cleanPassword, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const token = jwt.sign(
      { sub: user._id.toString(), role: user.role },
      secret,
      {
        algorithm: "HS256",
        expiresIn: process.env.JWT_EXPIRES_IN || "1d",
      }
    );

    // Match the cookie lifetime to the token's own expiry rather than a fixed
    // constant, so the two can never drift apart.
    const { exp } = jwt.decode(token);
    res.cookie(AUTH_COOKIE, token, {
      ...getCookieOptions(),
      maxAge: exp * 1000 - Date.now(),
    });

    return res.status(200).json({
      message: "Logged in successfully.",
      user: toSafeUser(user),
    });
  } catch (error) {
    console.error("loginUser failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/auth/me: relies on requireAuth, then re-checks that the
// user still exists in MongoDB before returning their safe details.
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(401).json({ message: "Authentication required." });
    }

    return res.status(200).json({ user: toSafeUser(user) });
  } catch (error) {
    // An invalid stored id (e.g. from an old token) should look like a bad
    // login, not a server error.
    if (error && error.name === "CastError") {
      return res.status(401).json({ message: "Authentication required." });
    }

    console.error("getCurrentUser failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles POST /api/auth/logout: clears the auth cookie. This removes the
// token from the browser; it does not revoke a token that was already copied.
const logoutUser = (req, res) => {
  res.clearCookie(AUTH_COOKIE, getCookieOptions());
  return res.status(200).json({ message: "Logged out successfully." });
};

module.exports = { registerUser, loginUser, getCurrentUser, logoutUser };
