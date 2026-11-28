import "dotenv/config";
import mongoose from "mongoose";
import PaymentHistory from "../src/models/paymentHistory.model.js";
import RefundRequest from "../src/models/refundRequest.model.js";

if (!process.env.MONGO_URI) {
  throw new Error("MONGO_URI is required to migrate refund request indexes.");
}

await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

try {
  const indexes = await RefundRequest.collection.indexes();
  const duplicateRefundLedger = await PaymentHistory.aggregate([
    { $match: { refundRequestId: { $type: "objectId" } } },
    { $group: { _id: "$refundRequestId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]);
  if (duplicateRefundLedger.length) {
    throw new Error(
      `Multiple payment ledger entries reference refund request ${duplicateRefundLedger[0]._id}. Resolve duplicates before migrating.`,
    );
  }

  const paymentIndexes = await PaymentHistory.collection.indexes();
  const oldRefundRequestIndex = paymentIndexes.find(
    (index) =>
      index.key?.refundRequestId === 1 &&
      (!index.unique ||
        index.partialFilterExpression?.refundRequestId?.$type !== "objectId"),
  );
  if (oldRefundRequestIndex) {
    await PaymentHistory.collection.dropIndex(oldRefundRequestIndex.name);
  }

  const legacyUniqueBookingIndex = indexes.find(
    (index) =>
      index.unique &&
      index.key?.bookingId === 1 &&
      !index.partialFilterExpression,
  );
  if (legacyUniqueBookingIndex) {
    await RefundRequest.collection.dropIndex(legacyUniqueBookingIndex.name);
  }

  await PaymentHistory.collection.createIndex(
    { refundRequestId: 1 },
    {
      name: "refundRequestId_1",
      unique: true,
      partialFilterExpression: { refundRequestId: { $type: "objectId" } },
    },
  );
  await RefundRequest.collection.createIndex(
    { requestKey: 1 },
    {
      name: "requestKey_1",
      unique: true,
      partialFilterExpression: { requestKey: { $type: "string" } },
    },
  );
  await RefundRequest.collection.createIndex(
    { bookingId: 1, status: 1 },
    { name: "bookingId_1_status_1" },
  );
  await RefundRequest.collection.createIndex(
    { company: 1, status: 1, createdAt: -1 },
    { name: "company_1_status_1_createdAt_-1" },
  );

  console.log("Refund request indexes are ready.");
} finally {
  await mongoose.disconnect();
}
