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

    // Maintenance availability blocking period
    startDate: {
      type: Date,
      required: [true, "Maintenance start date is required"],
      index: true,
    },

    endDate: {
      type: Date,
      required: [true, "Maintenance end date is required"],
      index: true,
    },

    // Existing maintenance information
    // NOT required when creating simple MNT period

    maintenanceType: {
      type: String,
      enum: ["Major", "Minor"],
      trim: true,
    },

    title: {
      type: String,
      trim: true,
      default: "",
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    garage: {
      name: {
        type: String,
        trim: true,
        default: "",
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

    completedDate: {
      type: Date,
      default: null,
    },

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

    images: [{ type: String }],

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
  startDate: 1,
  endDate: 1,
});

maintenanceSchema.index({
  vehicle: 1,
  createdAt: -1,
});

export default mongoose.model("Maintenance", maintenanceSchema);