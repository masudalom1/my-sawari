import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";
import { validateBookingPaymentTime } from "../shared/bookingPaymentTime.mjs";

let ctx, api, token, vehicleId, Booking, PaymentHistory, Vehicle;
let sequence = 0;
before(async () => {
  ctx = await startTestApp();
  ({ token } = await createUserAndLogin(ctx.base));
  api = client(ctx.base, token);
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
  ({ default: Vehicle } = await import("../src/models/vehicle.model.js"));
  const created = await api("POST", "/vehicles/create", { vehicleName: "Payment time fixture", vehicleNumber: "KA01PT0001", manufacturer: "Test", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
  assert.equal(created.status, 201);
  vehicleId = created.json.data._id;
  assert.equal((await api("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);
});
after(async () => { await ctx?.stop(); });

function body(extra = {}) {
  sequence += 1;
  return {
    customerName: `Timestamp fixture ${sequence}`, mobileNumber: `940000${String(sequence).padStart(4, "0")}`,
    vehicleId, fromDate: dayFromToday(sequence * 3), toDate: dayFromToday(sequence * 3 + 1),
    flexibleTime: true, pickupTime: "08:00 AM", dropTime: "08:00 AM",
    paymentMethod: "phonepe", bookingAmount: 500, upiLast4: "1234",
    paymentDate: dayFromToday(-1), paymentTime: "14:35", ...extra,
  };
}

test("both UPI advances store the exact IST payment timestamp once, separate from createdAt and staff collection", async () => {
  for (const [paymentMethod, paymentTime, storedTime] of [
    ["phonepe", "00:30", "12:30 am"],
    ["gpay", "19:34", "7:34 pm"],
  ]) {
    const input = body({ paymentMethod, paymentTime, fastagBalance: 250, discountAmount: 100 });
    const response = await api("POST", "/leads/create", input);
    assert.equal(response.status, 201, response.json.message);
    const bookingId = response.json.booking._id;
    const records = await PaymentHistory.find({ bookingId }).lean();
    assert.equal(records.length, 1);
    const payment = records[0];
    const expected = new Date(`${input.paymentDate}T${paymentTime}:00+05:30`);
    assert.ok(payment.customPaymentDate instanceof Date, "manual timestamp is stored as a BSON Date");
    assert.equal(payment.paymentDate.toISOString(), expected.toISOString());
    assert.equal(payment.customPaymentDate.toISOString(), expected.toISOString());
    assert.equal(payment.paymentTime, storedTime);
    assert.equal(payment.amount, 500);
    assert.equal(payment.paymentMethod, paymentMethod);
    assert.equal(payment.createdAt.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    assert.notEqual(payment.createdAt.toISOString(), expected.toISOString());
    assert.equal(payment.isCollected, false);
    assert.equal(payment.collectedAmount, 0);
    assert.equal(payment.lastCollectedAt, null);
    assert.deepEqual(payment.collectionHistory, []);
    const booking = await Booking.findById(bookingId).lean();
    assert.equal(booking.totalDays, 1);
    assert.equal(booking.payment.vehicleRent, 1000);
    assert.equal(booking.payment.totalAmount, 1250);
    assert.equal(booking.payment.balanceAmount, 650);
    assert.equal(booking.toDate.toISOString().slice(0, 10), input.toDate);
    assert.notEqual(booking.createdAt.toISOString(), expected.toISOString());
    const rawBooking = await Booking.collection.findOne({ _id: booking._id });
    for (const snapshot of [rawBooking, rawBooking.payment]) {
      assert.ok(snapshot.paymentDate instanceof Date, "recorded date is a BSON Date");
      assert.ok(snapshot.customPaymentDate instanceof Date, "manual date is a BSON Date");
      assert.equal(snapshot.paymentDate.toISOString(), expected.toISOString());
      assert.equal(snapshot.customPaymentDate.toISOString(), expected.toISOString());
      assert.equal(snapshot.paymentTime, storedTime);
    }
    const reopened = await api("GET", `/bookings/${bookingId}`);
    assert.equal(reopened.status, 200);
    for (const snapshot of [response.json.booking, response.json.booking.payment, reopened.json.booking, reopened.json.booking.payment]) {
      assert.equal(snapshot.paymentDate, expected.toISOString());
      assert.equal(snapshot.customPaymentDate, expected.toISOString());
      assert.equal(snapshot.paymentTime, storedTime);
    }
    const history = await api("GET", `/dashboard/payments-history?search=${encodeURIComponent(input.customerName)}`);
    assert.equal(history.status, 200);
    assert.equal(history.json.data.length, 1);
    assert.equal(history.json.data[0].paymentDate, expected.toISOString());
    assert.equal(history.json.data[0].paymentTime, payment.paymentTime);
    assert.equal(history.json.stats.received, 500);
    assert.equal(history.json.stats.pending, 500, "staff collection accounting is unchanged");
  }
});

test("invalid or missing UPI collection timestamps are rejected before any booking or payment write", async () => {
  const before = { bookings: await Booking.countDocuments(), payments: await PaymentHistory.countDocuments() };
  for (const paymentMethod of ["phonepe", "gpay"]) {
    for (const [fields, message] of [
      [{ paymentDate: "" }, /Payment Date is required/],
      [{ paymentDate: undefined }, /Payment Date is required/],
      [{ paymentTime: "" }, /Payment Time is required/],
      [{ paymentTime: undefined }, /Payment Time is required/],
      [{ paymentDate: "2026-02-30" }, /valid Payment Date/],
      [{ paymentDate: "2026-13-01" }, /valid Payment Date/],
      [{ paymentDate: { $gt: "" } }, /valid Payment Date/],
      [{ paymentTime: "24:00" }, /valid Payment Time/],
      [{ paymentTime: "08:60" }, /valid Payment Time/],
      [{ paymentTime: "09:00 AM" }, /valid Payment Time/],
      [{ paymentTime: [] }, /valid Payment Time/],
      [{ paymentDate: dayFromToday(2) }, /future/],
    ]) {
      const response = await api("POST", "/leads/create", body({ paymentMethod, ...fields }));
      assert.equal(response.status, 400, `${paymentMethod}: ${JSON.stringify(fields)}`);
      assert.match(response.json.message, message);
    }
  }
  assert.equal(await Booking.countDocuments(), before.bookings);
  assert.equal(await PaymentHistory.countDocuments(), before.payments);
});

test("Cash, Razorpay and Mixed ignore timestamp fields and retain existing amounts and allocations", async () => {
  for (const paymentMethod of ["cash", "razorpay", "mixed"]) {
    const input = body({ paymentMethod, paymentDate: "invalid", paymentTime: "invalid",
      ...(paymentMethod === "mixed" ? { paymentBreakdown: { cash: 200, phonePe: 200, razorpay: 100 } } : {}),
    });
    const created = await api("POST", "/leads/create", input);
    assert.equal(created.status, 201, created.json.message);
    const [payment] = await PaymentHistory.find({ bookingId: created.json.booking._id }).lean();
    assert.equal(payment.paymentDate, null);
    assert.equal(payment.paymentTime, "");
    assert.equal(payment.amount, 500);
    assert.equal(payment.paymentMethod, paymentMethod);
    assert.equal(payment.paymentBreakdown.cash + payment.paymentBreakdown.phonePe + payment.paymentBreakdown.gpay + payment.paymentBreakdown.razorpay, 500);
    const booking = await Booking.findById(created.json.booking._id).lean();
    for (const snapshot of [booking, booking.payment]) {
      for (const field of ["paymentDate", "paymentTime", "customPaymentDate"]) assert.equal(Object.hasOwn(snapshot, field), false);
    }
  }
});

test("zero UPI advances require no timestamp and create no payment record", async () => {
  for (const paymentMethod of ["phonepe", "gpay"]) {
    const input = body({ paymentMethod, bookingAmount: 0, paymentDate: undefined, paymentTime: undefined, upiLast4: "" });
    const created = await api("POST", "/leads/create", input);
    assert.equal(created.status, 201, created.json.message);
    assert.equal(await PaymentHistory.countDocuments({ bookingId: created.json.booking._id }), 0);
    const booking = await Booking.findById(created.json.booking._id).lean();
    for (const snapshot of [booking, booking.payment]) {
      for (const field of ["paymentDate", "paymentTime", "customPaymentDate"]) assert.equal(Object.hasOwn(snapshot, field), false);
    }
  }
});

test("PhonePe last-four validation remains enforced and timestamps do not bypass it", async () => {
  for (const upiLast4 of ["", "123", "abcd", "12345"]) {
    const response = await api("POST", "/leads/create", body({ upiLast4 }));
    assert.equal(response.status, 400);
    assert.match(response.json.message, /PhonePe UPI last 4 digits are required/);
  }
});

test("idempotent retries preserve the first saved timestamp and never duplicate the advance", async () => {
  const input = body();
  const post = async payload => {
    const response = await fetch(`${ctx.base}/leads/create`, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": "payment-time-retry-0001",
    }, body: JSON.stringify(payload) });
    return { status: response.status, json: await response.json() };
  };
  const first = await post(input);
  assert.equal(first.status, 201, first.json.message);
  const before = await PaymentHistory.find({ bookingId: first.json.booking._id }).lean();
  const bookingBefore = await Booking.findById(first.json.booking._id).lean();
  const retry = await post({ ...input, paymentTime: "15:35" });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.booking._id, first.json.booking._id);
  assert.deepEqual(await PaymentHistory.find({ bookingId: first.json.booking._id }).lean(), before);
  assert.deepEqual(await Booking.findById(first.json.booking._id).lean(), bookingBefore);
  assert.equal(before.length, 1);
  assert.equal((await Vehicle.findById(vehicleId)).payments.filter(id => String(id) === String(before[0]._id)).length, 1);
});

test("legacy records stay readable and booking edits do not rewrite payment timestamps", async () => {
  const created = await api("POST", "/leads/create", body());
  const id = created.json.booking._id;
  const existingPayment = await PaymentHistory.findOne({ bookingId: id });
  const manualDate = existingPayment.customPaymentDate.toISOString();
  const storedTime = existingPayment.paymentTime;
  const originalDate = new Date(existingPayment.customPaymentDate.getTime() + 60 * 60 * 1000);
  existingPayment.paymentDate = originalDate;
  await existingPayment.save();
  const saved = await PaymentHistory.collection.findOne({ _id: existingPayment._id });
  assert.equal(saved.paymentDate.toISOString(), originalDate.toISOString());
  assert.equal(saved.customPaymentDate.toISOString(), manualDate, "saving preserves a distinct manual timestamp");
  assert.equal(saved.paymentTime, storedTime);
  const existingBooking = await Booking.findById(id);
  existingBooking.paymentDate = originalDate;
  existingBooking.payment.paymentDate = originalDate;
  await existingBooking.save();
  const before = await PaymentHistory.find({ bookingId: id }).lean();
  assert.equal((await api("PUT", `/leads/booking-update/${id}`, { destination: "Timestamp retained", paymentDate: dayFromToday(-2), paymentTime: "01:00" })).status, 200);
  assert.deepEqual(await PaymentHistory.find({ bookingId: id }).lean(), before);
  const edited = await Booking.findById(id).lean();
  for (const snapshot of [edited, edited.payment]) {
    assert.equal(snapshot.paymentDate.toISOString(), originalDate.toISOString());
    assert.equal(snapshot.customPaymentDate.toISOString(), manualDate);
    assert.equal(snapshot.paymentTime, storedTime);
  }
  const payment = before[0];
  await PaymentHistory.collection.updateOne({ _id: payment._id }, { $unset: { paymentDate: "", customPaymentDate: "", paymentTime: "" } });
  const legacy = await PaymentHistory.collection.findOne({ _id: payment._id });
  const history = await api("GET", "/dashboard/payments-history?limit=500");
  assert.equal(history.status, 200);
  const row = history.json.data.find(row => row._id === String(payment._id));
  assert.ok(row);
  assert.equal(row.paymentDate, undefined);
  assert.equal(row.paymentTime, undefined);
  assert.deepEqual(await PaymentHistory.collection.findOne({ _id: payment._id }), legacy);
  await Booking.collection.updateOne({ _id: existingBooking._id }, { $unset: {
    paymentDate: "", paymentTime: "", customPaymentDate: "",
    "payment.paymentDate": "", "payment.paymentTime": "", "payment.customPaymentDate": "",
  } });
  assert.equal((await api("PUT", `/leads/booking-update/${id}`, { destination: "Legacy dates absent" })).status, 200);
  const reopened = await api("GET", `/bookings/${id}`);
  assert.equal(reopened.status, 200);
  for (const snapshot of [reopened.json.booking, reopened.json.booking.payment]) {
    for (const field of ["paymentDate", "paymentTime", "customPaymentDate"]) assert.equal(Object.hasOwn(snapshot, field), false);
  }
  assert.equal(reopened.json.booking.payment.totalAmount, edited.payment.totalAmount);
  assert.equal(reopened.json.booking.payment.balanceAmount, edited.payment.balanceAmount);
  assert.deepEqual(await PaymentHistory.collection.findOne({ _id: payment._id }), legacy);
});

test("frontend and backend timestamp validation agree independently of local timezone", async () => {
  const browser = await import("../../my-sawari-Frontend/utils/bookingPaymentTime.mjs");
  const now = new Date("2026-10-28T10:00:00Z");
  for (const paymentMethod of ["phonepe", "gpay", "cash", "mixed", "razorpay"]) {
    for (const [paymentDate, paymentTime] of [["2026-10-28", "14:35"], ["2026-10-28", "00:30"], ["2024-02-29", "23:59"], ["2026-10-28", "15:31"], ["2026-02-30", "10:00"], ["", ""], ["2026-10-28", "24:00"]]) {
      const input = { paymentMethod, bookingAmount: 500, paymentDate, paymentTime };
      assert.deepEqual(validateBookingPaymentTime(input, now), browser.validateBookingPaymentTime(input, now));
    }
  }
});
