import mongoose from "mongoose";

const vehicleImageSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    publicId: {
      type: String,
      default: null,
    },
  },
  { _id: false },
);

// A finished deactivation, kept when the vehicle is reactivated.
const deactivationRecordSchema = new mongoose.Schema(
  {
    date: { type: Date, default: null },
    deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deactivatedAt: { type: Date, default: null },
    reason: { type: String, default: "" },
    notes: { type: String, default: "" },
    previousStatus: { type: String, default: null },
    reactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reactivatedAt: { type: Date, default: null },
    reactivationReason: { type: String, default: "" },
    reactivatedStatus: { type: String, default: null },
  },
  { _id: false },
);

const vehicleSchema = new mongoose.Schema(
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

    vehicleName: {
      type: String,
      required: true,
      trim: true,
    },

    // Friendly name employees can set/change (e.g. "Airport Innova 1").
    // Optional - falls back to vehicleName wherever it's shown.
    displayName: {
      type: String,
      trim: true,
      maxlength: [100, "Display name cannot exceed 100 characters"],
      default: "",
    },

    vehicleNumber: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
    },

    manufacturer: {
      type: String,
      required: true,
      trim: true,
    },

    model: {
      type: String,
      trim: true,
      default: "",
    },

    variant: {
      type: String,
      trim: true,
      default: "",
    },
    modelYear: {
      type: Number,
      min: 1886,
      max: 2100,
      validate: {
        validator: (value) => value == null || Number.isInteger(value),
        message: "Model year must be a whole number",
      },
      default: null,
    },
    pricePerDay: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isFinite,
        message: "Price per day must be a finite number",
      },
    },
    bookingAvailabilityVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    category: {
      type: String,
      enum: ["bike", "car"],
      lowercase: true,
      trim: true,
      index: true,
    },
    payments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PaymentHistory",
      },
    ],
    vehicleType: {
      type: String,
      enum: {
        values: [
          "SUV",
          "Sedan",
          "Hatchback",
          "Luxury",
          "Tempo Traveller",
          "Mini Bus",
          "Bus",
        ],
        message: "vehicleType must be a valid car body type",
      },
      required: function () {
        return this.category === "car";
      },
      default: undefined,
    },

    fuelType: {
      type: String,
      required: true,
      enum: ["Petrol", "Diesel", "Electric", "CNG", "Hybrid"],
    },

    transmission: {
      type: String,
      required: true,
      enum: ["Manual", "Automatic"],
    },

    seatingCapacity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "Seating capacity must be a whole number",
      },
    },

    color: {
      type: String,
      trim: true,
      default: "",
    },

    chassisNumber: {
      type: String,
      trim: true,
      default: "",
    },

    engineNumber: {
      type: String,
      trim: true,
      default: "",
    },

    registrationDate: {
      type: Date,
      default: null,
    },

    insuranceValidUpto: {
      type: Date,
      default: null,
    },

    pucValidUpto: {
      type: Date,
      default: null,
    },

    fitnessValidUpto: {
      type: Date,
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    images: [vehicleImageSchema],

    status: {
      type: String,
      enum: ["available", "rent", "service"],
      default: "available",
      index: true,
    },

    maintenance: {
      required: {
        type: Boolean,
        default: false,
      },
      currentMaintenance: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Maintenance",
        default: null,
      },

      maintenanceHistory: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Maintenance",
        },
      ],

      reason: {
        type: String,
        default: "",
        trim: true,
      },

      estimatedDays: {
        type: Number,
        default: 0,
      },

      estimatedCompletionDate: {
        type: Date,
        default: null,
      },

      markedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      markedAt: {
        type: Date,
        default: null,
      },
    },

    // Fleet Manager deactivation. `date` is the last bookable calendar day
    // (India time; a UTC day key, like booking dates). From 12:00 AM on the
    // next day the vehicle cannot be booked. The vehicle and its booking
    // history are kept; see shared/vehicleDeactivation.mjs.
    deactivation: {
      date: {
        type: Date,
        default: null,
      },
      deactivatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      deactivatedAt: {
        type: Date,
        default: null,
      },
      // Why staff deactivated it (a code from DEACTIVATION_REASONS; checked
      // by the API so older free-text values stay valid), optional notes,
      // and its operational status at that moment.
      reason: {
        type: String,
        trim: true,
        maxlength: 500,
        default: "",
      },
      notes: {
        type: String,
        trim: true,
        maxlength: 500,
        default: "",
      },
      previousStatus: {
        type: String,
        enum: ["available", "rent", "service", null],
        default: null,
      },
    },

    // Every earlier deactivation, oldest first, with its reactivation.
    deactivationHistory: {
      type: [deactivationRecordSchema],
      default: [],
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

vehicleSchema.index({
  company: 1,
  vehicleNumber: 1,
});

export default mongoose.model("Vehicle", vehicleSchema);