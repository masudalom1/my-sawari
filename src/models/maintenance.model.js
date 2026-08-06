import mongoose from "mongoose";

const { Schema } = mongoose;

const maintenanceSchema = new Schema(
  {
    vehicle: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
      required: [true, "Vehicle is required"],
      index: true,
    },

    maintenanceType: {
      type: String,
      enum: ["Major", "Minor"],
      required: [true, "Maintenance type is required"],
      trim: true,
    },

    title: {
      type: String,
      required: [true, "Maintenance title is required"],
      trim: true,
    },

    description: {
      type: String,
      required: [true, "Maintenance description is required"],
      trim: true,
    },

    garage: {
      name: {
        type: String,
        required: [true, "Garage name is required"],
        trim: true,
      },
      contact: {
        type: String,
        trim: true,
        default: "",
      },
      address: {
        type: String,
        trim: true,
        default: "",
      },
      gstin: {
        type: String,
        trim: true,
        default: "",
      },
    },

    costs: {
      partsCost: {
        type: Number,
        default: 0,
        min: 0,
      },

      labourCost: {
        type: Number,
        default: 0,
        min: 0,
      },

      totalCost: {
        type: Number,
        default: 0,
        min: 0,
      },
    },

    odometer: {
      type: Number,
      default: null,
      min: 0,
    },

    expectedCompletionDate: {
      type: String,
      trim: true,
      default: "",
    },

    // Set automatically when status transitions to "Completed"
    completedDate: {
      type: Date,
      default: null,
    },

    // Proof of completion — captured when status moves to "Completed"
    completionProof: {
      billImage: {
        type: String,
        default: "",
      },
      cardImage: {
        type: String,
        default: "",
      },
      note: {
        type: String,
        trim: true,
        default: "",
      },
    },

    images: {
      type: [String],
      default: [],
    },

    additionalNotes: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: ["Scheduled", "In Progress", "Completed", "Cancelled"],
      default: "Scheduled",
    },

    // Lightweight audit trail of status changes
    statusHistory: {
      type: [
        {
          status: {
            type: String,
            enum: ["Scheduled", "In Progress", "Completed", "Cancelled"],
            required: true,
          },
          changedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
          },
          note: {
            type: String,
            trim: true,
            default: "",
          },
          changedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

maintenanceSchema.index({
  vehicle: 1,
  createdAt: -1,
});

export default mongoose.model("Maintenance", maintenanceSchema);