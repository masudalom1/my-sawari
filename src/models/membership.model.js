import mongoose from "mongoose";

const { Schema } = mongoose;

export const MEMBERSHIP_PLANS = ["starter", "plus", "pro"];

// The "memberships" collection is shared with the customer app, which creates
// and renews memberships. Fleet Control only reads it. Memberships do not
// store a mobile number: look up the Customer first, then match customerId.
const membershipSchema = new Schema(
  {
    membershipId: {
      type: String,
      trim: true,
    },

    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    customerName: {
      type: String,
      trim: true,
    },

    createdBy: {
      type: String,
      enum: ["customer_app", "operation_app"],
    },

    plan: {
      type: String,
      enum: MEMBERSHIP_PLANS,
    },

    activatedAt: {
      type: Date,
    },

    expiresAt: {
      type: Date,
    },

    totalSaved: {
      type: Number,
      default: 0,
    },

    payment: {
      amount: Number,
      paymentMethod: String,
      paymentBreakdown: Schema.Types.Mixed,
      upiLastFour: String,
      paymentId: String,
      transactionId: String,
      status: String,
      paidAt: Date,
    },
  },
  {
    timestamps: true,
    collection: "memberships",
    toJSON: {
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

membershipSchema.index({ membershipId: 1 }, { unique: true });
membershipSchema.index({ customerId: 1 }, { unique: true });

export default mongoose.model("Membership", membershipSchema);
