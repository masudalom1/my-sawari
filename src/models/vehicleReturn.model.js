import mongoose from "mongoose";

const inspectionItemSchema = new mongoose.Schema(
  {
    itemName: {
      type: String,
      required: true,
    },
    condition: {
      type: String,
      enum: ["good", "minor", "major"],
      required: true,
    },
    note: {
      type: String,
      default: "",
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
    },

    customerName: {
      type: String,
      default: "",
    },

    fuelLevel: {
      type: Number,
      enum: [0, 25, 50, 75, 100],
      required: true,
    },

    kilometersAtReturn: {
      type: Number,
      required: true,
    },

    hasDamage: {
      type: Boolean,
      default: false,
    },

    damageNotes: {
      type: String,
      default: "",
    },

    inspection: [inspectionItemSchema],

    images: {
      vehicleFront: String,
      vehicleRear: String,
      vehicleLeft: String,
      vehicleRight: String,
      damageImage: String,
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

export default mongoose.model(
  "VehicleReturn",
  vehicleReturnSchema
);