import mongoose from "mongoose";

const { Schema } = mongoose;

// The "customers" collection is owned by the customer app; this backend reads
// the shared profile fields without writing to it.
const customerSchema = new Schema(
  {
    customerName: {
      type: String,
      trim: true,
    },

    // Stored as a bare 10-digit number, unique per customer
    mobileNumber: {
      type: String,
      trim: true,
    },

    status: {
      type: String,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
    },

    walletBalance: {
      type: Number,
    },
  },
  {
    timestamps: true,
    collection: "customers",
  }
);

export default mongoose.model("Customer", customerSchema);
