// New Booking payment methods: Cash, PhonePe, Google Pay ("gpay"), Razorpay
// and Mixed are stored with the same values the payment reports already read.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";
import { paymentReportRow } from "../shared/paymentReporting.mjs";

let ctx;
let api;
let vehicleId;
let Booking;
let PaymentHistory;
let slot = 0;

before(async () => {
  ctx = await startTestApp();
  api = client(ctx.base, (await createUserAndLogin(ctx.base)).token);
  const created = await api("POST", "/vehicles/create", { vehicleName: "Swift Pay", vehicleNumber: "KA01PM0001", manufacturer: "Maruti", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
  assert.equal(created.status, 201, created.json.message);
  vehicleId = created.json.data._id;
  assert.equal((await api("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
});

after(async () => {
  await ctx?.stop();
});

// Each booking gets its own non-overlapping dates on the same vehicle.
function book(extra) {
  slot += 1;
  return api("POST", "/leads/create", {
    customerName: "Asha", mobileNumber: `98765${String(slot).padStart(5, "0")}`, tripType: "local",
    fromDate: dayFromToday(slot * 2), toDate: dayFromToday(slot * 2 + 1), flexibleTime: true, pickupTime: "10:00 AM", dropTime: "10:00 AM",
    vehicleId, vehicleType: "car", ...extra,
  });
}

test("a Google Pay advance is stored as gpay on the booking and one payment record", async () => {
  const res = await book({ paymentMethod: "gpay", bookingAmount: 1500 });
  assert.equal(res.status, 201, res.json.message);
  const bookingId = res.json.booking._id;

  const booking = await Booking.findById(bookingId).lean();
  assert.equal(booking.payment.paymentMethod, "gpay");
  assert.deepEqual(booking.payment.paymentBreakdown, { cash: 0, phonePe: 0, gpay: 1500, razorpay: 0 });

  // Status still comes from amounts only: the same advance in cash gets the same status.
  const cash = await book({ paymentMethod: "cash", bookingAmount: 1500 });
  const cashBooking = await Booking.findById(cash.json.booking._id).lean();
  assert.equal(booking.payment.paymentStatus, cashBooking.payment.paymentStatus);
  const partial = await Booking.findById((await book({ paymentMethod: "gpay", bookingAmount: 400 })).json.booking._id).lean();
  assert.equal(partial.payment.paymentStatus, "partial", "a part advance is never marked paid");

  const payments = await PaymentHistory.find({ bookingId }).lean();
  assert.equal(payments.length, 1);
  const [payment] = payments;
  assert.equal(payment.paymentMethod, "gpay");
  assert.equal(payment.amount, 1500);
  assert.deepEqual(payment.paymentBreakdown, { cash: 0, phonePe: 0, gpay: 1500, razorpay: 0 });
  assert.equal(payment.isCollected, false);
  assert.equal(payment.collectedAmount, 0);
  assert.deepEqual(payment.upiLast4, []);

  // Payment reports read it as a valid Google Pay receipt, not as collected cash.
  const row = paymentReportRow(payment);
  assert.equal(row.method, "gpay");
  assert.equal(row.allocationValid, true);
  assert.equal(row.channels.gpay, 150000);
  assert.deepEqual(row.reviewReasons, []);
  assert.equal(row.collection, "unavailable");

  // Reopening the booking returns the saved method.
  const reopened = await api("GET", `/bookings/${bookingId}`);
  assert.equal(reopened.status, 200, reopened.json.message);
  assert.equal(reopened.json.booking.payment.paymentMethod, "gpay");
});

test("Google Pay without an advance saves the method but records no payment", async () => {
  const res = await book({ paymentMethod: "gpay" });
  assert.equal(res.status, 201, res.json.message);
  const booking = await Booking.findById(res.json.booking._id).lean();
  assert.equal(booking.payment.paymentMethod, "gpay");
  assert.equal(booking.payment.bookingAmountPaid, 0);
  assert.equal(await PaymentHistory.countDocuments({ bookingId: res.json.booking._id }), 0);
});

test("cash, PhonePe and Razorpay advances keep their existing channels and reopen with their method", async () => {
  const cases = [
    [{ paymentMethod: "cash" }, { cash: 700, phonePe: 0, gpay: 0, razorpay: 0 }],
    [{ paymentMethod: "phonepe", upiLast4: "1234" }, { cash: 0, phonePe: 700, gpay: 0, razorpay: 0 }],
    [{ paymentMethod: "razorpay" }, { cash: 0, phonePe: 0, gpay: 0, razorpay: 700 }],
  ];
  for (const [method, breakdown] of cases) {
    const res = await book({ ...method, bookingAmount: 700 });
    assert.equal(res.status, 201, res.json.message);
    const payments = await PaymentHistory.find({ bookingId: res.json.booking._id }).lean();
    assert.equal(payments.length, 1);
    assert.equal(payments[0].paymentMethod, method.paymentMethod);
    assert.deepEqual(payments[0].paymentBreakdown, breakdown);
    assert.equal(paymentReportRow(payments[0]).allocationValid, true);

    const reopened = await api("GET", `/bookings/${res.json.booking._id}`);
    assert.equal(reopened.status, 200, reopened.json.message);
    assert.equal(reopened.json.booking.payment.paymentMethod, method.paymentMethod);
  }
});

test("existing mixed records saved before Google Pay support stay readable and valid", async () => {
  const { default: mongoose } = await import("mongoose");
  const company = new mongoose.Types.ObjectId();
  // Raw inserts: exactly the shape older code wrote, with no gpay fields.
  const { insertedId: bookingId } = await Booking.collection.insertOne({
    company, createdBy: company, vehicleId: new mongoose.Types.ObjectId(), customerName: "Legacy", mobileNumber: "9876599999",
    fromDate: new Date("2026-01-10"), toDate: new Date("2026-01-12"), status: "completed", isDeleted: false,
    payment: { vehicleRent: 2000, totalAmount: 2000, bookingAmountPaid: 900, paymentMethod: "mixed", paymentBreakdown: { cash: 400, phonePe: 300, razorpay: 200 }, paymentStatus: "partial" },
  });
  const { insertedId: paymentId } = await PaymentHistory.collection.insertOne({
    company, bookingId, createdBy: company, type: "booking", amount: 900, paymentMethod: "mixed",
    paymentBreakdown: { cash: 400, phonePe: 300, razorpay: 200 }, createdAt: new Date("2026-01-09"),
  });

  const reopened = await api("GET", `/bookings/${bookingId}`);
  assert.equal(reopened.status, 200, reopened.json.message);
  assert.equal(reopened.json.booking.payment.paymentMethod, "mixed");
  assert.equal(reopened.json.booking.payment.paymentBreakdown.cash, 400);

  const row = paymentReportRow(await PaymentHistory.collection.findOne({ _id: paymentId }));
  assert.equal(row.method, "mixed");
  assert.equal(row.allocationValid, true);
  assert.deepEqual(row.channels, { cash: 40000, phonepe: 30000, gpay: 0, razorpay: 20000 });
});

test("mixed payments still split across cash, PhonePe and Razorpay and must add up", async () => {
  const res = await book({ paymentMethod: "mixed", bookingAmount: 900, paymentBreakdown: { cash: 400, phonePe: 300, razorpay: 200 } });
  assert.equal(res.status, 201, res.json.message);
  const [payment] = await PaymentHistory.find({ bookingId: res.json.booking._id }).lean();
  assert.equal(payment.paymentMethod, "mixed");
  assert.deepEqual(payment.paymentBreakdown, { cash: 400, phonePe: 300, gpay: 0, razorpay: 200 });
  assert.equal(paymentReportRow(payment).allocationValid, true);

  const mismatch = await book({ paymentMethod: "mixed", bookingAmount: 900, paymentBreakdown: { cash: 400 } });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.message, /does not match/);
});

test("unknown method values are still rejected", async () => {
  for (const paymentMethod of ["googlepay", "online", "GPAY", ""]) {
    const res = await book({ paymentMethod, bookingAmount: 100 });
    assert.equal(res.status, 400, paymentMethod);
    assert.equal(res.json.message, "Invalid payment method.");
  }
});
