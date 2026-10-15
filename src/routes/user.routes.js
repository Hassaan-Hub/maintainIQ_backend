const express = require("express");
const {
  createUser,
  listUsers,
  updateUserRole,
} = require("../controllers/user.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

const router = express.Router();

// Every user-management route requires a valid login and the admin role.
router.use(requireAuth, requireRole("admin"));

// POST /api/users - create an account of any role (for example a technician).
router.post("/", createUser);

// GET /api/users - list/search accounts (optional ?role= and ?search=).
router.get("/", listUsers);

// PATCH /api/users/:id/role - change another user's role.
router.patch("/:id/role", updateUserRole);

module.exports = router;
