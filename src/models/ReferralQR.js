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

// Who assigned it: copied from the logged-in team member / admin
const assignerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, trim: true },
    mobile: { type: String, trim: true },
    email: { type: String, trim: true },
    role: { type: String, trim: true },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    action: { type: String, enum: ["assigned", "unassigned", "revoked"], required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    customerName: { type: String, trim: true },
    by: { type: assignerSchema },
    at: { type: Date, default: Date.now },
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
      ref: "Customer",
      default: null,
      index: true,
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

    // Filled when assigned
    assignedAt: {
      type: Date,
      default: null,
    },

    // Team member / Admin who assigned it
    executiveId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    executiveName: { type: String, trim: true, default: null },
    assignedBy: { type: assignerSchema, default: null },

    // Audit trail of assignment history
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

const ReferralQR =
  mongoose.models.ReferralQR || mongoose.model("ReferralQR", referralQRSchema);

export default ReferralQR;