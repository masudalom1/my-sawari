import mongoose from "mongoose";

const { Schema } = mongoose;

// The "customers" collection is owned by the customer app. This backend only
// reads it (membership lookup), so the schema lists just the fields used here.
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
  },
  {
    timestamps: true,
    collection: "customers",
  }
);

export default mongoose.model("Customer", customerSchema);
