import mongoose from "mongoose";

const referralQRSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true, // the unique index is what guarantees no repeats
      uppercase: true,
      trim: true,
      match: /^[A-HJKMNP-Z2-9]{6}$/,
    },
    batchName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["available", "pending", "assigned", "revoked"],
      default: "available",
      index: true,
    },
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

const ReferralQR =
  mongoose.models.ReferralQR || mongoose.model("ReferralQR", referralQRSchema);

export default ReferralQR;