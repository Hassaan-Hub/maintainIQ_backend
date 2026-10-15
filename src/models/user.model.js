const mongoose = require("mongoose");

// All roles a MaintainIQ user can hold. "user" is a regular reporter,
// "technician" can be assigned work, and "admin" manages everything.
const USER_ROLES = ["user", "technician", "admin"];

// Describes a MaintainIQ user: a unique username and email, a password
// (stored hashed) and a role. Public registration always creates a "user";
// privileged roles are only granted through the admin user endpoints.
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
      // Never returned by queries unless explicitly requested with +password.
      select: false,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      default: "user",
    },
  },
  { timestamps: true }
);

// Compiles the schema into the "User" model and exports it. The role list is
// exposed as a static so controllers can reuse it for validation.
const User = mongoose.model("User", userSchema);
User.USER_ROLES = USER_ROLES;

module.exports = User;
