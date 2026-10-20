// End-to-end: vehicle -> lead -> booking (both flows) -> handover -> cash/PhonePe
// collection -> vehicle return -> returns dashboard -> revenue by vehicle.
// Each step asserts the existing contract plus the regression it covers.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  client,
  createUserAndLogin,
  dayFromToday,
  jpegBlob,
} from "./helpers/harness.mjs";

let ctx;
let api;
let models;
const state = {};

before(async () => {
  ctx = await startTestApp();
  const { token } = await createUserAndLogin(ctx.base);
  api = client(ctx.base, token);
  models = {
    Vehicle: (await import("../src/models/vehicle.model.js")).default,
    PaymentHistory: (await import("../src/models/paymentHistory.model.js")).default,
    Booking: (await import("../src/models/booking.model.js")).default,
    Handover: (await import("../src/models/handover.model.js")).default,
  };
});

after(async () => {
  await ctx?.stop();
});

const createVehicle = async (vehicleNumber) => {
  const created = await api("POST", "/vehicles/create", {
    vehicleName: `Swift ${vehicleNumber}`,
    vehicleNumber,
    manufacturer: "Maruti",
    fuelType: "Petrol",
    transmission: "Manual",
    seatingCapacity: 5,
  });
  assert.equal(created.status, 201, created.json.message);

  const priced = await api("PUT", `/vehicles/update/${created.json.data._id}`, {
    pricePerDay: 1000,
  });
  assert.equal(priced.status, 200, priced.json.message);
  return created.json.data._id;
};

test("vehicles can be created and priced", async () => {
  state.vehicle1 = await createVehicle("KA01AB1001");
  state.vehicle2 = await createVehicle("KA01AB1002");
});

test("lead -> booking records the advance in PaymentHistory (selectedVehicle ReferenceError)", async () => {
  const lead = await api("POST", "/leads", {
    customerName: "Ravi Kumar",
    mobileNumber: "9876500001",
    vehicleType: "car",
  });
  assert.equal(lead.status, 201, lead.json.message);
  state.leadId = lead.json.data._id;

  // customerName / mobileNumber omitted: the booking falls back to the lead's.
  const booking = await api("PUT", `/leads/${state.leadId}/create-booking`, {
    vehicleId: state.vehicle1,
    bookingAmount: 500,
    paymentMethod: "cash",
    fromDate: dayFromToday(1),
    toDate: dayFromToday(3),
    totalDays: 2,
  });
  assert.equal(booking.status, 201, booking.json.message);
  assert.equal(booking.json.success, true);
  assert.equal(booking.json.data.customerName, "Ravi Kumar");
  state.leadBookingId = booking.json.data._id;

  const advance = await models.PaymentHistory.findOne({
    bookingId: state.leadBookingId,
    type: "booking",
  }).lean();
  assert.ok(advance, "advance payment must be recorded");
  assert.equal(advance.amount, 500);
  assert.equal(advance.paymentMethod, "cash");
  assert.equal(String(advance.vehicle.vehicleId), state.vehicle1);
  assert.equal(advance.vehicle.vehicleNumber, "KA01AB1001");
  assert.equal(advance.customer.fullName, "Ravi Kumar");
  assert.equal(advance.customer.mobileNumber, "9876500001");
  state.leadAdvanceId = String(advance._id);
});

test("fresh booking (transaction) records a PhonePe advance and links it to the vehicle", async () => {
  const res = await api("POST", "/leads/create", {
    customerName: "Anita Sharma",
    mobileNumber: "9876500002",
    vehicleId: state.vehicle2,
    vehicleType: "car",
    fromDate: dayFromToday(0),
    toDate: dayFromToday(2),
    pickupTime: "10:00 AM",
    dropTime: "10:00 AM",
    bookingAmount: 500,
    paymentMethod: "phonepe",
    upiLast4: "1234",
  });
  assert.equal(res.status, 201, res.json.message);
  state.bookingId = res.json.booking._id;
  assert.equal(res.json.booking.totalDays, 2);
  assert.equal(res.json.booking.payment.totalAmount, 2000);
  assert.equal(res.json.booking.payment.balanceAmount, 1500);

  const advance = await models.PaymentHistory.findOne({ bookingId: state.bookingId }).lean();
  assert.equal(advance.amount, 500);
  assert.deepEqual(advance.upiLast4, ["1234"]);
  assert.equal(advance.bookingMonth, dayFromToday(0).slice(0, 7));
  state.phonePeAdvanceId = String(advance._id);

  const vehicle = await models.Vehicle.findById(state.vehicle2).lean();
  assert.ok(vehicle.payments.map(String).includes(state.phonePeAdvanceId));
});

