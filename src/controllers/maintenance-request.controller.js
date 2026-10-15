const mongoose = require("mongoose");
const Asset = require("../models/asset.model");
const User = require("../models/user.model");
const MaintenanceRequest = require("../models/maintenance-request.model");

// Valid enum values, taken straight from the schema so there is one source of
// truth.
const REQUEST_PRIORITIES = MaintenanceRequest.REQUEST_PRIORITIES;
const REQUEST_STATUSES = MaintenanceRequest.REQUEST_STATUSES;
const STATUS_TRANSITIONS = MaintenanceRequest.STATUS_TRANSITIONS;

// Population configs that expose only safe asset/user fields. Mongo always
// includes _id unless it is explicitly excluded.
const ASSET_POPULATE = {
  path: "asset",
  select: "name assetCode category location status",
};
const REPORTER_POPULATE = {
  path: "reportedBy",
  select: "username role",
};
const TECHNICIAN_POPULATE = {
  path: "assignedTechnician",
  select: "username role",
};
const REQUEST_POPULATE = [ASSET_POPULATE, REPORTER_POPULATE, TECHNICIAN_POPULATE];

// Picks only the safe user fields to embed in a request response, so no
// password hash or private data is ever leaked.
const toSafeUserRef = (user) => {
  if (!user || !user._id) {
    return null;
  }
  return { id: user._id, username: user.username, role: user.role };
};

// Picks only the safe asset fields to embed in a request response.
const toSafeAssetRef = (asset) => {
  if (!asset || !asset._id) {
    return null;
  }
  return {
    id: asset._id,
    name: asset.name,
    assetCode: asset.assetCode,
    category: asset.category,
    location: asset.location,
    status: asset.status,
  };
};

// Shapes a maintenance request into the consistent API response payload.
const toSafeRequest = (request) => ({
  id: request._id,
  asset: toSafeAssetRef(request.asset),
  reportedBy: toSafeUserRef(request.reportedBy),
  assignedTechnician: toSafeUserRef(request.assignedTechnician),
  title: request.title,
  description: request.description,
  category: request.category || "",
  location: request.location || "",
  priority: request.priority,
  status: request.status,
  dueDate: request.dueDate || null,
  resolvedAt: request.resolvedAt || null,
  closedAt: request.closedAt || null,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

// Escapes regex special characters so user search text cannot break the query.
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Checks whether an object has its own property (used to allow selective
// PATCH updates without trusting arbitrary body keys).
const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

// Parses page/limit query values into safe, bounded pagination numbers.
const parsePagination = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

// Parses an optional date value, returning null when it is missing/invalid.
const parseDate = (value) => {
  if (value === null || value === undefined || value === "") {
    return { ok: true, date: null };
  }
  // Only strings are acceptable: numbers and booleans must not be coerced.
  if (typeof value !== "string") {
    return { ok: false, date: null };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, date: null };
  }
  return { ok: true, date };
};

// Parses an optional text field, returning null when the type is invalid.
const parseText = (value, max) => {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, value: null };
  }
  const text = value.trim();
  if (max && text.length > max) {
    return { ok: false, value: null };
  }
  return { ok: true, value: text };
};

// True when the given status may legally move to the target status. Staying on
// the same status is treated as valid (it is a no-op handled by the caller).
const canTransition = (from, to) =>
  from === to || (STATUS_TRANSITIONS[from] || []).includes(to);

// Remembers the outcome of a status change: stamps resolvedAt/closedAt and
// clears them again when a request is reopened.
const applyStatusTimestamps = (request, toStatus) => {
  if (toStatus === "resolved") {
    request.resolvedAt = new Date();
  } else if (toStatus === "closed") {
    request.closedAt = new Date();
  } else if (toStatus === "open" || toStatus === "in_progress") {
    request.resolvedAt = null;
    request.closedAt = null;
  }
};

// True when the authenticated user may look at this request: admins, the
// reporter, and the assigned technician are allowed.
const canViewRequest = (req, request) => {
  if (req.user.role === "admin") {
    return true;
  }
  const reportedById = request.reportedBy && request.reportedBy._id;
  const assignedId =
    request.assignedTechnician && request.assignedTechnician._id;
  return (
    (reportedById && reportedById.toString() === req.user.id) ||
    (assignedId && assignedId.toString() === req.user.id)
  );
};

