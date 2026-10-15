const mongoose = require("mongoose");

// Allowed priority levels for a maintenance request.
const REQUEST_PRIORITIES = ["low", "medium", "high", "critical"];

// Allowed workflow states. "cancelled" is a reporter-initiated terminal state.
const REQUEST_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
];

// Actions that can appear in a request's audit history.
const HISTORY_ACTIONS = [
  "created",
  "status_changed",
  "priority_changed",
  "assigned",
  "unassigned",
  "updated",
  "cancelled",
];

// Which status moves are legal. A status is always allowed to stay the same
// (handled separately); everything else must appear in the current state's
// list. "cancelled" is terminal and closed work can be reopened.
const STATUS_TRANSITIONS = {
  open: ["in_progress", "resolved", "closed", "cancelled"],
  in_progress: ["open", "resolved", "closed", "cancelled"],
  resolved: ["in_progress", "closed"],
  closed: ["open"],
  cancelled: [],
};

// One entry in the audit trail. "by" is always the authenticated user who made
// the change, never a value taken from the request body.
const historyEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: HISTORY_ACTIONS,
      required: true,
    },
    from: { type: String, default: null },
    to: { type: String, default: null },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Describes a maintenance request reported against an asset by a user, plus
// its assignment, scheduling and audit trail.
const maintenanceRequestSchema = new mongoose.Schema(
  {
    asset: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Asset",
      required: true,
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedTechnician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    category: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    location: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    priority: {
      type: String,
      enum: REQUEST_PRIORITIES,
      default: "medium",
    },
    status: {
      type: String,
      enum: REQUEST_STATUSES,
      default: "open",
    },
    dueDate: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Compound indexes that match the supported filters together with the default
// newest-first ordering, so no redundant single-field indexes are needed.
maintenanceRequestSchema.index({ reportedBy: 1, createdAt: -1 });
maintenanceRequestSchema.index({ asset: 1, createdAt: -1 });
maintenanceRequestSchema.index({ status: 1, priority: 1, createdAt: -1 });
maintenanceRequestSchema.index({ assignedTechnician: 1, status: 1, createdAt: -1 });
// Powers overdue/upcoming maintenance planning queries.
maintenanceRequestSchema.index({ dueDate: 1 });

// Compiles the schema into the "MaintenanceRequest" model and exports it. The
// enum lists and transition map are exposed as statics so controllers reuse
// them instead of duplicating the rules.
const MaintenanceRequest = mongoose.model(
  "MaintenanceRequest",
  maintenanceRequestSchema
);
MaintenanceRequest.REQUEST_PRIORITIES = REQUEST_PRIORITIES;
MaintenanceRequest.REQUEST_STATUSES = REQUEST_STATUSES;
MaintenanceRequest.HISTORY_ACTIONS = HISTORY_ACTIONS;
MaintenanceRequest.STATUS_TRANSITIONS = STATUS_TRANSITIONS;

module.exports = MaintenanceRequest;
