import mongoose from "mongoose";

const leadHistorySchema = new mongoose.Schema(
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

    field: {
      type: String,
      required: true,
    },

    oldValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    newValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    action: {
      type: String,
      enum: [
        "created",
        "updated",
        "deleted",
        "status_changed",
        "priority_changed",
        "note_added",
      ],
      default: "updated",
    },

    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

leadHistorySchema.index({
  lead: 1,
  createdAt: -1,
});

export default mongoose.model("LeadHistory", leadHistorySchema);