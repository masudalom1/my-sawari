import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

test("booking edits preserve every payment variant and existing transaction references", async t => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const { default: Booking } = await import("../src/models/booking.model.js");
  const { default: Vehicle } = await import("../src/models/vehicle.model.js");
  const { default: PaymentHistory } = await import("../src/models/paymentHistory.model.js");
  const owner = await createUserAndLogin(ctx.base);
  const api = client(ctx.base, owner.token);
  const company = new mongoose.Types.ObjectId(owner.user.id);
  const methods = ["cash", "phonepe", "razorpay", "mixed", "mixed without split"];
  for (const variant of methods) await t.test(variant, async () => {
    const method = variant.startsWith("mixed") ? "mixed" : variant;
    const vehicle = new mongoose.Types.ObjectId();
    await Vehicle.collection.insertOne({ _id: vehicle, company, isDeleted: false, payments: [] });
    const booking = await Booking.create({ company, createdBy: company, vehicleId: vehicle, customerName: "Payment preservation", mobileNumber: "9876500001", fromDate: "2026-11-01", toDate: "2026-11-02", payment: { totalAmount: 6000, bookingAmountPaid: 300, securityDeposit: 500, paymentMethod: method, paymentBreakdown: method === "mixed" && variant !== "mixed without split" ? { cash: 100, phonePe: 150, razorpay: 50 } : {} } });
    // Historical totals can include collections not represented by the
    // original advance. Metadata edits must not normalize them away.
    await Booking.collection.updateOne({ _id: booking._id }, { $set: { "payment.totalCollected": 1200, "payment.balanceAmount": 4800, "payment.paymentStatus": "partial", quotationAmount: 6000, bookingAmount: 300 } });
    if (variant === "mixed without split") await Booking.collection.updateOne({ _id: booking._id }, { $unset: { "payment.paymentBreakdown": "" } });
    const transaction = await PaymentHistory.create({ company, bookingId: booking._id, createdBy: company, type: "booking", amount: 300, paymentMethod: method, vehicle: { vehicleId: vehicle }, isCollected: true, collectedAmount: 100, collectionHistory: [{ channel: "cash", amount: 100, collectedBy: company }] });
    await Vehicle.collection.updateOne({ _id: vehicle }, { $push: { payments: transaction._id } });
    const transactionBefore = await PaymentHistory.findById(transaction._id).lean();
    const vehicleBefore = await Vehicle.collection.findOne({ _id: vehicle });
    const transactionCount = await PaymentHistory.countDocuments();
    const rawBefore = await Booking.collection.findOne({ _id: booking._id });
    const path = `/leads/booking-update/${booking._id}`;
    async function edit(payload) {
      const response = await api("PUT", path, payload);
      assert.equal(response.status, 200, response.json.message);
      const reloaded = await api("GET", `/bookings/${booking._id}`);
      assert.equal(reloaded.status, 200);
      return reloaded.json.booking.payment;
    }
    await edit({ customerName: "Updated customer" });
    const afterDetails = await Booking.collection.findOne({ _id: booking._id });
    assert.deepEqual(afterDetails.payment, rawBefore.payment);
    assert.equal(afterDetails.quotationAmount, rawBefore.quotationAmount);
    assert.equal(afterDetails.bookingAmount, rawBefore.bookingAmount);
    await edit({ payment: {} });
    assert.deepEqual((await Booking.collection.findOne({ _id: booking._id })).payment, rawBefore.payment);
    const changedMethod = method === "cash" ? "razorpay" : "cash";
    let payment = await edit({ paymentMethod: changedMethod });
    assert.equal(payment.totalAmount, 6000);
    assert.equal(payment.totalCollected, 1200);
    assert.equal(payment.balanceAmount, 4800);
    assert.equal(payment.paymentStatus, "partial");
    payment = await edit({ payment: { paymentMethod: method } });
    assert.equal(payment.totalCollected, 1200);
    assert.equal(payment.paymentStatus, "partial");
    if (variant === "mixed without split") {
      for (const split of [{}, null]) {
        payment = await edit({ payment: { paymentMethod: "mixed", paymentBreakdown: split } });
        assert.equal(payment.totalAmount, 6000);
        assert.equal(payment.totalCollected, 1200);
        assert.equal(payment.paymentStatus, "partial");
      }
    }
    if (variant === "mixed") {
      payment = await edit({ paymentBreakdown: { cash: 120 } });
      assert.equal(payment.paymentBreakdown.cash, 120);
      assert.equal(payment.paymentBreakdown.phonePe, 150);
      assert.equal(payment.paymentBreakdown.razorpay, 50);
      assert.equal(payment.totalCollected, 1200);
      assert.equal(payment.balanceAmount, 4800);
      assert.equal(payment.paymentStatus, "partial");
    }
    payment = await edit({ discountAmount: 100 });
    assert.equal(payment.totalAmount, 6000);
    assert.equal(payment.totalCollected, 1200);
    assert.equal(payment.balanceAmount, 5600);
    payment = await edit({ payment: { securityDeposit: 600 } });
    assert.equal(payment.totalAmount, 6000);
    assert.equal(payment.totalCollected, 1300);
    payment = await edit({ bookingAmount: 400 });
    assert.equal(payment.totalAmount, 6000);
    assert.equal(payment.totalCollected, 1400);
    assert.equal(payment.balanceAmount, 5500);
    // Explicit fare edits adjust the stored total without erasing its
    // unitemized component. Both supported request representations work.
    payment = await edit({ fastagBalance: 50 });
    assert.equal(payment.totalAmount, 6050);
    payment = await edit({ payment: { fastagAmount: 70 } });
    assert.equal(payment.totalAmount, 6070);
    assert.equal(payment.totalCollected, 1400);
    // Repeated PUTs must not duplicate transactions or apply the delta twice.
    payment = await edit({ payment: { fastagAmount: 70 } });
    assert.equal(payment.totalAmount, 6070);
    assert.equal(await PaymentHistory.countDocuments(), transactionCount);
    assert.deepEqual(await PaymentHistory.findById(transaction._id).lean(), transactionBefore);
    assert.deepEqual(await Vehicle.collection.findOne({ _id: vehicle }), vehicleBefore);
    assert.equal(await Booking.countDocuments({ _id: booking._id }), 1);
  });
  await t.test("settled payment status survives method-only edits", async () => {
    const vehicle = new mongoose.Types.ObjectId();
    await Vehicle.collection.insertOne({ _id: vehicle, company, isDeleted: false });
    const booking = await Booking.create({ company, createdBy: company, vehicleId: vehicle, customerName: "Settled customer", mobileNumber: "9876500002", fromDate: "2026-11-01", toDate: "2026-11-02", payment: { totalAmount: 6000, bookingAmountPaid: 300, paymentMethod: "cash" } });
    await Booking.collection.updateOne({ _id: booking._id }, { $set: { "payment.totalCollected": 6000, "payment.balanceAmount": 0, "payment.paymentStatus": "paid" } });
    const response = await api("PUT", `/leads/booking-update/${booking._id}`, { payment: { paymentMethod: "phonepe" } });
    assert.equal(response.status, 200);
    const saved = await Booking.findById(booking._id).lean();
    assert.equal(saved.payment.paymentStatus, "paid");
    assert.equal(saved.payment.balanceAmount, 0);
    assert.equal(saved.payment.totalCollected, 6000);
  });
});
