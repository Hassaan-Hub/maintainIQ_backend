const express = require("express");
const {
  createRequest,
  listMyRequests,
  listAssignedRequests,
  listAllRequests,
  getRequestById,
  getRequestHistory,
  updateRequest,
  updateRequestStatus,
  assignTechnician,
  cancelRequest,
  deleteRequest,
} = require("../controllers/maintenance-request.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

const router = express.Router();

// Every maintenance request route requires a valid login.
router.use(requireAuth);

// Any logged-in user can report an issue, read their own requests, or cancel
// one of their own. Static paths are declared before "/:id".
router.post("/", createRequest);
router.get("/my", listMyRequests);
router.get("/assigned", listAssignedRequests);
router.patch("/:id/cancel", cancelRequest);

// Admin-only listing and full updates.
router.get("/", requireRole("admin"), listAllRequests);
router.patch("/:id", requireRole("admin"), updateRequest);
router.delete("/:id", requireRole("admin"), deleteRequest);

// Assignment is admin-only; status workflow is for the assigned technician
// (checked again in the controller) or an admin.
router.patch("/:id/assign", requireRole("admin"), assignTechnician);
router.patch(
  "/:id/status",
  requireRole("admin", "technician"),
  updateRequestStatus
);

// Read routes. The controller decides whether the caller may see the record.
router.get("/:id/history", getRequestHistory);
router.get("/:id", getRequestById);

module.exports = router;
