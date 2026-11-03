import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { allocateRevenuePayment, normalizeRevenueChannelSplit } from "../src/services/paymentAllocation.service.js";
import { classifyPayment, summarizePayments, paymentReportRow } from "../shared/paymentReporting.mjs";
import { paymentAmount } from "../src/utils/revenue.utils.js";

test("backend revenue allocation and reporting match the 289-case compatibility baseline", () => {
  const methods = ["cash", "phonepe", "razorpay", "mixed", "gpay", "PhonePe", " google_pay ", null];
  const breakdowns = [null, {}, { cash: 40, phonePe: 60 }, { cash: 40 }, { cash: 80, phonePe: 60 },
    { gpay: 100 }, { cash: "0.10", phonePe: "0.20" }, { cash: -10, phonePe: 5 }, { cash: "invalid", razorpay: 10 }];
  const payments = [];
  for (const paymentMethod of methods) for (const paymentBreakdown of breakdowns) for (const amount of [100, 0, null, "100.10"]) {
    payments.push({ _id: String(payments.length), vehicleId: "v", createdAt: "2026-10-15T12:00:00Z", type: "booking", paymentMethod, paymentBreakdown, amount });
  }
  payments.push({ _id: "refund", vehicleId: "v", createdAt: "2026-10-15T12:00:00Z", type: "refund", paymentMethod: "cash", amount: 15 });
  const expected = payments.map((payment) => ({
    id: payment._id,
    split: allocateRevenuePayment(payment),
    classification: classifyPayment(payment),
  }));
  const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  assert.equal(digest, "866736a7ddbf307571a1d468e64e0e30dcab76673e1b240f4497607426b5f586");
});

test("both adapters use the same breakdown-first and single-method rules for supported valid amounts", () => {
  for (const p of [
    { amount: 100, paymentMethod: "cash" },
    { amount: 100, paymentMethod: "phonepe", paymentBreakdown: {} },
    { amount: 100, paymentMethod: "razorpay" },
    { amount: 100, paymentMethod: "mixed", paymentBreakdown: { cash: 40, phonePe: 60 } },
    { amount: 100, paymentMethod: "mixed", paymentBreakdown: { cash: 40 } },
    { amount: 100, paymentMethod: "mixed", paymentBreakdown: { cash: 80, phonePe: 60 } },
  ]) {
    const revenue = allocateRevenuePayment(p);
    const report = classifyPayment(p);
    for (const key of ["cash", "phonepe", "razorpay"]) assert.equal(revenue[key] * 100, report.channels[key]);
  }
});

test("Revenue compatibility remains explicit without weakening All Payments safeguards", () => {
  assert.equal(allocateRevenuePayment({ amount: 100, paymentMethod: "gpay" }).unspecified, 100);
  assert.equal(classifyPayment({ amount: 100, paymentMethod: "gpay" }).channels.gpay, 10000);
  assert.equal(paymentAmount({ amount: 0, paymentBreakdown: { cash: 40, phonePe: 60 } }), 100);
  assert.equal(classifyPayment({ amount: 0, paymentMethod: "mixed", paymentBreakdown: { cash: 40, phonePe: 60 } }).allocationValid, false);
});

test("Revenue amount helper accepts explicit validated report parsing without a legacy fallback", () => {
  const parseAmount = (value) => value === 1300 ? 130000 : null;
  assert.equal(paymentAmount({ amount: 1300 }, { parseAmount, fallbackToBreakdown: false }), 130000);
  assert.equal(paymentAmount({ amount: "invalid", paymentBreakdown: { cash: 100 } }, { parseAmount, fallbackToBreakdown: false }), null);
  // Default Revenue calls continue their historical breakdown fallback.
  assert.equal(paymentAmount({ amount: 0, paymentBreakdown: { cash: 100 } }), 100);
});

