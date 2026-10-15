const express = require("express");
const {
  createAsset,
  listAssets,
  getAssetById,
  updateAsset,
  deleteAsset,
  getAssetQr,
} = require("../controllers/asset.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");

const router = express.Router();

// Every asset route requires a valid login.
router.use(requireAuth);

// Read routes are available to any logged-in user.
router.get("/", listAssets);
router.get("/:id/qr", getAssetQr);
router.get("/:id", getAssetById);

// Write routes are restricted to admins.
router.post("/", requireRole("admin"), createAsset);
router.patch("/:id", requireRole("admin"), updateAsset);
router.delete("/:id", requireRole("admin"), deleteAsset);

module.exports = router;
