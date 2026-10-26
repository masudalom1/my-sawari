import mongoose from "mongoose";

const collectionEntrySchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: ["cash", "phonepe", "gpay", "razorpay"],
      default: "cash",
    },

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
    timestamps: { createdAt: "collectedAt", updatedAt: false },
  },
);

const paymentHistorySchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    customPaymentDate: {
      type: Date,
      default: null,
    },
    paymentDate: {
      type: Date,
      default: null,
    },
    paymentTime: {
      type: String,
      default: "",
      trim: true,
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
    booking: {
      fromDate: {
        type: Date,
        default: null,
      },
      toDate: {
        type: Date,
        default: null,
      },
      bookingAmount: {
        type: Number,
        default: 0,
        min: 0,
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
      enum: ["cash", "phonepe", "gpay", "razorpay", "mixed"],
      default: "cash",
    },

    upiLast4: {
      type: [String],
      default: [],
      validate: {
        validator: function (arr) {
          if (!Array.isArray(arr)) return false;
          return arr.every((v) => !v || /^\d{4}$/.test(String(v).trim()));
        },
        message: "Each UPI last 4 digits entry must contain exactly 4 numbers",
      },
    },

    transactionId: {
      type: String,
      default: "",
      trim: true,
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
      gpay: {
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

    isPhonePeCollected: {
      type: Boolean,
      default: false,
      index: true,
    },

    collectedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    collectedPhonePe: {
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

    lastCollectedByName: {
      type: String,
      default: "",
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

paymentHistorySchema.index({ paymentMethod: 1, isCollected: 1, createdAt: -1 });
paymentHistorySchema.index({ paymentMethod: 1, isCollected: 1, lastCollectedAt: -1 });
paymentHistorySchema.index({ paymentMethod: 1, isPhonePeCollected: 1, createdAt: -1 });
paymentHistorySchema.index({ paymentMethod: 1, isPhonePeCollected: 1, lastCollectedAt: -1 });
paymentHistorySchema.index({ paymentMethod: 1, createdAt: -1 });
paymentHistorySchema.index({ paymentMethod: 1, lastCollectedAt: -1 });
paymentHistorySchema.index({ createdAt: -1 });
paymentHistorySchema.index({ paymentDate: -1 });

paymentHistorySchema.pre("save", function () {
  if (!this.paymentDate && this.customPaymentDate) {
    this.paymentDate = this.customPaymentDate;
  }
  if (!this.customPaymentDate && this.paymentDate) {
    this.customPaymentDate = this.paymentDate;
  }
  if (!this.paymentTime && (this.paymentDate || this.customPaymentDate)) {
    const d = new Date(this.paymentDate || this.customPaymentDate);
    if (!isNaN(d.getTime())) {
      this.paymentTime = d.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
      });
    }
  }
  if (!this.transactionId && Array.isArray(this.upiLast4) && this.upiLast4.length > 0) {
    this.transactionId = this.upiLast4[0];
  }
  if ((!this.upiLast4 || this.upiLast4.length === 0) && this.transactionId) {
    const trimmedId = String(this.transactionId).trim();
    if (/^\d{4}$/.test(trimmedId)) {
      this.upiLast4 = [trimmedId];
    }
  }
});

export default mongoose.model("PaymentHistory", paymentHistorySchema);

/* =========================================================
   CASH HANDOVER
   ---------------------------------------------------------
   One row = a staff member gave collected cash to a manager.

   Rows are never deleted or edited. A wrong entry is VOIDED
   (status: "voided" + who/when/why), which puts the amount
   back on the staff member's held balance and keeps the
   audit trail intact.

   `seq` is a per-collector sequence number. The unique index
   on { collectorId, seq } makes two managers recording a
   handover for the same person at the same moment impossible:
   the second insert fails with a duplicate key and the API
   answers 409 instead of letting both through.
========================================================= */

const cashHandoverSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // Staff member who handed the cash over
    collectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    collectorName: {
      type: String,
      default: "",
    },

    // Manager who received it
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receivedByName: {
      type: String,
      default: "",
    },

    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },

    note: {
      type: String,
      default: "",
      maxlength: 500,
      trim: true,
    },

    handedOverAt: {
      type: Date,
      default: Date.now,
    },

    // Snapshot of the collector's held balance at the moment of handover
    balanceBefore: {
      type: Number,
      default: 0,
    },
    balanceAfter: {
      type: Number,
      default: 0,
    },

    seq: {
      type: Number,
      required: true,
    },

    status: {
      type: String,
      enum: ["active", "voided"],
      default: "active",
    },

    voidedAt: {
      type: Date,
      default: null,
    },
    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    voidedByName: {
      type: String,
      default: "",
    },
    voidReason: {
      type: String,
      default: "",
      maxlength: 500,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

cashHandoverSchema.index({ collectorId: 1, seq: 1 }, { unique: true });
cashHandoverSchema.index({ collectorId: 1, status: 1, handedOverAt: -1 });
cashHandoverSchema.index({ status: 1, handedOverAt: -1 });
cashHandoverSchema.index({ handedOverAt: -1 });

export const CashHandover = mongoose.model("CashHandover", cashHandoverSchema);
// Converts a date to its booking month in IST, e.g. "2026-10"
export function toBookingMonth(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
}