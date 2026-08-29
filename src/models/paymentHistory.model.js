import mongoose from "mongoose";

const collectionEntrySchema = new mongoose.Schema(
  {
    collectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    collectedByName: {
      type: String,
      default: "",
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    note: {
      type: String,
      default: "",
    },
  },
  {
    // `collectedAt` instead of the default `createdAt` — reads
    // naturally when this sub-doc is serialized to the frontend.
    timestamps: { createdAt: "collectedAt", updatedAt: false },
  },
);

const paymentHistorySchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },

    handoverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Handover",
      default: null,
      index: true,
    },

    // ==========================
    // CUSTOMER SNAPSHOT
    // ==========================
    customer: {
      fullName: {
        type: String,
        default: "",
      },
      mobileNumber: {
        type: String,
        default: "",
      },
    },

    // ==========================
    // VEHICLE SNAPSHOT
    // ==========================
    vehicle: {
      vehicleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Vehicle",
        default: null,
      },
      vehicleName: {
        type: String,
        default: "",
      },
      vehicleNumber: {
        type: String,
        default: "",
      },
    },

    // ==========================
    // PAYMENT
    // ==========================
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    paymentMethod: {
      type: String,
      enum: ["cash", "phonepe", "razorpay", "mixed"],
      default: "cash",
    },
    upiLast4: {
      type: String,
      default: "",
      trim: true,
      match: [/^\d{4}$/, "UPI last 4 digits must contain exactly 4 numbers"],
    },

    paymentBreakdown: {
      cash: {
        type: Number,
        default: 0,
      },
      phonePe: {
        type: Number,
        default: 0,
      },
      razorpay: {
        type: Number,
        default: 0,
      },
    },

    // ==========================
    // PAYMENT TYPE
    // ==========================
    type: {
      type: String,
      enum: [
        "booking",
        "handover",
        "rental",
        "extension",
        "additional_charge",
        "receive",
        "refund",
      ],
      required: true,
    },

    note: {
      type: String,
      default: "",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isCollected: {
      type: Boolean,
      default: false,
      index: true,
    },

    collectedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastCollectedAt: {
      type: Date,
      default: null,
    },

    lastCollectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Full audit trail — every collect action, by whoever performed it.
    collectionHistory: {
      type: [collectionEntrySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("PaymentHistory", paymentHistorySchema);
