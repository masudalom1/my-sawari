import mongoose from "mongoose";

const customerActivitySchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    mobileNumber: String,
    sessionId: String,
    action: String,
    screen: String,
    details: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: true,
    collection: "customer_activity",
    autoCreate: false,
    autoIndex: false,
  },
);

export default mongoose.model("CustomerActivity", customerActivitySchema);
