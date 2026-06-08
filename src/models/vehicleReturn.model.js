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
  { _id: false }
);

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

    amountCollected: {
      type: Number,
      default: 0,
      min: 0,
    },

    paymentMode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Bank Transfer"],
      default: "Cash",
    },

    status: {
      type: String,
      enum: [
        "Pending",
        "Partially Collected",
        "Collected",
        "Pending Collection",
        "Refund Required",
        "Closed",
      ],
      default: "Pending",
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

    balanceAmount: {
      type: Number,
      default: 0,
    },

    refundAmount: {
      type: Number,
      default: 0,
    },

    repairedAt: {
      type: Date,
    },

    remarks: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

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
      enum: [0, 25, 50, 75, 100],
      required: true,
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

    // Mandatory vehicle images
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

    // Multiple damage images
    damageImages: {
      type: [String],
      default: [],
    },

    // Damage collection details
    damageCostDetails: {
      type: damageCostDetailsSchema,
      default: () => ({}),
    },

    returnStatus: {
      type: String,
      enum: ["completed"],
      default: "completed",
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for filtering Damage Cost Collection screen
vehicleReturnSchema.index({
  "damageCostDetails.status": 1,
});

vehicleReturnSchema.index({
  company: 1,
  createdAt: -1,
});

export default mongoose.model(
  "VehicleReturn",
  vehicleReturnSchema
);