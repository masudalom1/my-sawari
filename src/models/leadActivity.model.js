// models/leadActivity.model.js

import mongoose from "mongoose";

const leadActivitySchema = new mongoose.Schema(
  {
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },

    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    contactType: {
      type: String,
      enum: ["call", "whatsapp", "message", "email", "meeting", "note"],
      required: true,
    },

    direction: {
      type: String,
      enum: ["incoming", "outgoing"],
      default: "outgoing",
    },

    duration: {
      type: String,
      default: "",
    },

    // Call/WhatsApp/Email Summary
    activitySummary: {
      type: String,
      required: true,
      trim: true,
    },

    outcome: {
      type: String,
      trim: true,
      default: "",
    },

    followUpRequired: {
      type: Boolean,
      default: false,
    },

    nextFollowUpDate: {
      type: Date,
    },

    leadStatusAfterContact: {
      type: String,
      trim: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

leadActivitySchema.index({ lead: 1, createdAt: -1 });

export default mongoose.model("LeadActivity", leadActivitySchema);