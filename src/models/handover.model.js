import mongoose from "mongoose";

const extensionBillSchema = new mongoose.Schema(
  {
    billNumber: {
      type: Number,
      required: true,
    },

    previousDropDateTime: { type: Date, required: true },
    newDropDateTime: { type: Date, required: true },

    previousNumberOfDays: { type: Number, required: true },
    newNumberOfDays: { type: Number, required: true },

    // Positive = extended further, negative = shortened
    extraDays: { type: Number, required: true },

    // The charge for this specific extension (its own bill line item)
    extensionAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // How much of "amountReceivedNow" was collected at the moment
    // this specific extension was made (for a per-bill receipt view)
    amountCollected: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Snapshot of totalFare right after this bill was applied, so
    // historic entries always render correctly even if later logic
    // or fields change
    totalFareAfterThisBill: {
      type: Number,
      required: true,
      min: 0,
    },

    reason: {
      type: String,
      default: "",
      trim: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

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

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      index: true,
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
      spareAvailable: {
        type: Boolean,
        required: true,
        default: false,
      },

      // NEW
      toolkitAvailable: {
        type: Boolean,
        required: true,
        default: false,
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
      billSummary: {
        totalFare: {
          type: Number,
          default: 0,
        },

        fastTagPayable: {
          type: Number,
          default: 0,
        },

        pickupCharge: {
          type: Number,
          default: 0,
        },

        dropCharge: {
          type: Number,
          default: 0,
        },

        securityDeposit: {
          type: Number,
          default: 0,
        },

        extraCharges: {
          type: Number,
          default: 0,
        },

        discountAmount: {
          type: Number,
          default: 0,
        },

        totalAmount: {
          type: Number,
          default: 0,
        },

        bookingAmountPaid: {
          type: Number,
          default: 0,
        },

        amountReceivedNow: {
          type: Number,
          default: 0,
        },

        totalCollected: {
          type: Number,
          default: 0,
        },

        balanceAmount: {
          type: Number,
          default: 0,
        },
      },
    },
    extensionBills: [extensionBillSchema],

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

      drivingLicenseFront: {
        type: String,
        default: "",
      },

      drivingLicenseBack: {
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

      damageImages: {
        type: [String],
        default: [],
      },
    },
    hasUploadedImages: {
      type: Boolean,
      default: false,
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
    assignedDriver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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
