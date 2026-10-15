const mongoose = require("mongoose");
const QRCode = require("qrcode");
const Asset = require("../models/asset.model");
const MaintenanceRequest = require("../models/maintenance-request.model");
const imagekit = require("../config/imagekit");

// Valid status values, taken straight from the schema so there is one source
// of truth.
const ASSET_STATUSES = Asset.ASSET_STATUSES;

// Base URL of the public frontend used inside QR codes. Falls back to the
// local dev origin when FRONTEND_URL is not set, and never holds secrets.
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(
  /\/+$/,
  ""
);

// Picks the fields that are safe to return to logged-in users.
const toSafeAsset = (asset) => ({
  id: asset._id,
  name: asset.name,
  assetCode: asset.assetCode,
  category: asset.category,
  location: asset.location,
  description: asset.description,
  status: asset.status,
  imageUrl: asset.imageUrl || "",
  imageFileId: asset.imageFileId || "",
  createdBy: asset.createdBy,
  createdAt: asset.createdAt,
  updatedAt: asset.updatedAt,
});

// Picks only the minimal fields approved for public QR lookups. No ids,
// creator info or internal metadata are exposed (imageUrl is a public CDN URL;
// the ImageKit file id stays internal).
const toPublicAsset = (asset) => ({
  assetCode: asset.assetCode,
  name: asset.name,
  category: asset.category,
  location: asset.location,
  status: asset.status,
  description: asset.description,
  imageUrl: asset.imageUrl || "",
});

// Longest image URL the schema accepts, and the character set allowed for an
// ImageKit file id, checked here so a bad request gets a clear 400.
const MAX_IMAGE_URL_LENGTH = 500;
const IMAGE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

// Validates a non-empty image URL against the configured ImageKit endpoint.
//
// Always parses with `new URL()` and compares the parsed origin and pathname —
// never the raw string — so host and path tricks are rejected. Returns
// { ok, message }.
const parseImageUrl = (rawUrl, urlEndpoint) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return { ok: false, message: "imageUrl must be a valid absolute URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, message: "imageUrl must use https." };
  }

  // Reject embedded credentials such as "https://user@host/...".
  if (parsed.username || parsed.password) {
    return { ok: false, message: "imageUrl must not contain credentials." };
  }

  let endpoint;
  try {
    endpoint = new URL(urlEndpoint);
  } catch (_) {
    return { ok: false, message: "ImageKit is not configured correctly." };
  }

  if (parsed.origin !== endpoint.origin) {
    return {
      ok: false,
      message: "imageUrl must point at the configured ImageKit endpoint.",
    };
  }

  // Require the path to sit under the endpoint path, comparing whole segments
  // (endpointPath + "/") so a shared prefix like "maintainiq_test_evil" fails.
  const endpointPath = endpoint.pathname.replace(/\/+$/, "");
  if (!parsed.pathname.startsWith(`${endpointPath}/`)) {
    return {
      ok: false,
      message: "imageUrl must point at the configured ImageKit endpoint.",
    };
  }

  return { ok: true };
};

// Validates the optional image fields and returns the values to apply.
//
// Rules:
// - imageUrl/imageFileId must be strings; "" means "no image" (and clears one).
// - a non-empty imageUrl must be a valid https URL on the configured ImageKit
//   endpoint (so ImageKit must be configured).
// - imageFileId is only allowed with a non-empty imageUrl and must match a safe
//   character set.
//
// `onlyPresent` (PATCH) writes back only the keys the caller sent; `current`
// supplies the stored values so the cross-field rules still apply.
const parseImageFields = (body, { onlyPresent = false, current = {} } = {}) => {
  const hasUrl = !onlyPresent || hasOwn(body, "imageUrl");
  const hasFileId = !onlyPresent || hasOwn(body, "imageFileId");

  const imageUrl = hasUrl
    ? typeof body.imageUrl === "string"
      ? body.imageUrl.trim()
      : ""
    : current.imageUrl || "";

  if (hasUrl && body.imageUrl !== undefined && typeof body.imageUrl !== "string") {
    return { ok: false, message: "imageUrl must be a string." };
  }

  if (imageUrl.length > MAX_IMAGE_URL_LENGTH) {
    return {
      ok: false,
      message: `imageUrl must be at most ${MAX_IMAGE_URL_LENGTH} characters.`,
    };
  }

  if (imageUrl !== "") {
    if (!imagekit.isConfigured()) {
      return { ok: false, message: "Image uploads are not configured." };
    }
    const urlCheck = parseImageUrl(imageUrl, imagekit.getConfig().urlEndpoint);
    if (!urlCheck.ok) {
      return urlCheck;
    }
  }

  if (
    hasFileId &&
    body.imageFileId !== undefined &&
    typeof body.imageFileId !== "string"
  ) {
    return { ok: false, message: "imageFileId must be a string." };
  }

  let imageFileId = hasFileId
    ? typeof body.imageFileId === "string"
      ? body.imageFileId.trim()
      : ""
    : current.imageFileId || "";

  // A file id the caller explicitly supplied (non-empty). One inherited from the
  // stored asset is not "supplied" and may be cleared when the URL is cleared.
  const fileIdSupplied = hasFileId && imageFileId !== "";

  if (imageUrl === "") {
    if (fileIdSupplied) {
      return {
        ok: false,
        message: "imageFileId can only be set together with a non-empty imageUrl.",
      };
    }
    // No/removed image: drop any stored file id as well.
    imageFileId = "";
  } else if (imageFileId !== "") {
    if (!IMAGE_FILE_ID_PATTERN.test(imageFileId)) {
      return {
        ok: false,
        message:
          "imageFileId may only contain letters, numbers, underscores and hyphens (max 100 characters).",
      };
    }
  }

  const values = {};
  if (hasUrl) {
    values.imageUrl = imageUrl;
  }
  // Persist the file id when it was sent, or when it changed (e.g. cleared
  // along with the URL) so the stored id is never left stale.
  if (hasFileId || imageFileId !== (current.imageFileId || "")) {
    values.imageFileId = imageFileId;
  }

  return { ok: true, values };
};

