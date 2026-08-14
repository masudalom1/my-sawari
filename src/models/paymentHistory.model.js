import mongoose from "mongoose";

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
      enum: ["cash", "phonePe", "razorpay", "mixed"],
      default: "cash",
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
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("PaymentHistory", paymentHistorySchema);