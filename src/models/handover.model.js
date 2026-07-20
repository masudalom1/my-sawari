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
      aadhaarNumber: {
        type: String,
        required: true,
        trim: true,
      },

      drivingLicenseNumber: {
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

      handoverKm: {
        type: Number,
        required: true,
        min: 0,
        default: 0,
      },
    },

    vehicleHistory: [
      {
        oldVehicle: {
          vehicleId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Vehicle",
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

        newVehicle: {
          vehicleId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Vehicle",
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

        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },

        changedAt: {
          type: Date,
          default: Date.now,
        },

        reason: {
          type: String,
          default: "",
          trim: true,
        },
      },
    ],

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
        type: Number,
        min: 0,
        max: 7,
        default: 1,
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

      securityDeposit: {
        type: Number,
        default: 0,
        min: 0,
      },

      extraCharges: {
        type: Number,
        default: 0,
        min: 0,
      },
      discountAmount: {
        type: Number,
        default: 0,
        min: 0,
      },

      totalAmount: {
        type: Number,
        required: true,
        min: 0,
      },

      bookingAmountPaid: {
        type: Number,
        default: 0,
        min: 0,
      },

      amountReceivedNow: {
        type: Number,
        required: true,
        min: 0,
      },

      balanceAmount: {
        type: Number,
        default: 0,
        min: 0,
      },

      paymentMethod: {
        type: String,
        enum: ["cash", "phonepe", "razorpay", "mixed"],
        required: true,
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

      paymentStatus: {
        type: String,
        enum: ["paid", "partial", "pending"],
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
      customerProfileImage: {
        type: String,
        default: "",
      },

      customerWithVehicle: {
        type: String,
        default: "",
      },

      idCardFront: {
        type: String,
        default: "",
      },

      idCardBack: {
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
      enum: ["draft", "confirmed", "active", "completed", "cancelled"],
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
  if (this.payment) {
    const totalAmount = Number(this.payment.totalAmount) || 0;

    const bookingPaid = Number(this.payment.bookingAmountPaid) || 0;

    const receivedNow = Number(this.payment.amountReceivedNow) || 0;

    const totalPaid = bookingPaid + receivedNow;

    this.payment.balanceAmount = Math.max(0, totalAmount - totalPaid);

    if (this.payment.balanceAmount === 0) {
      this.payment.paymentStatus = "paid";
    } else if (totalPaid > 0) {
      this.payment.paymentStatus = "partial";
    } else {
      this.payment.paymentStatus = "pending";
    }
  }
});

const Handover = mongoose.model("Handover", handoverSchema);

export default Handover;
