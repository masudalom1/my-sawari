import mongoose from "mongoose";

const inspectionItemSchema = new mongoose.Schema(
  {
    itemName: {
      type: String,
      required: true,
      trim: true,
    },

    condition: {
      type: String,
      enum: ["good", "minor", "major"],
      required: true,
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false },
);

/* ==========================
   DAMAGE COST DETAILS
========================== */

const damageCostDetailsSchema = new mongoose.Schema(
  {
    repairEstimate: {
      type: Number,
      default: 0,
      min: 0,
    },

    repairDays: {
      type: Number,
      default: 0,
      min: 0,
    },

    actualRepairCost: {
      type: Number,
      default: 0,
      min: 0,
    },

    repairBill: {
      type: String,
      default: "",
    },

    repairedAt: {
      type: Date,
    },

    remarks: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["Pending", "Under Repair", "Completed", "Closed"],
      default: "Pending",
    },
  },
  { _id: false },
);

/* ==========================
   PAYMENT SETTLEMENT DETAILS
========================== */

const settlementDetailsSchema = new mongoose.Schema(
  {
    /*
      Existing pending amount
      from booking/handover
    */
    pendingAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Auto calculated
      editable by executive
    */
    lateReturnFine: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Auto calculated
      editable by executive
    */
    extraKmFine: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Fuel shortage amount
    */
    fuelUsageAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Damage estimate included
      for settlement calculations
    */
    damageAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Pending + fines + fuel + damage
    */
    totalBalanceAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Amount collected
      during return
    */
    amountCollected: {
      type: Number,
      default: 0,
      min: 0,
    },

 paymentMode: {
  type: String,
  enum: ["Cash", "PhonePe", "Razorpay", "Mixed"],
  default: "Cash",
},

paymentBreakdown: {
  cash: {
    type: Number,
    default: 0,
    min: 0,
  },

  phonePe: {
    type: Number,
    default: 0,
    min: 0,
  },

  razorpay: {
    type: Number,
    default: 0,
    min: 0,
  },
},

    /*
      Remaining amount
    */
    finalBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
      Mandatory if
      finalBalance > 0
    */
    balanceReason: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["Collected", "Partially Collected", "Pending Collection"],
      default: "Pending Collection",
    },

    settledAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

/* ==========================
   MAIN SCHEMA
========================== */

const vehicleReturnSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    handover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Handover",
      required: true,
      unique: true,
    },

    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      index: true,
    },

    customerName: {
      type: String,
      default: "",
      trim: true,
    },

    fuelLevel: {
      type: Number,
      min: 0,
      max: 7,
    },

    kilometersAtReturn: {
      type: Number,
      required: true,
      min: 0,
    },

    hasDamage: {
      type: Boolean,
      default: false,
    },

    damageNotes: {
      type: String,
      default: "",
      trim: true,
    },

    inspection: {
      type: [inspectionItemSchema],
      default: [],
    },

    /* ======================
       VEHICLE RETURN IMAGES
    ====================== */

    images: {
      vehicleFront: {
        type: String,
        default: "",
      },

      vehicleRear: {
        type: String,
        default: "",
      },

      vehicleLeft: {
        type: String,
        default: "",
      },

      vehicleRight: {
        type: String,
        default: "",
      },
    },

    /* ======================
       DAMAGE IMAGES
    ====================== */

    damageImages: {
      type: [String],
      default: [],
    },
    additionalImages: {
      type: [String],
      default: [],
    },

    /* ======================
       DAMAGE DETAILS
    ====================== */

    damageCostDetails: {
      type: damageCostDetailsSchema,
      default: () => ({}),
    },

    /* ======================
       RETURN SETTLEMENT
    ====================== */

    settlementDetails: {
      type: settlementDetailsSchema,
      default: () => ({}),
    },

    returnStatus: {
      type: String,
      enum: ["completed"],
      default: "completed",
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    receivingTime: {
      type: Date,
    },

    scheduledReturnTime: {
      type: Date,
    },

    timeStatus: {
      type: String,
      enum: ["Before Time", "On Time", "Delayed"],
    },

    delayInMinutes: {
      type: Number,
      default: 0,
    },

    delayText: {
      type: String,
      default: "",
    },
  },

  {
    timestamps: true,
  },
);

/* ==========================
   VALIDATIONS
========================== */

vehicleReturnSchema.pre("save", async function () {
  const settlement = this.settlementDetails || {};

  if (settlement.finalBalance > 0 && !settlement.balanceReason?.trim()) {
    throw new Error("Reason is required when balance amount remains");
  }
});

/* ==========================
   INDEXES
========================== */

// Pending collections
vehicleReturnSchema.index({
  "settlementDetails.status": 1,
});

// Outstanding balances
vehicleReturnSchema.index({
  "settlementDetails.finalBalance": 1,
});

// Damage workflow
vehicleReturnSchema.index({
  "damageCostDetails.status": 1,
});

// Company dashboard
vehicleReturnSchema.index({
  company: 1,
  createdAt: -1,
});

// Vehicle history
vehicleReturnSchema.index({
  vehicle: 1,
  createdAt: -1,
});

// Customer collections
vehicleReturnSchema.index({
  customerName: 1,
});

export default mongoose.model("VehicleReturn", vehicleReturnSchema);
