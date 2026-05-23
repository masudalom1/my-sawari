import mongoose from "mongoose";

const handoverSchema = new mongoose.Schema(
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

    customer: {
      fullName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 100,
      },

      mobileNumber: {
        type: String,
        required: true,
        trim: true,
      },

      alternateMobileNumber: {
        type: String,
        trim: true,
        default: "",
      },

      occupation: {
        type: String,
        trim: true,
        default: "",
      },

      destination: {
        type: String,
        required: true,
        trim: true,
        maxlength: 150,
      },
    },

    identity: {
      idType: {
        type: String,
        required: true,
        enum: [
          "aadhaar",
          "voter",
          "license",
          "pan",
          "company",
          "passport",
          "other",
        ],
      },

      idNumber: {
        type: String,
        required: true,
        trim: true,
        uppercase: true,
      },
    },

    vehicle: {
      vehicleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Vehicle",
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
        trim: true,
        uppercase: true,
      },

      vehicleColor: {
        type: String,
        trim: true,
        default: "",
      },
    },

    trip: {
      tripType: {
        type: String,
        enum: ["local", "outstation"],
        default: "local",
      },

      numberOfDays: {
        type: Number,
        required: true,
        min: 1,
      },

      pickupDateTime: {
        type: Date,
        required: true,
      },

      dropDateTime: {
        type: Date,
        required: true,
      },
    },

    payment: {
      fuelLevel: {
        type: String,
        enum: ["low", "medium", "high", "full"],
        default: "medium",
      },

      fastTagBalance: {
        type: Number,
        default: 0,
        min: 0,
      },

      fastTagPayableAmount: {
        type: Number,
        default: 0,
        min: 0,
      },

      totalFare: {
        type: Number,
        required: true,
        min: 0,
      },

      amountReceived: {
        type: Number,
        required: true,
        min: 0,
      },

      pendingAmount: {
        type: Number,
        default: 0,
        min: 0,
      },

      securityDeposit: {
        type: Number,
        default: 0,
        min: 0,
      },

      advancePaid: {
        type: Number,
        default: 0,
        min: 0,
      },

      extraCharges: {
        type: Number,
        default: 0,
        min: 0,
      },

      paymentMethod: {
        type: String,
        enum: [
          "cash",
          "upi",
          "card",
          "bank",
          "mixed",
        ],
        required: true,
      },

      paymentStatus: {
        type: String,
        enum: [
          "paid",
          "partial",
          "pending",
        ],
        default: "pending",
      },
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    images: {
      customerPhoto: {
        type: String,
        default: "",
      },

      customerWithVehicle: {
        type: String,
        default: "",
      },

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

    bookingStatus: {
      type: String,
      enum: [
        "draft",
        "confirmed",
        "active",
        "completed",
        "cancelled",
      ],
      default: "confirmed",
      index: true,
    },

  handoverStatus: {
  type: String,
  enum: ["active", "returned", "cancelled"],
  default: "active",
},

    returnDetails: {
      returnedAt: {
        type: Date,
      },

      returnedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },

      remarks: {
        type: String,
        trim: true,
        default: "",
      },

      vehicleCondition: {
        type: String,
        default: "",
      },
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

handoverSchema.pre("save", function () {
  if (this.payment?.totalFare !== undefined) {
    const totalFare = Number(this.payment.totalFare) || 0;
    const received = Number(this.payment.amountReceived) || 0;

    this.payment.pendingAmount = totalFare - received;

    if (this.payment.pendingAmount <= 0) {
      this.payment.pendingAmount = 0;
      this.payment.paymentStatus = "paid";
    } else if (received > 0) {
      this.payment.paymentStatus = "partial";
    } else {
      this.payment.paymentStatus = "pending";
    }
  }
});

const Handover = mongoose.model("Handover", handoverSchema);

export default Handover;