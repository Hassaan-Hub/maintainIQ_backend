const express = require("express");
const {
  getStats,
  getTechnicianWorkload,
  getRecommendations,
  getMyWorkload,
} = require("../controllers/dashboard.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

const router = express.Router();

// A technician (or admin) can read their own workload; this must be declared
// before the admin-only gate below.
router.get(
  "/my-workload",
  requireAuth,
  requireRole("technician", "admin"),
  getMyWorkload
);

// The remaining dashboard endpoints are admin-only.
router.use(requireAuth, requireRole("admin"));

// GET /api/dashboard/stats - asset and request totals for the admin dashboard.
router.get("/stats", getStats);

// GET /api/dashboard/technicians - per-technician workload.
router.get("/technicians", getTechnicianWorkload);

// GET /api/dashboard/recommendations - overdue/upcoming maintenance planning.
router.get("/recommendations", getRecommendations);

module.exports = router;
