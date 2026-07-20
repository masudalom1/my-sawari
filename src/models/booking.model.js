import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    // =========================
    // RELATIONS
    // =========================

    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      index: true,
    },

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

    // =========================
    // BOOKING ID
    // =========================

    bookingCode: {
      type: String,
      unique: true,
      index: true,
    },

    // =========================
    // CUSTOMER DETAILS
    // =========================
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      index: true,
    },

    customerName: {
      type: String,
      required: true,
      trim: true,
    },

    mobileNumber: {
      type: String,
      required: true,
      trim: true,
    },

    alternateMobileNumber: {
      type: String,
      default: "",
      trim: true,
    },

    occupation: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // ID DETAILS
    // =========================

    aadhaarNumber: {
      type: String,
      default: "",
      trim: true,
    },

    drivingLicenseNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    // =========================
    // TRIP DETAILS
    // =========================

    destination: {
      type: String,
      default: "",
      trim: true,
    },

    tripType: {
      type: String,
      enum: ["local", "outstation"],
      default: "local",
    },

    fromDate: {
      type: Date,
      required: true,
    },

    toDate: {
      type: Date,
      required: true,
    },

    pickupTime: {
      type: String,
      default: "09:00 AM",
      trim: true,
    },

    dropTime: {
      type: String,
      default: "06:00 PM",
      trim: true,
    },

    totalDays: {
      type: Number,
      default: 1,
      min: 1,
    },

    residents: {
      type: Number,
      default: 1,
      min: 1,
    },

    // =========================
    // VEHICLE
    // =========================

    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
    },

    vehicleName: {
      type: String,
      default: "",
      trim: true,
    },

    vehicleNumber: {
      type: String,
      default: "",
      trim: true,
    },

    vehicleColor: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // PRICING
    // =========================

    quotationAmount: {
      type: Number,
      default: 0,
    },

    bookingAmount: {
      type: Number,
      default: 0,
    },

    discountAmount: {
      type: Number,
      default: 0,
    },
    securityDeposit: {
      type: Number,
      default: 0,
      min: 0,
    },

    // =========================
    // PICKUP / DROP SERVICE
    // =========================

    pickupDropRequired: {
      type: Boolean,
      default: false,
    },

    serviceType: {
      type: String,
      enum: ["pickup", "drop", "pickup_drop"],
      default: "pickup_drop",
    },

    pickup: {
      location: {
        type: String,
        default: "",
        trim: true,
      },

      landmark: {
        type: String,
        default: "",
        trim: true,
      },

      mapLink: {
        type: String,
        default: "",
        trim: true,
      },

      charge: {
        type: Number,
        default: 0,
        min: 0,
      },
    },

    drop: {
      location: {
        type: String,
        default: "",
        trim: true,
      },

      landmark: {
        type: String,
        default: "",
        trim: true,
      },

      mapLink: {
        type: String,
        default: "",
        trim: true,
      },

      charge: {
        type: Number,
        default: 0,
        min: 0,
      },
    },

    pickupDropNotes: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // STATUS
    // =========================

    status: {
      type: String,
      enum: [
        "confirmed",
        "handover_pending",
        "vehicle_handover",
        "active",
        "completed",
        "cancelled",
      ],
      default: "confirmed",
      index: true,
    },

    // =========================
    // HANDOVER
    // =========================

    handover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Handover",
      default: null,
    },

    // =========================
    // RETURN
    // =========================

    vehicleReturn: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VehicleReturn",
      default: null,
    },

    // =========================
    // NOTES
    // =========================

    remarks: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // SOFT DELETE
    // =========================

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: Date,

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

// =========================
// AUTO BOOKING CODE
// =========================

bookingSchema.pre("save", function () {
  if (!this.bookingCode) {
    const random = Math.floor(1000 + Math.random() * 9000);
    this.bookingCode = `BK${Date.now()}${random}`;
  }
});

// =========================
// INDEXES
// =========================

bookingSchema.index({
  company: 1,
  status: 1,
});

bookingSchema.index({
  company: 1,
  lead: 1,
});

bookingSchema.index({
  company: 1,
  vehicleId: 1,
});

bookingSchema.index({
  company: 1,
  mobileNumber: 1,
});

bookingSchema.index({
  company: 1,
  fromDate: 1,
});

bookingSchema.index({
  company: 1,
  toDate: 1,
});

bookingSchema.index({
  company: 1,
  createdAt: -1,
});

export default mongoose.model("Booking", bookingSchema);
