// New Booking pricing is always recalculated on the server from the stored
// vehicle rate, validated dates and FASTag, matching the modal's live preview.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";

let ctx;
let api;
let vehicleId;
let Booking;

before(async () => {
  ctx = await startTestApp();
  api = client(ctx.base, (await createUserAndLogin(ctx.base)).token);
  const created = await api("POST", "/vehicles/create", { vehicleName: "Swift Bill", vehicleNumber: "KA01BL0001", manufacturer: "Maruti", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
  assert.equal(created.status, 201, created.json.message);
  vehicleId = created.json.data._id;
  assert.equal((await api("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);
  ({ default: Booking } = await import("../src/models/booking.model.js"));
});

after(async () => {
  await ctx?.stop();
});

const book = (fromOffset, toOffset, extra = {}) =>
  api("POST", "/leads/create", {
    customerName: "Asha", mobileNumber: `98765${String(fromOffset).padStart(5, "0")}`, tripType: "local",
    fromDate: dayFromToday(fromOffset), toDate: dayFromToday(toOffset), flexibleTime: true, pickupTime: "10:00 AM", dropTime: "10:00 AM",
    vehicleId, vehicleType: "car", paymentMethod: "cash", ...extra,
  });

test("₹1,000/day for 2 days with ₹250 FASTag is saved as ₹2,000 rent + ₹250 = ₹2,250", async () => {
  const res = await book(2, 4, { fastagBalance: 250 });
  assert.equal(res.status, 201, res.json.message);
  const booking = await Booking.findById(res.json.booking._id).lean();
  assert.equal(booking.totalDays, 2);
  assert.equal(booking.payment.vehicleRent, 2000);
  assert.equal(booking.payment.fastagAmount, 250);
  assert.equal(booking.payment.totalAmount, 2250);
  assert.equal(booking.payment.discountAmount, 0);
  assert.equal(booking.payment.balanceAmount, 2250);
});

test("a same-day booking counts as one rental day and FASTag defaults to zero", async () => {
  const res = await book(10, 10);
  assert.equal(res.status, 201, res.json.message);
  const booking = await Booking.findById(res.json.booking._id).lean();
  assert.equal(booking.totalDays, 1);
  assert.equal(booking.payment.vehicleRent, 1000);
  assert.equal(booking.payment.fastagAmount, 0);
  assert.equal(booking.payment.totalAmount, 1000);

  const blank = await book(12, 12, { fastagBalance: "" });
  assert.equal(blank.status, 201, blank.json.message);
  assert.equal((await Booking.findById(blank.json.booking._id).lean()).payment.fastagAmount, 0);
});

test("negative or non-numeric FASTag is rejected before anything is saved", async () => {
  const { default: PaymentHistory } = await import("../src/models/paymentHistory.model.js");
  const bookingsBefore = await Booking.countDocuments();
  const paymentsBefore = await PaymentHistory.countDocuments();
  for (const fastagBalance of [-250, "-0.01", "abc", { $gt: 0 }]) {
    const res = await book(30, 31, { fastagBalance, bookingAmount: 500 });
    assert.equal(res.status, 400, JSON.stringify(fastagBalance));
    assert.equal(res.json.message, "FASTag amount cannot be negative.");
  }
  assert.equal(await Booking.countDocuments(), bookingsBefore);
  assert.equal(await PaymentHistory.countDocuments(), paymentsBefore);
});

test("client-sent totals, days, rent and membership discounts are ignored", async () => {
  const res = await book(20, 23, {
    fastagBalance: 100,
    totalDays: 30, totalAmount: 1, finalTotal: 1, quotationAmount: 1, vehicleRent: 1,
    pricePerDay: 1, membershipDiscount: 5000, membership: { plan: "pro", discount: 5000 },
    payment: { totalAmount: 1, vehicleRent: 1, discountAmount: 5000 },
  });
  assert.equal(res.status, 201, res.json.message);
  const booking = await Booking.findById(res.json.booking._id).lean();
  assert.equal(booking.totalDays, 3);
  assert.equal(booking.payment.vehicleRent, 3000);
  assert.equal(booking.payment.totalAmount, 3100);
  assert.equal(booking.payment.discountAmount, 0);
  assert.equal(booking.payment.balanceAmount, 3100);
});

test("editing a booking keeps its FASTag, pricing and single payment record", async () => {
  const { default: PaymentHistory } = await import("../src/models/paymentHistory.model.js");
  const res = await book(40, 42, { fastagBalance: 250, bookingAmount: 500 });
  assert.equal(res.status, 201, res.json.message);
  const bookingId = res.json.booking._id;
  const before = await Booking.findById(bookingId).lean();
  assert.equal(await PaymentHistory.countDocuments({ bookingId }), 1);

  const edited = await api("PUT", `/leads/booking-update/${bookingId}`, {
    customerName: "Asha Rao", destination: "Coorg", fromDate: dayFromToday(44), toDate: dayFromToday(46),
  });
  assert.equal(edited.status, 200, edited.json.message);

  const after = await Booking.findById(bookingId).lean();
  assert.equal(after.customerName, "Asha Rao");
  assert.equal(after.payment.fastagAmount, 250);
  assert.deepEqual(after.payment, before.payment, "recorded fare, FASTag and payments are not changed by edits");
  assert.equal(await PaymentHistory.countDocuments({ bookingId }), 1, "no duplicate payment");
});

test("existing bookings saved without any FASTag fields still open and edit", async () => {
  const { default: mongoose } = await import("mongoose");
  const company = new mongoose.Types.ObjectId();
  // Raw insert: an older booking with no fastagAmount / fastagBalance at all.
  const { insertedId } = await Booking.collection.insertOne({
    company, createdBy: company, vehicleId: new mongoose.Types.ObjectId(vehicleId), customerName: "Legacy", mobileNumber: "9876588888",
    fromDate: new Date(`${dayFromToday(60)}T00:00:00.000Z`), toDate: new Date(`${dayFromToday(61)}T00:00:00.000Z`),
    pickupTime: "10:00 AM", dropTime: "10:00 AM", status: "confirmed", isDeleted: false,
    payment: { vehicleRent: 1000, totalAmount: 1000, bookingAmountPaid: 0, paymentMethod: "cash", paymentStatus: "pending", balanceAmount: 1000 },
  });

  const opened = await api("GET", `/bookings/${insertedId}`);
  assert.equal(opened.status, 200, opened.json.message);
  assert.equal(opened.json.booking.payment.totalAmount, 1000);

  const edited = await api("PUT", `/leads/booking-update/${insertedId}`, { customerName: "Legacy Updated" });
  assert.equal(edited.status, 200, edited.json.message);
  const raw = await Booking.collection.findOne({ _id: insertedId });
  assert.equal(raw.customerName, "Legacy Updated");
  assert.equal(raw.payment.totalAmount, 1000);
  assert.equal(raw.payment.fastagAmount, undefined, "no FASTag value is invented for old bookings");
});

// The New Booking modal's preview (my-sawari-Frontend/utils/bookingBilling.mjs)
// must show what the server saves. Skipped only if the frontend is not checked
// out next to the backend.
const previewUrl = new URL("../../my-sawari-Frontend/utils/bookingBilling.mjs", import.meta.url);
const { existsSync } = await import("node:fs");
const previewAvailable = existsSync(previewUrl);

test("server totals match the frontend billing preview", { skip: !previewAvailable && "frontend checkout not found" }, async () => {
  const { bookingBill } = await import(previewUrl);
  const cases = [
    { from: 70, to: 72, body: { fastagBalance: 250 } },
    { from: 75, to: 75, body: {} },
    { from: 78, to: 81, body: { fastagBalance: "99.5", discountAmount: 300, bookingAmount: 1000, pickupDropRequired: true, serviceType: "pickup_drop", pickup: { location: "Airport", charge: 150 }, drop: { location: "Station", charge: 100 } } },
    { from: 85, to: 86, body: { fastagBalance: 0, discountAmount: 5000, bookingAmount: 200 } },
  ];
  for (const { from, to, body } of cases) {
    const res = await book(from, to, body);
    assert.equal(res.status, 201, res.json.message);
    const saved = (await Booking.findById(res.json.booking._id).lean()).payment;
    const preview = bookingBill({
      pricePerDay: 1000, fromDate: dayFromToday(from), toDate: dayFromToday(to),
      fastagAmount: body.fastagBalance, pickupCharge: body.pickup?.charge, dropCharge: body.drop?.charge,
      discountAmount: body.discountAmount, bookingAmount: body.bookingAmount,
    });
    const label = `${dayFromToday(from)} → ${dayFromToday(to)}`;
    assert.equal(saved.vehicleRent, preview.baseRent, label);
    assert.equal(saved.fastagAmount, preview.fastag, label);
    assert.equal(saved.pickupCharge + saved.dropCharge, preview.pickupDrop, label);
    assert.equal(saved.totalAmount, preview.subtotal, label);
    assert.equal(saved.discountAmount, preview.discount, label);
    assert.equal(saved.balanceAmount, preview.balance, label);
  }
});