// Turns query parameters into a Mongo filter for the admin listing, supporting
// status/priority/asset/category/location/technician filters and a search.
const buildAdminFilter = (query) => {
  const filter = {};

  if (REQUEST_STATUSES.includes(query.status)) {
    filter.status = query.status;
  }
  if (REQUEST_PRIORITIES.includes(query.priority)) {
    filter.priority = query.priority;
  }
  if (typeof query.asset === "string" && mongoose.isValidObjectId(query.asset)) {
    filter.asset = query.asset;
  }
  if (
    typeof query.assignedTechnician === "string" &&
    mongoose.isValidObjectId(query.assignedTechnician)
  ) {
    filter.assignedTechnician = query.assignedTechnician;
  }
  if (typeof query.category === "string" && query.category.trim()) {
    filter.category = new RegExp(`^${escapeRegex(query.category.trim())}$`, "i");
  }
  if (typeof query.location === "string" && query.location.trim()) {
    filter.location = new RegExp(`^${escapeRegex(query.location.trim())}$`, "i");
  }
  if (typeof query.search === "string" && query.search.trim()) {
    const rx = new RegExp(escapeRegex(query.search.trim()), "i");
    filter.$or = [{ title: rx }, { description: rx }, { category: rx }, { location: rx }];
  }

  return filter;
};

// Turns query parameters into a Mongo filter scoped to the current user's own
// reported requests, supporting optional status/priority filters.
const buildMyFilter = (userId, query) => {
  const filter = { reportedBy: userId };

  if (REQUEST_STATUSES.includes(query.status)) {
    filter.status = query.status;
  }
  if (REQUEST_PRIORITIES.includes(query.priority)) {
    filter.priority = query.priority;
  }

  return filter;
};

