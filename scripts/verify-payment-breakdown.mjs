// Read-only verification using the application's configured connection.
// Never print credentials, payment documents, or customer information.
import dotenv from "dotenv";
import mongoose from "mongoose";
import assert from "node:assert/strict";
import { paymentCreatedAtRange, paymentReportRow, summarizePayments } from "../shared/paymentReporting.mjs";
import { allocateRevenuePayment } from "../src/services/paymentAllocation.service.js";
import { paymentClassificationStages, paymentSummaryStages } from "../src/services/paymentReport.pipeline.js";
import { resolvePaymentReportScope } from "../src/services/paymentReportScope.js";

dotenv.config({ quiet: true });
try {
  if (!process.env.MONGO_URI) throw new Error("Missing connection configuration");
  await mongoose.connect(process.env.MONGO_URI, { dbName: "data", autoIndex: false, serverSelectionTimeoutMS: 10000 });
  const { company } = resolvePaymentReportScope();
  const collection = mongoose.connection.db.collection("paymenthistories");
  const match = { company };
  const projection = { _id: 0, amount: 1, paymentMethod: 1, paymentBreakdown: 1, type: 1, collectedAmount: 1, collectedPhonePe: 1, isCollected: 1 };
  const records = await collection.find(match, { projection, maxTimeMS: 30000 }).toArray();
  const expected = summarizePayments(records.map(paymentReportRow));
  const result = await collection.aggregate([{ $match: match }, ...paymentClassificationStages(), ...paymentSummaryStages()], { maxTimeMS: 30000 }).toArray();
  const { totalMatchingRecords = 0, ...computed } = result[0] || {};
  assert.deepEqual({ ...summarizePayments([]), ...computed }, expected);
  assert.equal(totalMatchingRecords, records.length);
  const example = { amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 300, razorpay: 0 }, createdAt: new Date("2026-08-16T12:00:51.349Z") };
  const row = paymentReportRow(example);
  assert.deepEqual(row.channels, { cash: 100000, gpay: 0, phonepe: 30000, razorpay: 0 });
  assert.equal(row.amountPaise, 130000);
  assert.equal(row.differencePaise, 0);
  assert.deepEqual(allocateRevenuePayment(example), { cash: 1000, phonepe: 300, razorpay: 0, unspecified: 0 });
  const exact = { amount: example.amount, paymentMethod: example.paymentMethod, createdAt: example.createdAt,
    "paymentBreakdown.cash": 1000, "paymentBreakdown.phonePe": 300, "paymentBreakdown.razorpay": 0 };
  const liveMatches = await collection.countDocuments(exact, { maxTimeMS: 30000 });
  const scopedMatches = await collection.countDocuments({ ...match, ...exact }, { maxTimeMS: 30000 });
  const customBounds = paymentCreatedAtRange("2026-08-16", "2026-08-16");
  const exactWithinCustom = { $and: [exact, { createdAt: customBounds }] };
  // Diagnostic audit of the user-specified record, not an application report or
  // a change to company access. Do not expose IDs, customer data or company IDs.
  const exactRecords = await collection.find(exactWithinCustom, { projection, maxTimeMS: 30000 }).toArray();
  const exactResult = await collection.aggregate([{ $match: exactWithinCustom }, ...paymentClassificationStages(), ...paymentSummaryStages()], { maxTimeMS: 30000 }).toArray();
  const { totalMatchingRecords: exactCount = 0, ...exactComputed } = exactResult[0] || {};
  const exactSummary = { ...summarizePayments([]), ...exactComputed };
  assert.equal(exactCount, liveMatches);
  assert.deepEqual(exactSummary, summarizePayments(exactRecords.map(paymentReportRow)));
  for (const stored of exactRecords) {
    assert.deepEqual(paymentReportRow(stored).channels, row.channels);
    assert.deepEqual(allocateRevenuePayment(stored), allocateRevenuePayment(example));
  }
  assert.deepEqual([exactSummary.cash, exactSummary.gpay, exactSummary.phonepe, exactSummary.razorpay, exactSummary.total],
    [1000 * liveMatches, 0, 300 * liveMatches, 0, 1300 * liveMatches]);
  const dayMatch = { ...match, createdAt: customBounds };
  const dayRows = await collection.find(dayMatch, { projection, maxTimeMS: 30000 }).toArray();
  const daySummary = summarizePayments(dayRows.map(paymentReportRow));
  const dayResult = await collection.aggregate([{ $match: dayMatch }, ...paymentClassificationStages(), ...paymentSummaryStages()], { maxTimeMS: 30000 }).toArray();
  const { totalMatchingRecords: dayCount = 0, ...dayComputed } = dayResult[0] || {};
  assert.deepEqual({ ...summarizePayments([]), ...dayComputed }, daySummary);
  assert.equal(dayCount, dayRows.length);
  console.log(JSON.stringify({ database: "data", collection: "paymenthistories", scope: "configured reporting company", parity: "passed", summary: expected,
    requestedExample: { calculation: "passed", revenueParity: "passed", liveExactMatches: liveMatches, configuredCompanyExactMatches: scopedMatches, diagnosticOnlyLiveSummary: exactSummary },
    custom16August2026: { fromUTC: dayMatch.createdAt.$gte.toISOString(), toExclusiveUTC: dayMatch.createdAt.$lt.toISOString(), parity: "passed", summary: daySummary },
  }, null, 2));
} catch (error) {
  // Connection exceptions may contain credential-bearing URLs; print type only.
  console.error(JSON.stringify({ verification: "failed", errorType: error.name, assertion: error.code === "ERR_ASSERTION" ? "JavaScript/MongoDB reconciliation mismatch" : undefined }));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
