const mongoose = require("mongoose");

// Lifecycle states an asset can be in. Also used by the controller to
// validate incoming status values.
const ASSET_STATUSES = ["active", "maintenance", "retired"];

// Describes a MaintainIQ asset: a uniquely coded item with a category,
// location, optional description, a status, and the admin who created it.
const assetSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    assetCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    location: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    status: {
      type: String,
      enum: ASSET_STATUSES,
      default: "active",
    },
    // Optional image hosted on ImageKit. `imageUrl` is the display URL;
    // `imageFileId` is ImageKit's internal id, used only to delete the file.
    imageUrl: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    imageFileId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Speeds up the common "filter assets by category and location" queries.
assetSchema.index({ category: 1, location: 1 });

// Compiles the schema into the "Asset" model and exports it. The status list
// is exposed as a static so the controller can reuse it for validation.
const Asset = mongoose.model("Asset", assetSchema);
Asset.ASSET_STATUSES = ASSET_STATUSES;

module.exports = Asset;
