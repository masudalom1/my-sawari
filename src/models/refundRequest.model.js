import mongoose from "mongoose";

const refundSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    refundSource: {
      type: String,
      enum: ["cancellation", "manual"],
    },
    refundType: {
      type: String,
      enum: ["cash", "upi", "razorpay", "bank_transfer"],
    },
    upiId: { type: String, default: "", trim: true, maxlength: 256 },
    accountDetails: {
      accountNumber: { type: String, default: "" },
      ifscCode: { type: String, default: "" },
      accountHolderName: { type: String, default: "" },
      bankName: { type: String, default: "" },
    },
    transactionReference: { type: String, default: "", trim: true, maxlength: 120 },
    statusHistory: [{
      status: { type: String, required: true },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      byName: { type: String, default: "", trim: true },
      note: { type: String, default: "", trim: true },
      at: { type: Date, default: Date.now },
    }],
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    requestKey: {
      type: String,
      trim: true,
      maxlength: 180,
    },
    source: {
      type: String,
      enum: ["Booking Cancellation", "Manual"],
      default: "Booking Cancellation",
      required: true,
    },
    customerName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },
    customerMobile: {
      type: String,
      default: "",
      trim: true,
      maxlength: 20,
    },
    vehicleName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
    vehicleNumber: {
      type: String,
      default: "",
      trim: true,
      maxlength: 30,
    },
    bookingAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    method: {
      type: String,
      enum: ["cash", "phonepe", "razorpay", "gpay", "upi", "bank_transfer"],
    },
    customerUpiId: {
      type: String,
      default: "",
      trim: true,
      maxlength: 256,
    },
    proofImageUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
    },
    reason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    utr: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
    completionProofImageUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "refunded", "rejected", "Pending", "Approved", "Refunded", "Rejected"],
      default: "pending",
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    refundedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    refundedAt: {
      type: Date,
      default: null,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

refundSchema.index(
  { requestKey: 1 },
  { unique: true, partialFilterExpression: { requestKey: { $type: "string" } } },
);
refundSchema.index({ bookingId: 1, status: 1 });
refundSchema.index({ company: 1, status: 1, createdAt: -1 });

export default mongoose.model("Refund", refundSchema);
