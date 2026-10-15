const mongoose = require("mongoose");
const Asset = require("../models/asset.model");
const User = require("../models/user.model");
const MaintenanceRequest = require("../models/maintenance-request.model");

// Valid enum values reused for consistent, complete counts.
const ASSET_STATUSES = Asset.ASSET_STATUSES;
const REQUEST_STATUSES = MaintenanceRequest.REQUEST_STATUSES;
const REQUEST_PRIORITIES = MaintenanceRequest.REQUEST_PRIORITIES;

// Active work is anything not yet resolved/closed/cancelled.
const ACTIVE_STATUSES = ["open", "in_progress"];

// How far ahead "upcoming" maintenance looks.
const UPCOMING_WINDOW_DAYS = 7;

// Converts an aggregation grouping into an object with every enum key present
// (missing keys default to 0) so the response shape is stable.
const groupCounts = (rows, keys) => {
  const counts = {};
  for (const key of keys) {
    counts[key] = 0;
  }
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row._id)) {
      counts[row._id] = row.count;
    }
  }
  return counts;
};

// Shrinks a request document into a small, safe summary for dashboard lists.
const toRequestSummary = (request) => ({
  id: request._id,
  title: request.title,
  status: request.status,
  priority: request.priority,
  dueDate: request.dueDate || null,
  asset: request.asset
    ? { id: request.asset._id, name: request.asset.name, assetCode: request.asset.assetCode }
    : null,
  assignedTechnician: request.assignedTechnician
    ? { id: request.assignedTechnician._id, username: request.assignedTechnician.username }
    : null,
});

// Handles GET /api/dashboard/stats: admin dashboard totals for assets and
// requests, calculated directly from the database.
const getStats = async (req, res) => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [
      assetStatusRows,
      requestStatusRows,
      requestPriorityRows,
      assetsTotal,
      requestsTotal,
      unassigned,
      overdue,
      upcoming,
    ] = await Promise.all([
      Asset.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      MaintenanceRequest.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      MaintenanceRequest.aggregate([{ $group: { _id: "$priority", count: { $sum: 1 } } }]),
      Asset.countDocuments({}),
      MaintenanceRequest.countDocuments({}),
      MaintenanceRequest.countDocuments({
        assignedTechnician: null,
        status: { $in: ACTIVE_STATUSES },
      }),
      MaintenanceRequest.countDocuments({
        dueDate: { $ne: null, $lt: now },
        status: { $in: ACTIVE_STATUSES },
      }),
      MaintenanceRequest.countDocuments({
        dueDate: { $ne: null, $gte: now, $lte: soon },
        status: { $in: ACTIVE_STATUSES },
      }),
    ]);

    return res.status(200).json({
      assets: { total: assetsTotal, byStatus: groupCounts(assetStatusRows, ASSET_STATUSES) },
      requests: {
        total: requestsTotal,
        byStatus: groupCounts(requestStatusRows, REQUEST_STATUSES),
        byPriority: groupCounts(requestPriorityRows, REQUEST_PRIORITIES),
        unassigned,
        overdue,
        upcoming,
      },
    });
  } catch (error) {
    console.error("getStats failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/dashboard/technicians: admin view of every technician's
// active workload, including technicians with no assignments yet.
const getTechnicianWorkload = async (req, res) => {
  try {
    const [technicians, rows] = await Promise.all([
      User.find({ role: "technician" }).select("username role"),
      MaintenanceRequest.aggregate([
        { $match: { assignedTechnician: { $ne: null } } },
        {
          $group: {
            _id: "$assignedTechnician",
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
            in_progress: {
              $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] },
            },
            resolved: { $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] } },
            closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const byId = new Map(rows.map((row) => [row._id.toString(), row]));

    const workload = technicians.map((tech) => {
      const row = byId.get(tech._id.toString()) || {};
      return {
        technician: { id: tech._id, username: tech.username, role: tech.role },
        total: row.total || 0,
        open: row.open || 0,
        in_progress: row.in_progress || 0,
        resolved: row.resolved || 0,
        closed: row.closed || 0,
        cancelled: row.cancelled || 0,
      };
    });

    return res.status(200).json({ technicians: workload });
  } catch (error) {
    console.error("getTechnicianWorkload failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/dashboard/recommendations: non-AI maintenance planning.
// Surfaces overdue and upcoming requests (by due date) and assets currently
// flagged as under maintenance.
const getRecommendations = async (req, res) => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const populate = [
      { path: "asset", select: "name assetCode" },
      { path: "assignedTechnician", select: "username" },
    ];

    const [overdue, upcoming, assetsInMaintenance] = await Promise.all([
      MaintenanceRequest.find({
        dueDate: { $ne: null, $lt: now },
        status: { $in: ACTIVE_STATUSES },
      })
        .sort({ dueDate: 1 })
        .limit(50)
        .populate(populate),
      MaintenanceRequest.find({
        dueDate: { $ne: null, $gte: now, $lte: soon },
        status: { $in: ACTIVE_STATUSES },
      })
        .sort({ dueDate: 1 })
        .limit(50)
        .populate(populate),
      Asset.find({ status: "maintenance" })
        .select("name assetCode category location status")
        .limit(50),
    ]);

    return res.status(200).json({
      window: { days: UPCOMING_WINDOW_DAYS, generatedAt: now },
      overdue: { count: overdue.length, requests: overdue.map(toRequestSummary) },
      upcoming: { count: upcoming.length, requests: upcoming.map(toRequestSummary) },
      assetsInMaintenance: {
        count: assetsInMaintenance.length,
        assets: assetsInMaintenance.map((asset) => ({
          id: asset._id,
          name: asset.name,
          assetCode: asset.assetCode,
          category: asset.category,
          location: asset.location,
          status: asset.status,
        })),
      },
    });
  } catch (error) {
    console.error("getRecommendations failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// Handles GET /api/dashboard/my-workload: a technician's own workload counts.
// Admins may pass ?technicianId= to inspect a specific technician.
const getMyWorkload = async (req, res) => {
  try {
    let technicianId = req.user.id;
    if (req.user.role === "admin") {
      if (
        typeof req.query.technicianId === "string" &&
        mongoose.isValidObjectId(req.query.technicianId)
      ) {
        technicianId = req.query.technicianId;
      }
    }

    const match = { assignedTechnician: technicianId };
    const [total, open, in_progress, resolved, closed, cancelled] = await Promise.all([
      MaintenanceRequest.countDocuments(match),
      MaintenanceRequest.countDocuments({ ...match, status: "open" }),
      MaintenanceRequest.countDocuments({ ...match, status: "in_progress" }),
      MaintenanceRequest.countDocuments({ ...match, status: "resolved" }),
      MaintenanceRequest.countDocuments({ ...match, status: "closed" }),
      MaintenanceRequest.countDocuments({ ...match, status: "cancelled" }),
    ]);

    return res.status(200).json({
      technicianId,
      total,
      open,
      in_progress,
      resolved,
      closed,
      cancelled,
    });
  } catch (error) {
    console.error("getMyWorkload failed:", error.message);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

module.exports = {
  getStats,
  getTechnicianWorkload,
  getRecommendations,
  getMyWorkload,
};
