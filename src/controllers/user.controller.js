const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/user.model");

// Reuses the same hashing cost as registration so all passwords are stored
// with one consistent policy.
const SALT_ROUNDS = 10;

// Basic email shape check: something@something.something with no spaces.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple input limits matching the registration rules.
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 30;
const MAX_EMAIL_LENGTH = 254;
// New-password policy matching registration: 8 to 72 characters.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

// Valid roles, taken straight from the schema so there is one source of truth.
const USER_ROLES = User.USER_ROLES;

// Escapes regex special characters so user search text cannot break the query.
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Picks only the safe, non-sensitive user fields so the password hash is
// never included in an API response.
const toSafeUser = (user) => ({
  id: user._id,
  username: user.username,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt,
});

// Handles POST /api/users: admins create accounts of any role (for example a
// technician). The password is hashed and never returned.
const createUser = async (req, res) => {
  try {
    const body = req.body || {};

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role === undefined ? "user" : body.role;

    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ message: "username, email and password are required." });
    }

    if (
      username.length < MIN_USERNAME_LENGTH ||
      username.length > MAX_USERNAME_LENGTH
    ) {
      return res.status(400).json({
        message: `username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`,
      });
    }

    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Please provide a valid email address." });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
      });
    }

    if (!USER_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ message: `role must be one of: ${USER_ROLES.join(", ")}.` });
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    });
    if (existingUser) {
      return res.status(409).json({ message: "Username or email already in use." });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = await User.create({
      username,
      email,
      password: hashedPassword,
      role,
    });

    return res.status(201).json({
      message: "User created successfully.",
      user: toSafeUser(newUser),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "Username or email already in use." });
    }

    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid user data." });
    }

    console.error("createUser failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/users: admins page through accounts and can filter by role
// or search by username/email. Only safe fields are returned.
const listUsers = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);

    const filter = {};
    if (USER_ROLES.includes(req.query.role)) {
      filter.role = req.query.role;
    }
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), "i");
      filter.$or = [{ username: rx }, { email: rx }];
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      users: users.map(toSafeUser),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("listUsers failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles PATCH /api/users/:id/role: admins change a user's role. An admin
// cannot change their own role, which avoids accidental lock-out.
const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    const body = req.body || {};
    if (!USER_ROLES.includes(body.role)) {
      return res
        .status(400)
        .json({ message: `role must be one of: ${USER_ROLES.join(", ")}.` });
    }

    if (id === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot change your own role." });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Compare on the canonical id too: the :id param may be an uppercase hex
    // string that is a different string but the same user, which would slip
    // past the exact-match check above.
    if (String(user._id) === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot change your own role." });
    }

    user.role = body.role;
    await user.save();

    return res.status(200).json({
      message: "User role updated successfully.",
      user: toSafeUser(user),
    });
  } catch (error) {
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid role." });
    }

    console.error("updateUserRole failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

module.exports = { createUser, listUsers, updateUserRole };
