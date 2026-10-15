const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/role.middleware");
const { createRateLimiter } = require("../middleware/rate-limit.middleware");
const { isConfigured, getAuthParams } = require("../config/imagekit");

const router = express.Router();

// Uploads are only used when admins manage asset images, so the whole router
// is admin-only. A per-IP limit blunts abuse of the signature endpoint.
const UPLOAD_RATE_LIMIT_WINDOW_MS =
  parseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000;
const UPLOAD_RATE_LIMIT_MAX =
  parseInt(process.env.UPLOAD_RATE_LIMIT_MAX, 10) || 30;

const uploadLimiter = createRateLimiter({
  windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
  max: UPLOAD_RATE_LIMIT_MAX,
});

router.use(requireAuth, requireRole("admin"), uploadLimiter);

// GET /api/uploads/auth - returns short-lived, signed parameters the browser
// uses to upload a file straight to ImageKit. The private key stays on the
// server. Responds 503 when ImageKit is not configured.
router.get("/auth", (req, res) => {
  if (!isConfigured()) {
    return res
      .status(503)
      .json({ message: "Image uploads are not configured." });
  }

  return res.status(200).json({ upload: getAuthParams() });
});

module.exports = router;