// Best-effort removal of an ImageKit file. Only attempted when ImageKit is
// configured, and failures are swallowed so asset writes are never blocked.
const deleteImageFile = (fileId) => {
  if (!fileId || !imagekit.isConfigured()) {
    return;
  }
  Promise.resolve(imagekit.deleteFile(fileId)).catch(() => {});
};

// Escapes regex special characters so user search text cannot break the query.
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Checks whether an object has its own property (used to allow selective
// PATCH updates without trusting arbitrary body keys).
const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

// Builds the public frontend URL that a scanned QR code should open.
const buildAssetUrl = (assetCode) =>
  `${FRONTEND_URL}/assets/${encodeURIComponent(assetCode)}`;

// Turns query parameters into a Mongo filter supporting search + filters.
const buildAssetFilter = (query) => {
  const filter = {};

  if (typeof query.status === "string" && ASSET_STATUSES.includes(query.status)) {
    filter.status = query.status;
  }

  if (typeof query.category === "string" && query.category.trim()) {
    filter.category = new RegExp(`^${escapeRegex(query.category.trim())}$`, "i");
  }

  if (typeof query.location === "string" && query.location.trim()) {
    filter.location = new RegExp(`^${escapeRegex(query.location.trim())}$`, "i");
  }

  if (typeof query.search === "string" && query.search.trim()) {
    const rx = new RegExp(escapeRegex(query.search.trim()), "i");
    filter.$or = [{ name: rx }, { assetCode: rx }, { category: rx }, { location: rx }];
  }

  return filter;
};

// Handles POST /api/assets: admins create an asset. createdBy always comes
// from the verified token, never from the request body.
const createAsset = async (req, res) => {
  try {
    const body = req.body || {};

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const assetCode =
      typeof body.assetCode === "string" ? body.assetCode.trim().toUpperCase() : "";
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const location = typeof body.location === "string" ? body.location.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    const status = body.status === undefined ? "active" : body.status;

    if (!name || !assetCode || !category || !location) {
      return res.status(400).json({
        message: "name, assetCode, category and location are required.",
      });
    }

    if (body.description !== undefined && typeof body.description !== "string") {
      return res.status(400).json({ message: "description must be text." });
    }

    if (!ASSET_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${ASSET_STATUSES.join(", ")}.`,
      });
    }

    const image = parseImageFields(body);
    if (!image.ok) {
      return res.status(400).json({ message: image.message });
    }

    const existingAsset = await Asset.findOne({ assetCode });
    if (existingAsset) {
      return res
        .status(409)
        .json({ message: "An asset with this assetCode already exists." });
    }

    const newAsset = await Asset.create({
      name,
      assetCode,
      category,
      location,
      description,
      status,
      imageUrl: image.values.imageUrl || "",
      imageFileId: image.values.imageFileId || "",
      createdBy: req.user.id,
    });

    return res.status(201).json({
      message: "Asset created successfully.",
      asset: toSafeAsset(newAsset),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ message: "An asset with this assetCode already exists." });
    }

    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid asset data." });
    }

    console.error("createAsset failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/assets: any logged-in user can page through assets and
// optionally filter by search text, status, category or location.
const listAssets = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const filter = buildAssetFilter(req.query);

    const total = await Asset.countDocuments(filter);
    const assets = await Asset.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      assets: assets.map(toSafeAsset),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("listAssets failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/assets/:id: any logged-in user can view one asset.
const getAssetById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid asset id." });
    }

    const asset = await Asset.findById(id);
    if (!asset) {
      return res.status(404).json({ message: "Asset not found." });
    }

    return res.status(200).json({ asset: toSafeAsset(asset) });
  } catch (error) {
    console.error("getAssetById failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles PATCH /api/assets/:id: admins update only the permitted fields.
// assetCode and createdBy are intentionally immutable.
const updateAsset = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid asset id." });
    }

    const asset = await Asset.findById(id);
    if (!asset) {
      return res.status(404).json({ message: "Asset not found." });
    }

    const body = req.body || {};
    const updates = {};

    if (hasOwn(body, "name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return res.status(400).json({ message: "name cannot be empty." });
      }
      updates.name = name;
    }

    if (hasOwn(body, "category")) {
      const category = typeof body.category === "string" ? body.category.trim() : "";
      if (!category) {
        return res.status(400).json({ message: "category cannot be empty." });
      }
      updates.category = category;
    }

    if (hasOwn(body, "location")) {
      const location = typeof body.location === "string" ? body.location.trim() : "";
      if (!location) {
        return res.status(400).json({ message: "location cannot be empty." });
      }
      updates.location = location;
    }

    if (hasOwn(body, "description")) {
      if (typeof body.description !== "string") {
        return res.status(400).json({ message: "description must be text." });
      }
      updates.description = body.description.trim();
    }

    if (hasOwn(body, "status")) {
      if (!ASSET_STATUSES.includes(body.status)) {
        return res.status(400).json({
          message: `status must be one of: ${ASSET_STATUSES.join(", ")}.`,
        });
      }
      updates.status = body.status;
    }

    const image = parseImageFields(body, {
      onlyPresent: true,
      current: { imageUrl: asset.imageUrl, imageFileId: asset.imageFileId },
    });
    if (!image.ok) {
      return res.status(400).json({ message: image.message });
    }
    const previousFileId = asset.imageFileId || "";
    if (hasOwn(image.values, "imageUrl")) {
      updates.imageUrl = image.values.imageUrl;
    }
    if (hasOwn(image.values, "imageFileId")) {
      updates.imageFileId = image.values.imageFileId;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No valid fields to update." });
    }

    Object.assign(asset, updates);
    await asset.save();

    // If the image was replaced or removed, delete the old ImageKit file
    // (best-effort; a failure never blocks the update).
    if (
      hasOwn(updates, "imageFileId") &&
      previousFileId &&
      previousFileId !== asset.imageFileId
    ) {
      deleteImageFile(previousFileId);
    }

    return res.status(200).json({
      message: "Asset updated successfully.",
      asset: toSafeAsset(asset),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ message: "An asset with this assetCode already exists." });
    }

    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid asset data." });
    }

    console.error("updateAsset failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles DELETE /api/assets/:id: admins permanently remove an asset. The
// project has no soft-delete convention, so this is a normal (hard) delete.
const deleteAsset = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid asset id." });
    }

    // Keep referential integrity: an asset that still has maintenance requests
    // must not be removed.
    const hasRequests = await MaintenanceRequest.exists({ asset: id });
    if (hasRequests) {
      return res
        .status(409)
        .json({ message: "Cannot delete an asset that has maintenance requests." });
    }

    const deletedAsset = await Asset.findByIdAndDelete(id);
    if (!deletedAsset) {
      return res.status(404).json({ message: "Asset not found." });
    }

    // The asset row is already gone; drop its ImageKit file too (best-effort).
    deleteImageFile(deletedAsset.imageFileId);

    return res.status(200).json({ message: "Asset deleted successfully." });
  } catch (error) {
    console.error("deleteAsset failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/assets/:id/qr: returns a PNG data URL of a QR code that
// points to the asset's public frontend page. The QR is generated on demand
// and never stored, and contains no secrets.
const getAssetQr = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid asset id." });
    }

    const asset = await Asset.findById(id);
    if (!asset) {
      return res.status(404).json({ message: "Asset not found." });
    }

    const publicUrl = buildAssetUrl(asset.assetCode);
    const qrDataUrl = await QRCode.toDataURL(publicUrl);

    return res.status(200).json({
      assetCode: asset.assetCode,
      url: publicUrl,
      qrDataUrl,
    });
  } catch (error) {
    console.error("getAssetQr failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/public/assets/:assetCode: the intentionally public lookup
// used when someone scans a QR code. Returns only minimal, approved fields.
const getPublicAssetByCode = async (req, res) => {
  try {
    const { assetCode } = req.params;

    const cleanCode =
      typeof assetCode === "string" ? assetCode.trim().toUpperCase() : "";

    if (!cleanCode) {
      return res.status(400).json({ message: "assetCode is required." });
    }

    // Asset codes are short; reject obvious junk before hitting the database.
    if (cleanCode.length > 40) {
      return res.status(404).json({ message: "Asset not found." });
    }

    const asset = await Asset.findOne({ assetCode: cleanCode });
    if (!asset) {
      return res.status(404).json({ message: "Asset not found." });
    }

    return res.status(200).json({ asset: toPublicAsset(asset) });
  } catch (error) {
    console.error("getPublicAssetByCode failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

module.exports = {
  createAsset,
  listAssets,
  getAssetById,
  updateAsset,
  deleteAsset,
  getAssetQr,
  getPublicAssetByCode,
};
