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
  { _id: false }
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
       pricePerDay: {
      type: Number,
      default: 0,
      min: 0,
    },

    vehicleType: {
      type: String,
      required: true,
      enum: [
        "SUV",
        "Sedan",
        "Hatchback",
        "Luxury",
        "Tempo Traveller",
        "Mini Bus",
        "Bus",
      ],
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

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

vehicleSchema.index({
  company: 1,
  vehicleNumber: 1,
});

export default mongoose.model("Vehicle", vehicleSchema);