test("Revenue allocation helper can allocate validated four-channel paise without changing its defaults", () => {
  const options = { channels: { cash: 100000, phonepe: 30000, gpay: 0, razorpay: 0 }, clearEmpty: false, includeUnspecified: false };
  assert.deepEqual(allocateRevenuePayment({ paymentMethod: "mixed" }, 130000, options), options.channels);
  assert.deepEqual(allocateRevenuePayment({ paymentMethod: "gpay" }, 10000, { ...options, channels: { cash: 0, phonepe: 0, gpay: 0, razorpay: 0 } }), { cash: 0, phonepe: 0, gpay: 10000, razorpay: 0 });
  assert.deepEqual(allocateRevenuePayment({ paymentMethod: "cash" }, 10000, { ...options, canFallback: false, channels: { cash: null, phonepe: 0, gpay: 0, razorpay: 0 } }), { cash: null, phonepe: 0, gpay: 0, razorpay: 0 });
  assert.deepEqual(allocateRevenuePayment({ amount: 100, paymentMethod: "gpay" }), { cash: 0, phonepe: 0, razorpay: 0, unspecified: 100 });
});

test("four-channel API splits cannot introduce NaN or a new Revenue display bucket", () => {
  const payment = { _id: "p", vehicleId: "v", createdAt: "2026-08-16T12:00:51.349Z", type: "booking",
    amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, gpay: 300 },
    channelSplit: { cash: 1000, phonepe: 0, gpay: 300, razorpay: 0, unspecified: 0 } };
  const split = normalizeRevenueChannelSplit(payment.channelSplit);
  assert.deepEqual(split, { cash: 1000, phonepe: 0, razorpay: 0, unspecified: 300 });
  assert.ok(Object.values(split).every(Number.isFinite));
  assert.equal(Object.values(split).reduce((sum, value) => sum + value, 0), 1300);
  const classified = classifyPayment(payment);
  assert.equal(classified.channels.cash, 100000);
  assert.equal(classified.channels.gpay, 30000);
  assert.equal(Object.values(classified.channels).reduce((sum, value) => sum + value, 0), 130000);
});

test("legacy split normalization preserves PhonePe and refuses nonfinite or unknown API fields", () => {
  const legacy = { cash: 0, phonepe: 300, razorpay: 0, unspecified: 0 };
  assert.deepEqual(normalizeRevenueChannelSplit(legacy), legacy);
  assert.deepEqual(allocateRevenuePayment({ amount: 300, paymentMethod: "gpay", paymentBreakdown: { phonePe: 300 } }), legacy);
  for (const split of [{ gpay: NaN }, { gpay: Infinity }, { cash: "100" }, { unsupported: 100 }, []]) assert.equal(normalizeRevenueChannelSplit(split), null);
  assert.deepEqual(normalizeRevenueChannelSplit({ gpay: 200, unspecified: 50 }), { cash: 0, phonepe: 0, razorpay: 0, unspecified: 250 });
});

test("company, vehicle and date scopes retain the backend's explicit GPay compatibility mapping", () => {
  const payments = [
    { amount: 100, paymentMethod: "cash", type: "booking" },
    { amount: 200, paymentMethod: "gpay", type: "handover", paymentBreakdown: { gpay: 200 } },
    { amount: 100, paymentMethod: "mixed", type: "booking", paymentBreakdown: { cash: 40, phonePe: 60 } },
    { amount: 30, paymentMethod: "cash", type: "refund" },
  ].map((payment, index) => ({ ...payment, _id: String(index), company: "company-a", vehicleId: "v", createdAt: "2026-08-16T12:00:51.349Z" }));
  payments.push(
    { ...payments[0], _id: "foreign", company: "company-b", amount: 9000 },
    { ...payments[0], _id: "outside-date", createdAt: "2026-08-17T12:00:00Z", amount: 8000 },
    { ...payments[0], _id: "other-vehicle", vehicleId: "other", amount: 7000 },
  );
  // Compare explicitly equivalent datasets, not Revenue's unscoped import API
  // against the configured-company All Payments API.
  const companyPayments = payments.filter((p) => p.company === "company-a");
  const scoped = companyPayments.filter((p) => p.vehicleId === "v" && p.createdAt >= "2026-08-15T18:30:00.000Z" && p.createdAt < "2026-08-16T18:30:00.000Z");
  const chart = summarizePayments(scoped.map(paymentReportRow)).channelSummary;
  assert.deepEqual(
    { total: chart.total, cash: chart.cash, phonepe: chart.phonepe, razorpay: chart.razorpay, gpay: chart.gpay, unallocatedTotal: chart.unallocatedTotal },
    { total: 400, cash: 140, phonepe: 60, razorpay: 0, gpay: 200, unallocatedTotal: 0 },
  );
});
