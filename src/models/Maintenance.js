import mongoose from "mongoose";

const { Schema } = mongoose;

const maintenanceSchema = new Schema(
  {
    vehicle: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
      required: [true, "Vehicle is required"],
    },

    maintenanceType: {
      type: String,
      enum: {
        values: ["Major", "Minor"],
        message: "maintenanceType must be 'Major' or 'Minor'",
      },
      required: [true, "Maintenance type is required"],
    },

    title: {
      type: String,
      required: [true, "Maintenance title is required"],
      trim: true,
    },

    description: {
      type: String,
      required: [true, "Maintenance description is required"],
      trim: true,
    },

    garage: {
      name: {
        type: String,
        required: [true, "Garage name is required"],
        trim: true,
      },
      contact: { type: String, trim: true, default: "" },
      address: { type: String, trim: true, default: "" },
      gstin: { type: String, trim: true, default: "" },
    },

    costs: {
      partsCost: { type: Number, default: 0, min: 0 },
      labourCost: { type: Number, default: 0, min: 0 },
      totalCost: { type: Number, default: 0, min: 0 },
    },

    odometer: {
      type: Number,
      min: 0,
    },

    // Stored as free text to match what the app currently sends
    // (e.g. "15 Aug 2026"). Switch to `Date` once the app's date
    // picker sends an ISO string instead.
    expectedCompletionDate: {
      type: String,
      trim: true,
    },

    images: [{ type: String, trim: true }],

    additionalNotes: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: ["Scheduled", "In Progress", "Completed", "Cancelled"],
      default: "Scheduled",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

maintenanceSchema.index({ vehicle: 1, createdAt: -1 });

export default mongoose.model("Maintenance", maintenanceSchema);