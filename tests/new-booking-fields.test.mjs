import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";
import { bookingEditFormValues } from "../../my-sawari-Frontend/utils/bookingEditor.mjs";
import { paymentReportRow } from "../shared/paymentReporting.mjs";

// All writes use the harness's temporary replica set, never the configured DB.
let ctx, api, vehicleId, Booking, PaymentHistory, Lead;
let sequence = 0;
before(async () => {
  ctx = await startTestApp();
  api = client(ctx.base, (await createUserAndLogin(ctx.base)).token);
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
  ({ default: Lead } = await import("../src/models/lead.model.js"));
  const created = await api("POST", "/vehicles/create", {
    vehicleName: "Field coverage fixture", vehicleNumber: "KA01FC0001", manufacturer: "Test",
    fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5,
  });
  assert.equal(created.status, 201);
  vehicleId = created.json.data._id;
  assert.equal((await api("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);
});
after(async () => { await ctx?.stop(); });

function body(extra = {}) {
  sequence += 1;
  return {
    customerName: "  Field fixture  ", mobileNumber: `930000${String(sequence).padStart(4, "0")}`,
    alternateMobileNumber: " 9876500200 ", occupation: " Designer ",
    aadhaarNumber: " 123412341234 ", drivingLicenseNumber: " as01test001 ",
    destination: " Guwahati Airport ", tripType: "outstation", residents: 3,
    vehicleId, fromDate: dayFromToday(sequence * 4), toDate: dayFromToday(sequence * 4 + 2),
    flexibleTime: true, pickupTime: "09:15 AM", dropTime: "06:45 PM",
    pickupDropRequired: true, serviceType: "pickup_drop",
    pickup: { location: " Pickup fixture ", landmark: " Gate 2 ", mapLink: "https://maps.test/pickup", charge: 75 },
    drop: { location: " Drop fixture ", landmark: " Entrance ", mapLink: "https://maps.test/drop", charge: 125 },
    pickupDropNotes: " Call on arrival ", bookingAmount: 750, discountAmount: 125,
    securityDeposit: 1000, fastagBalance: 250, paymentMethod: "gpay", upiLast4: "4321",
    paymentDate: dayFromToday(-1), paymentTime: "19:34", ...extra,
  };
}

test("every applicable form value survives POST, raw MongoDB, GET and editor mapping", async () => {
  const input = body();
  const response = await api("POST", "/leads/create", input);
  assert.equal(response.status, 201, response.json.message);
  const booking = await Booking.collection.findOne({ _id: new ctx.mongoose.Types.ObjectId(response.json.booking._id) });
  const fields = {
    customerName: "Field fixture", mobileNumber: input.mobileNumber, alternateMobileNumber: "9876500200",
    occupation: "Designer", aadhaarNumber: "123412341234", drivingLicenseNumber: "AS01TEST001",
    destination: "Guwahati Airport", tripType: "outstation", residents: 3, flexibleTime: true,
    pickupTime: "09:15 AM", dropTime: "06:45 PM", pickupDropRequired: true,
    serviceType: "pickup_drop", pickupDropNotes: "Call on arrival", transactionId: "4321", paymentMethod: "gpay",
  };
  for (const [key, value] of Object.entries(fields)) assert.equal(booking[key], value, key);
  assert.equal(String(booking.vehicleId), vehicleId);
  assert.equal(booking.fromDate.toISOString().slice(0, 10), input.fromDate);
  assert.equal(booking.toDate.toISOString().slice(0, 10), input.toDate);
  assert.equal(booking.totalDays, 2);
  assert.deepEqual(booking.pickup, { location: "Pickup fixture", landmark: "Gate 2", mapLink: input.pickup.mapLink, charge: 75 });
  assert.deepEqual(booking.drop, { location: "Drop fixture", landmark: "Entrance", mapLink: input.drop.mapLink, charge: 125 });
  for (const [key, value] of Object.entries({ vehicleRent: 2000, pickupCharge: 75, dropCharge: 125,
    fastagAmount: 250, totalAmount: 2450, discountAmount: 125, manualDiscount: 125,
    membershipDiscount: 0, securityDeposit: 1000, bookingAmountPaid: 750,
    balanceAmount: 1575, totalCollected: 1750, transactionId: "4321", paymentMethod: "gpay" })) {
    assert.equal(booking.payment[key], value, `payment.${key}`);
  }
  for (const [key, value] of Object.entries({ quotationAmount: 2450, bookingAmount: 750,
    discountAmount: 125, securityDeposit: 1000, fastagBalance: 250 })) assert.equal(booking[key], value, key);
  const expectedDate = new Date(`${input.paymentDate}T19:34:00+05:30`);
  for (const snapshot of [booking, booking.payment]) {
    assert.ok(snapshot.paymentDate instanceof Date);
    assert.ok(snapshot.customPaymentDate instanceof Date);
    assert.equal(snapshot.paymentDate.toISOString(), expectedDate.toISOString());
    assert.equal(snapshot.customPaymentDate.toISOString(), expectedDate.toISOString());
    assert.equal(snapshot.paymentTime, "7:34 pm");
  }
  const payments = await PaymentHistory.find({ bookingId: booking._id }).lean();
  assert.equal(payments.length, 1);
  assert.equal(payments[0].transactionId, "4321");
  assert.deepEqual(payments[0].upiLast4, ["4321"]);
  assert.equal(payments[0].amount, 750);
  assert.deepEqual(payments[0].paymentBreakdown, { cash: 0, phonePe: 0, gpay: 750, razorpay: 0 });
  const reopened = await api("GET", `/bookings/${booking._id}`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.booking.transactionId, "4321");
  const form = bookingEditFormValues(reopened.json.booking);
  const expectedForm = { ...fields, residents: "3", vehicleId, fromDate: input.fromDate, toDate: input.toDate,
    pickupTime: "09:15", dropTime: "18:45", pickupLocation: "Pickup fixture", pickupLandmark: "Gate 2",
    pickupMapLink: input.pickup.mapLink, pickupCharge: "75", dropLocation: "Drop fixture", dropLandmark: "Entrance",
    dropMapLink: input.drop.mapLink, dropCharge: "125", bookingAmount: "750", discountAmount: "125",
    securityDeposit: "1000", fastagBalance: "250", upiLast4: "4321", paymentDate: input.paymentDate, paymentTime: "19:34" };
  delete expectedForm.transactionId; // The form's existing input is named upiLast4.
  for (const [key, value] of Object.entries(expectedForm)) assert.equal(form[key], value, key);
});

test("mixed Google Pay is preserved with every other split and reconciles to the advance", async () => {
  const split = { cash: 100, phonePe: 200, gpay: 300, razorpay: 400 };
  const response = await api("POST", "/leads/create", body({ paymentMethod: "mixed", bookingAmount: 1000, paymentBreakdown: split }));
  assert.equal(response.status, 201, response.json.message);
  const booking = await Booking.findById(response.json.booking._id).lean();
  assert.deepEqual(booking.payment.paymentBreakdown, split);
  const [payment] = await PaymentHistory.find({ bookingId: booking._id }).lean();
  assert.deepEqual(payment.paymentBreakdown, split);
  const report = paymentReportRow(payment);
  assert.equal(report.allocationValid, true);
  assert.equal(report.channels.gpay, 30000);
  const reopened = await api("GET", `/bookings/${booking._id}`);
  const form = bookingEditFormValues(reopened.json.booking);
  assert.deepEqual([form.mixedCash, form.mixedPhonePe, form.mixedgpay, form.mixedRazorpay], ["100", "200", "300", "400"]);
});

test("optional entered UPI timestamps persist without an advance or extra payment record", async () => {
  const input = body({ bookingAmount: 0, upiLast4: "", paymentTime: "00:30" });
  const created = await api("POST", "/leads/create", input);
  assert.equal(created.status, 201, created.json.message);
  const booking = await Booking.findById(created.json.booking._id).lean();
  assert.equal(await PaymentHistory.countDocuments({ bookingId: booking._id }), 0);
  assert.equal(booking.customPaymentDate.toISOString(), new Date(`${input.paymentDate}T00:30:00+05:30`).toISOString());
  const form = bookingEditFormValues(booking);
  assert.equal(form.paymentDate, input.paymentDate);
  assert.equal(form.paymentTime, "00:30");
});

test("pickup-only, drop-only and disabled services retain the applicable entered values", async () => {
  for (const serviceType of ["pickup", "drop", "pickup_drop"]) {
    const input = body({ serviceType, paymentMethod: "cash", pickup: serviceType === "drop" ? {} : bodyPickup(),
      drop: serviceType === "pickup" ? {} : { location: "Drop", charge: 25 } });
    const created = await api("POST", "/leads/create", input);
    assert.equal(created.status, 201, created.json.message);
    const booking = (await api("GET", `/bookings/${created.json.booking._id}`)).json.booking;
    assert.equal(booking.serviceType, serviceType);
    assert.equal(booking.pickup.charge, serviceType === "drop" ? 0 : 15);
    assert.equal(booking.drop.charge, serviceType === "pickup" ? 0 : 25);
  }
  const minimal = body({ pickupDropRequired: false, paymentMethod: "cash", pickup: {}, drop: {},
    residents: undefined, alternateMobileNumber: undefined, occupation: undefined, aadhaarNumber: undefined,
    drivingLicenseNumber: undefined, destination: undefined, discountAmount: undefined, securityDeposit: undefined });
  const created = await api("POST", "/leads/create", minimal);
  assert.equal(created.status, 201, created.json.message);
  const booking = await Booking.findById(created.json.booking._id).lean();
  assert.equal(booking.pickupDropRequired, false);
  assert.equal(booking.residents, 1);
  assert.equal(booking.destination, "");
});
const bodyPickup = () => ({ location: "Pickup", charge: 15 });

test("invalid form values return 400 before any booking, lead or advance is written", async () => {
  const beforeCounts = [await Booking.countDocuments(), await Lead.countDocuments(), await PaymentHistory.countDocuments()];
  const cases = [
    ...["customerName", "mobileNumber", "alternateMobileNumber", "occupation", "aadhaarNumber", "drivingLicenseNumber", "destination", "pickupDropNotes", "upiLast4"].map(key => ({ [key]: { invalid: true } })),
    ...["bookingAmount", "discountAmount", "securityDeposit", "fastagBalance"].flatMap(key => [-1, "NaN", true, []].map(value => ({ [key]: value }))),
    ...[0, -1, 1.5, "NaN", []].map(residents => ({ residents })),
    { tripType: "invalid" }, { pickupDropRequired: "false" }, { serviceType: "" }, { vehicleId: "bad-id" },
    { pickup: null }, { drop: [] }, { pickup: { location: 5 } }, { drop: { location: "Drop", charge: -1 } },
    { pickup: { location: "Pickup", mapLink: "not-a-url" } }, { drop: { location: "Drop", mapLink: "javascript:alert(1)" } },
    { paymentMethod: "mixed", paymentBreakdown: { cash: -50, gpay: 800 } },
    { paymentMethod: "mixed", paymentBreakdown: { cash: 750, gpay: "NaN" } },
    { paymentMethod: "mixed", paymentBreakdown: null }, { upiLast4: "123" },
    { bookingAmount: 0, paymentDate: "", paymentTime: "19:34" },
  ];
  for (const fields of cases) {
    const response = await api("POST", "/leads/create", body(fields));
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal(response.json.success, false);
  }
  assert.deepEqual([await Booking.countDocuments(), await Lead.countDocuments(), await PaymentHistory.countDocuments()], beforeCounts);
});