test("an overlapping booking for the same vehicle is rejected with 409", async () => {
  const res = await api("POST", "/leads/create", {
    customerName: "Someone Else",
    mobileNumber: "9876500009",
    vehicleId: state.vehicle2,
    fromDate: dayFromToday(1),
    toDate: dayFromToday(1),
    bookingAmount: 0,
    paymentMethod: "cash",
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.success, false);
});

test("GET /leads/booking now requires a token and still returns bookings with one", async () => {
  const anonymous = await client(ctx.base)("GET", "/leads/booking");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.success, false);

  const authed = await api("GET", "/leads/booking?tab=All");
  assert.equal(authed.status, 200);
  assert.equal(authed.json.bookings.length, 2);
  assert.ok(authed.json.stats);
  assert.ok(authed.json.pagination);
});

test("handover records the payment received now and links it to the vehicle (paymentHistory ReferenceError)", async () => {
  const pickup = new Date();
  const drop = new Date(pickup.getTime() + 2 * 24 * 60 * 60 * 1000);

  const res = await api("POST", "/handover/create", {
    bookingId: state.bookingId,
    customer: { fullName: "Anita Sharma", mobileNumber: "9876500002", destination: "Coorg" },
    identity: { aadhaarNumber: "123412341234", drivingLicenseNumber: "KA0120240001" },
    vehicle: { vehicleId: state.vehicle2, handoverKm: 1200 },
    trip: { pickupDateTime: pickup, dropDateTime: drop, numberOfDays: 2 },
    payment: {
      fuelLevel: 7,
      totalFare: 2000,
      totalAmount: 2000,
      bookingAmountPaid: 500,
      amountReceivedNow: 1000,
      balanceAmount: 500,
      paymentMethod: "cash",
      paymentBreakdown: { cash: 1000 },
    },
  });
  assert.equal(res.status, 201, res.json.message);
  state.handoverId = res.json.data._id;

  const payment = await models.PaymentHistory.findOne({
    handoverId: state.handoverId,
    type: "handover",
  }).lean();
  assert.equal(payment.amount, 1000);
  state.handoverPaymentId = String(payment._id);

  const vehicle = await models.Vehicle.findById(state.vehicle2).lean();
  assert.equal(vehicle.status, "rent");
  assert.ok(
    vehicle.payments.map(String).includes(state.handoverPaymentId),
    "handover payment id must be pushed to vehicle.payments",
  );

  const booking = await models.Booking.findById(state.bookingId).lean();
  assert.equal(booking.status, "vehicle_handover");
  assert.equal(String(booking.handover), state.handoverId);
});

