import mongoose from "mongoose";

const claimDetailsSchema = new mongoose.Schema(
  {
    businessName: { type: String, trim: true, maxlength: 120 },
    ownerName: { type: String, trim: true, maxlength: 80 },
    mobile: { type: String, trim: true, maxlength: 15 },
    category: { type: String, trim: true, maxlength: 60 },
    location: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

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

    // Filled when someone registers the QR from the pop-up form
    claimDetails: {
      type: claimDetailsSchema,
      default: null,
    },
    claimedAt: {
      type: Date,
      default: null,
    },

    // Filled when an admin approves it
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