const express = require("express");
const { getPublicAssetByCode } = require("../controllers/asset.controller");
const { createRateLimiter } = require("../middleware/rate-limit.middleware");

const router = express.Router();

// The public lookup is unauthenticated, so it gets its own IP rate limit to
// blunt scraping/abuse. Defaults to 120 requests per minute per IP.
const PUBLIC_RATE_LIMIT_WINDOW_MS =
  parseInt(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS, 10) || 60000;
const PUBLIC_RATE_LIMIT_MAX =
  parseInt(process.env.PUBLIC_RATE_LIMIT_MAX, 10) || 120;

const publicLimiter = createRateLimiter({
  windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
  max: PUBLIC_RATE_LIMIT_MAX,
});

// GET /api/public/assets/:assetCode - public, unauthenticated lookup used by
// the frontend after a QR code is scanned. It returns minimal fields only.
router.get("/assets/:assetCode", publicLimiter, getPublicAssetByCode);

module.exports = router;