test("double-tapping cash collection records the money once (409 for the loser)", async () => {
  const [a, b] = await Promise.all([
    api("POST", `/payments/${state.handoverPaymentId}/collect-cash`, {}),
    api("POST", `/payments/${state.handoverPaymentId}/collect-cash`, {}),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([a.json, b.json]));

  const winner = a.status === 200 ? a : b;
  assert.equal(winner.json.data.transactionAmount, 1000);
  assert.equal(winner.json.data.isCollected, true);

  const payment = await models.PaymentHistory.findById(state.handoverPaymentId).lean();
  assert.equal(payment.collectionHistory.length, 1);
  assert.equal(payment.collectedAmount, 1000);
  assert.equal(payment.isCollected, true);

  const again = await api("POST", `/payments/${state.handoverPaymentId}/collect-cash`, {});
  assert.equal(again.status, 409);
});

test("partial cash collection still works and keeps the remaining balance", async () => {
  const first = await api("POST", `/payments/${state.leadAdvanceId}/collect-cash`, { amount: 200 });
  assert.equal(first.status, 200, first.json.message);
  assert.equal(first.json.data.remainingAmount, 300);

  const tooMuch = await api("POST", `/payments/${state.leadAdvanceId}/collect-cash`, { amount: 301 });
  assert.equal(tooMuch.status, 400);

  const pending = await api("GET", "/payments/pending?status=pending");
  assert.equal(pending.status, 200);
  const row = pending.json.data.find((p) => p._id === state.leadAdvanceId);
  assert.equal(row.remainingAmount, 300);
});

test("PhonePe verification: invalid id is a 400, double-tap records once", async () => {
  const bad = await api("POST", "/payments/not-an-id/collect-phonepe", { amount: 1 });
  assert.equal(bad.status, 400);

  const [a, b] = await Promise.all([
    api("POST", `/payments/${state.phonePeAdvanceId}/collect-phonepe`, { amount: 500 }),
    api("POST", `/payments/${state.phonePeAdvanceId}/collect-phonepe`, { amount: 500 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.json, b.json]));

  const payment = await models.PaymentHistory.findById(state.phonePeAdvanceId).lean();
  assert.equal(payment.collectionHistory.length, 1);
  assert.equal(payment.collectedPhonePe, 500);
});

test("vehicle return settles the bill, frees the vehicle and completes the booking", async () => {
  const form = new FormData();
  form.append("fuelLevel", "6");
  form.append("kilometersAtReturn", "1450");
  form.append("amountCollected", "300");
  form.append("paymentMode", "Cash");
  form.append("balanceReason", "Customer pays the rest tomorrow");
  for (const side of ["vehicleFront", "vehicleRear", "vehicleLeft", "vehicleRight"]) {
    form.append(side, jpegBlob(), `${side}.jpg`);
  }

  const res = await api("POST", `/vehicle-return/receive/${state.handoverId}`, form);
  assert.equal(res.status, 201, res.json.message);
  assert.equal(res.json.data.settlementDetails.totalBalanceAmount, 500);
  assert.equal(res.json.data.settlementDetails.finalBalance, 200);
  assert.equal(res.json.data.settlementDetails.status, "Partially Collected");
  assert.match(res.json.data.images.vehicleFront, /^https:\/\/res\.cloudinary\.com\//);

  const vehicle = await models.Vehicle.findById(state.vehicle2).lean();
  assert.equal(vehicle.status, "available");

  const handover = await models.Handover.findById(state.handoverId).lean();
  assert.equal(handover.handoverStatus, "returned");
  assert.equal(handover.payment.billSummary.balanceAmount, 200);

  const booking = await models.Booking.findById(state.bookingId).lean();
  assert.equal(booking.status, "completed");

  const receive = await models.PaymentHistory.findOne({ handoverId: state.handoverId, type: "receive" }).lean();
  assert.equal(receive.amount, 300);

  const again = await api("POST", `/vehicle-return/receive/${state.handoverId}`, form);
  assert.equal(again.status, 400);
});

test("returns dashboard reports the outstanding balance and the Due tab (isDue/balanceAmount bug)", async () => {
  const due = await api("GET", "/vehicle-return/dashboard?tab=Due");
  assert.equal(due.status, 200, due.json.message);
  assert.equal(due.json.stats.due, 1);
  assert.equal(due.json.returns.length, 1);

  const row = due.json.returns[0];
  assert.equal(row.isDue, true);
  assert.equal(row.pendingAmount, 200);
  assert.equal(row.finalBalance, 200);
  assert.equal(row.settlementStatus, "pending");
  assert.equal(row.mobileNumber, "9876500002");
  assert.equal(row.customerName, "Anita Sharma");

  const all = await api("GET", "/vehicle-return/dashboard?tab=All");
  assert.equal(all.json.stats.total, 1);
});

test("revenue by vehicle includes the lead-booking advance", async () => {
  const { toDayKey } = await import("../src/utils/revenue.utils.js");
  const today = toDayKey(new Date());

  // Still public, as the web revenue page calls it without a token.
  const res = await client(ctx.base)("GET", `/dashboard/revenue/vehicles?from=${today}&to=${today}`);
  assert.equal(res.status, 200, res.json.message);

  const byId = Object.fromEntries(res.json.vehicles.map((v) => [v.id, v]));
  assert.equal(byId[state.vehicle1].gross, 500); // lead advance (was missing)
  assert.equal(byId[state.vehicle2].gross, 1800); // 500 advance + 1000 handover + 300 return
  assert.equal(res.json.totals.gross, 2300);
});

test("cancelling: confirmed booking can be cancelled once, completed cannot", async () => {
  const cancel = await api("PUT", `/leads/${state.leadBookingId}/cancel`, {});
  assert.equal(cancel.status, 200, cancel.json.message);
  assert.equal(cancel.json.booking.status, "cancelled");

  const twice = await api("PUT", `/leads/${state.leadBookingId}/cancel`, {});
  assert.equal(twice.status, 400);

  const completed = await api("PUT", `/leads/${state.bookingId}/cancel`, {});
  assert.equal(completed.status, 400);
});

test("WhatsApp messages went out with a timeout and never blocked the flow", () => {
  assert.ok(ctx.watiCalls.length >= 3);
  for (const call of ctx.watiCalls) assert.equal(call.config.timeout, 15000);
});