// Handles POST /api/maintenance-requests: any logged-in user reports an issue.
// reportedBy always comes from the verified token and status is forced to
// "open" so neither can be forged from the request body.
const createRequest = async (req, res) => {
  try {
    const body = req.body || {};

    const assetId = typeof body.asset === "string" ? body.asset.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    const priority = body.priority === undefined ? "medium" : body.priority;

    if (!assetId || !title || !description) {
      return res.status(400).json({
        message: "asset, title and description are required.",
      });
    }

    if (!mongoose.isValidObjectId(assetId)) {
      return res.status(400).json({ message: "Invalid asset id." });
    }

    if (!REQUEST_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        message: `priority must be one of: ${REQUEST_PRIORITIES.join(", ")}.`,
      });
    }

    const category = parseText(body.category, 80);
    const location = parseText(body.location, 120);
    const dueDate = parseDate(body.dueDate);

    if (!category.ok || !location.ok) {
      return res.status(400).json({ message: "category and location must be text." });
    }
    if (!dueDate.ok) {
      return res.status(400).json({ message: "dueDate must be a valid date." });
    }

    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ message: "Asset not found." });
    }

    const now = new Date();
    const newRequest = await MaintenanceRequest.create({
      asset: asset._id,
      reportedBy: req.user.id,
      title,
      description,
      category: category.value === null ? asset.category : category.value,
      location: location.value === null ? asset.location : location.value,
      priority,
      dueDate: dueDate.date,
      history: [
        {
          action: "created",
          from: null,
          to: "open",
          note: "",
          by: req.user.id,
          at: now,
        },
      ],
    });

    await newRequest.populate(REQUEST_POPULATE);

    return res.status(201).json({
      message: "Maintenance request created successfully.",
      request: toSafeRequest(newRequest),
    });
  } catch (error) {
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid maintenance request data." });
    }

    console.error("createRequest failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/maintenance-requests/my: a user lists only their own
// requests, with pagination and optional status/priority filters.
const listMyRequests = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = buildMyFilter(req.user.id, req.query);

    const total = await MaintenanceRequest.countDocuments(filter);
    const requests = await MaintenanceRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(REQUEST_POPULATE);

    return res.status(200).json({
      requests: requests.map(toSafeRequest),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("listMyRequests failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/maintenance-requests/assigned: a technician sees only the
// work assigned to them; an admin sees every assignment (optionally filtered
// by ?technicianId=). Regular users are not allowed here.
const listAssignedRequests = async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    if (!isAdmin && req.user.role !== "technician") {
      return res
        .status(403)
        .json({ message: "You do not have permission to perform this action." });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};

    if (isAdmin) {
      if (
        typeof req.query.technicianId === "string" &&
        mongoose.isValidObjectId(req.query.technicianId)
      ) {
        filter.assignedTechnician = req.query.technicianId;
      }
    } else {
      filter.assignedTechnician = req.user.id;
    }

    if (REQUEST_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (REQUEST_PRIORITIES.includes(req.query.priority)) {
      filter.priority = req.query.priority;
    }

    const total = await MaintenanceRequest.countDocuments(filter);
    const requests = await MaintenanceRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(REQUEST_POPULATE);

    return res.status(200).json({
      requests: requests.map(toSafeRequest),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("listAssignedRequests failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/maintenance-requests: admins list every request with
// pagination, search, status/priority/asset filters and more.
const listAllRequests = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = buildAdminFilter(req.query);

    const total = await MaintenanceRequest.countDocuments(filter);
    const requests = await MaintenanceRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(REQUEST_POPULATE);

    return res.status(200).json({
      requests: requests.map(toSafeRequest),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("listAllRequests failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/maintenance-requests/:id: admins, the reporter and the
// assigned technician can read a request. Everyone else gets 404 so they
// cannot probe for records they do not own.
const getRequestById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const request = await MaintenanceRequest.findById(id).populate(REQUEST_POPULATE);
    if (!request) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    if (!canViewRequest(req, request)) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    return res.status(200).json({ request: toSafeRequest(request) });
  } catch (error) {
    console.error("getRequestById failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/maintenance-requests/:id/history: returns the audit trail
// to anyone allowed to view the request. Entries are written only by the
// server, so users cannot forge them.
const getRequestHistory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const request = await MaintenanceRequest.findById(id)
      .populate(REQUEST_POPULATE)
      .populate({ path: "history.by", select: "username role" });

    if (!request || !canViewRequest(req, request)) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    const history = [...(request.history || [])]
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map((entry) => ({
        action: entry.action,
        from: entry.from,
        to: entry.to,
        note: entry.note || "",
        by: toSafeUserRef(entry.by),
        at: entry.at,
      }));

    return res.status(200).json({ history });
  } catch (error) {
    console.error("getRequestHistory failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles PATCH /api/maintenance-requests/:id: admins update the approved
// fields only. asset and reportedBy are immutable, every change is validated,
// and a full audit entry is recorded for each change.
const updateRequest = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const request = await MaintenanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    const body = req.body || {};
    const now = new Date();
    const entries = [];
    const changedFields = [];
    let changed = false;

    if (hasOwn(body, "title")) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        return res.status(400).json({ message: "title cannot be empty." });
      }
      if (title !== request.title) {
        changedFields.push("title");
      }
      request.title = title;
      changed = true;
    }

    if (hasOwn(body, "description")) {
      const description =
        typeof body.description === "string" ? body.description.trim() : "";
      if (!description) {
        return res.status(400).json({ message: "description cannot be empty." });
      }
      if (description !== request.description) {
        changedFields.push("description");
      }
      request.description = description;
      changed = true;
    }

    if (hasOwn(body, "category")) {
      const category = parseText(body.category, 80);
      if (!category.ok || category.value === null || category.value === "") {
        return res.status(400).json({ message: "category must be text." });
      }
      if (category.value !== (request.category || "")) {
        changedFields.push("category");
      }
      request.category = category.value;
      changed = true;
    }

    if (hasOwn(body, "location")) {
      const location = parseText(body.location, 120);
      if (!location.ok || location.value === null || location.value === "") {
        return res.status(400).json({ message: "location must be text." });
      }
      if (location.value !== (request.location || "")) {
        changedFields.push("location");
      }
      request.location = location.value;
      changed = true;
    }

    if (hasOwn(body, "dueDate")) {
      const dueDate = parseDate(body.dueDate);
      if (!dueDate.ok) {
        return res.status(400).json({ message: "dueDate must be a valid date." });
      }
      const currentDue = request.dueDate ? new Date(request.dueDate).getTime() : null;
      const nextDue = dueDate.date ? dueDate.date.getTime() : null;
      if (currentDue !== nextDue) {
        changedFields.push("dueDate");
      }
      request.dueDate = dueDate.date;
      changed = true;
    }

    // One combined audit entry for every direct field change (title,
    // description, category, location, dueDate). Unchanged values are not
    // logged. priority_changed / status_changed entries stay separate.
    if (changedFields.length) {
      entries.push({
        action: "updated",
        from: null,
        to: null,
        note: changedFields.join(","),
        by: req.user.id,
        at: now,
      });
    }

    if (hasOwn(body, "priority")) {
      if (!REQUEST_PRIORITIES.includes(body.priority)) {
        return res.status(400).json({
          message: `priority must be one of: ${REQUEST_PRIORITIES.join(", ")}.`,
        });
      }
      if (body.priority !== request.priority) {
        entries.push({
          action: "priority_changed",
          from: request.priority,
          to: body.priority,
          note: "",
          by: req.user.id,
          at: now,
        });
        request.priority = body.priority;
        changed = true;
      }
    }

    if (hasOwn(body, "status")) {
      if (!REQUEST_STATUSES.includes(body.status)) {
        return res.status(400).json({
          message: `status must be one of: ${REQUEST_STATUSES.join(", ")}.`,
        });
      }
      if (!canTransition(request.status, body.status)) {
        return res.status(400).json({
          message: `Cannot change status from "${request.status}" to "${body.status}".`,
        });
      }
      if (body.status !== request.status) {
        entries.push({
          action: body.status === "cancelled" ? "cancelled" : "status_changed",
          from: request.status,
          to: body.status,
          note: "",
          by: req.user.id,
          at: now,
        });
        request.status = body.status;
        applyStatusTimestamps(request, body.status);
        changed = true;
      }
    }

    if (!changed) {
      return res.status(400).json({ message: "No valid fields to update." });
    }

    if (entries.length) {
      request.history.push(...entries);
    }
    await request.save();
    await request.populate(REQUEST_POPULATE);

    return res.status(200).json({
      message: "Maintenance request updated successfully.",
      request: toSafeRequest(request),
    });
  } catch (error) {
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid maintenance request data." });
    }

    console.error("updateRequest failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles PATCH /api/maintenance-requests/:id/status: the assigned technician
// (or an admin) moves a request through its workflow, with transition checks
// and an audit entry. Technicians cannot cancel; they use the cancel endpoint.
const updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const request = await MaintenanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    const isAdmin = req.user.role === "admin";
    const isAssigned =
      request.assignedTechnician &&
      request.assignedTechnician.toString() === req.user.id;

    if (!isAdmin && !(req.user.role === "technician" && isAssigned)) {
      return res.status(403).json({
        message: "You do not have permission to perform this action.",
      });
    }

    const body = req.body || {};
    if (!REQUEST_STATUSES.includes(body.status)) {
      return res.status(400).json({
        message: `status must be one of: ${REQUEST_STATUSES.join(", ")}.`,
      });
    }
    if (!isAdmin && body.status === "cancelled") {
      return res
        .status(403)
        .json({ message: "Only the reporter or an admin can cancel a request." });
    }
    if (!canTransition(request.status, body.status)) {
      return res.status(400).json({
        message: `Cannot change status from "${request.status}" to "${body.status}".`,
      });
    }

    const note = parseText(body.note, 500);
    if (!note.ok) {
      return res.status(400).json({ message: "note must be text (max 500 chars)." });
    }

    if (body.status === request.status) {
      return res.status(400).json({ message: "Request is already in that status." });
    }

    request.history.push({
      action: body.status === "cancelled" ? "cancelled" : "status_changed",
      from: request.status,
      to: body.status,
      note: note.value || "",
      by: req.user.id,
      at: new Date(),
    });
    request.status = body.status;
    applyStatusTimestamps(request, body.status);

    await request.save();
    await request.populate(REQUEST_POPULATE);

    return res.status(200).json({
      message: "Request status updated successfully.",
      request: toSafeRequest(request),
    });
  } catch (error) {
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid maintenance request data." });
    }

    console.error("updateRequestStatus failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles PATCH /api/maintenance-requests/:id/assign: admins assign or
// reassign a request to a real technician account, or unassign with null.
const assignTechnician = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const request = await MaintenanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    if (!["open", "in_progress", "resolved"].includes(request.status)) {
      return res
        .status(400)
        .json({ message: "Cannot change assignment on a closed or cancelled request." });
    }

    const body = req.body || {};
    if (!hasOwn(body, "technicianId")) {
      return res.status(400).json({ message: "technicianId is required." });
    }

    const currentId = request.assignedTechnician
      ? request.assignedTechnician.toString()
      : null;
    const now = new Date();

    // Unassign when technicianId is explicitly null or empty.
    if (body.technicianId === null || body.technicianId === "") {
      if (!currentId) {
        return res
          .status(400)
          .json({ message: "No technician is currently assigned." });
      }
      request.history.push({
        action: "unassigned",
        from: currentId,
        to: null,
        note: "",
        by: req.user.id,
        at: now,
      });
      request.assignedTechnician = null;
      await request.save();
      await request.populate(REQUEST_POPULATE);
      return res.status(200).json({
        message: "Technician unassigned successfully.",
        request: toSafeRequest(request),
      });
    }

    if (typeof body.technicianId !== "string" || !mongoose.isValidObjectId(body.technicianId)) {
      return res.status(400).json({ message: "Invalid technician id." });
    }

    const technician = await User.findById(body.technicianId);
    if (!technician) {
      return res.status(404).json({ message: "Technician not found." });
    }
    if (technician.role !== "technician") {
      return res
        .status(400)
        .json({ message: "The selected user is not a technician." });
    }
    if (currentId === technician._id.toString()) {
      return res
        .status(400)
        .json({ message: "Technician is already assigned to this request." });
    }

    request.history.push({
      action: "assigned",
      from: currentId,
      to: technician._id.toString(),
      note: "",
      by: req.user.id,
      at: now,
    });
    request.assignedTechnician = technician._id;
    await request.save();
    await request.populate(REQUEST_POPULATE);

    return res.status(200).json({
      message: "Technician assigned successfully.",
      request: toSafeRequest(request),
    });
  } catch (error) {
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid maintenance request data." });
    }

    console.error("assignTechnician failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles PATCH /api/maintenance-requests/:id/cancel: the reporter (or an
// admin) cancels their own active request. Cancellation is a terminal state.
const cancelRequest = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const request = await MaintenanceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    const isAdmin = req.user.role === "admin";
    const isOwner = request.reportedBy.toString() === req.user.id;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        message: "You do not have permission to perform this action.",
      });
    }

    if (!["open", "in_progress"].includes(request.status)) {
      return res
        .status(400)
        .json({ message: `A request in status "${request.status}" cannot be cancelled.` });
    }

    const body = req.body || {};
    const note = parseText(body.note, 500);
    if (!note.ok) {
      return res.status(400).json({ message: "note must be text (max 500 chars)." });
    }

    request.history.push({
      action: "cancelled",
      from: request.status,
      to: "cancelled",
      note: note.value || "",
      by: req.user.id,
      at: new Date(),
    });
    request.status = "cancelled";
    applyStatusTimestamps(request, "cancelled");

    await request.save();
    await request.populate(REQUEST_POPULATE);

    return res.status(200).json({
      message: "Maintenance request cancelled successfully.",
      request: toSafeRequest(request),
    });
  } catch (error) {
    console.error("cancelRequest failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles DELETE /api/maintenance-requests/:id: admins permanently remove the
// request record only. Its asset and reporter are left untouched.
const deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid request id." });
    }

    const deletedRequest = await MaintenanceRequest.findByIdAndDelete(id);
    if (!deletedRequest) {
      return res.status(404).json({ message: "Maintenance request not found." });
    }

    return res
      .status(200)
      .json({ message: "Maintenance request deleted successfully." });
  } catch (error) {
    console.error("deleteRequest failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

module.exports = {
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
};
