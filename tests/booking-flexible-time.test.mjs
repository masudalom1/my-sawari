import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bookingDuration, bookingTimeMinutes, effectiveBookingEndDate } from "../shared/bookingDuration.mjs";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";

let ctx, api, vehicleId, Booking, Membership, Customer, Maintenance;
let sequence = 0;
before(async () => {
  ctx = await startTestApp();
  api = client(ctx.base, (await createUserAndLogin(ctx.base)).token);
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: Membership } = await import("../src/models/membership.model.js"));
  ({ default: Customer } = await import("../src/models/customer.model.js"));
  ({ default: Maintenance } = await import("../src/models/maintenance.model.js"));
  const created = await api("POST", "/vehicles/create", { vehicleName: "Time fixture", vehicleNumber: "KA01FT0001", manufacturer: "Test", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
  assert.equal(created.status, 201);
  vehicleId = created.json.data._id;
  assert.equal((await api("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);
});
after(async () => { await ctx?.stop(); });
function body(extra = {}) {
  sequence += 1;
  return { customerName: "Isolated time customer", mobileNumber: `920000${String(sequence).padStart(4, "0")}`,
    vehicleId, paymentMethod: "cash", fromDate: dayFromToday(sequence * 5), toDate: dayFromToday(sequence * 5 + 2),
    pickupTime: "08:00 AM", dropTime: "08:00 AM", ...extra };
}

test("standard mode saves the effective end date once and reopens without extending again", async () => {
  for (const [dropTime, days] of [["07:59 AM", 2], ["08:00 AM", 2], ["08:01 AM", 3], ["09:00 AM", 3], ["11:59 PM", 3], ["12:01 AM", 2], ["12:00 PM", 3]]) {
    const input = body({ dropTime, totalDays: 999, totalAmount: 1 });
    const result = await api("POST", "/leads/create", input);
    assert.equal(result.status, 201, result.json.message);
    const raw = await Booking.collection.findOne({ _id: new ctx.mongoose.Types.ObjectId(result.json.booking._id) });
    const saved = (await api("GET", `/bookings/${raw._id}`)).json.booking;
    assert.equal(raw.flexibleTime, false);
    assert.equal(saved.flexibleTime, false);
    assert.equal(saved.totalDays, days, dropTime);
    assert.equal(saved.payment.vehicleRent, days * 1000);
    assert.equal(saved.payment.totalAmount, days * 1000);
    assert.equal(saved.pickupTime, "08:00 AM");
    assert.equal(saved.originalEndDate.slice(0, 10), input.toDate);
    const effectiveEndDate = effectiveBookingEndDate(input.toDate, false, dropTime);
    assert.equal(saved.toDate.slice(0, 10), effectiveEndDate);
    const unchanged = await api("PUT", `/leads/booking-update/${raw._id}`, { destination: "Read-back fixture" });
    assert.equal(unchanged.status, 200, unchanged.json.message);
    assert.equal(unchanged.json.booking.totalDays, days);
    assert.equal(unchanged.json.booking.toDate.slice(0, 10), effectiveEndDate);
    assert.deepEqual(unchanged.json.booking.payment, saved.payment);
  }
});

test("flexible mode preserves valid custom times and date-only pricing; standard pickup is enforced", async () => {
  const custom = await api("POST", "/leads/create", body({ flexibleTime: true, pickupTime: "14:30", dropTime: "16:00" }));
  assert.equal(custom.status, 201, custom.json.message);
  assert.equal(custom.json.booking.flexibleTime, true);
  assert.equal(custom.json.booking.pickupTime, "14:30");
  assert.equal(custom.json.booking.totalDays, 2);
  assert.equal(custom.json.booking.payment.vehicleRent, 2000);
  const fixed = await api("POST", "/leads/create", body({ flexibleTime: false, pickupTime: "10:00 AM", dropTime: "09:00 AM" }));
  assert.equal(fixed.status, 201);
  assert.equal(fixed.json.booking.pickupTime, "08:00 AM");
  assert.equal(fixed.json.booking.totalDays, 3);
});

test("late-drop pricing recalculates membership caps, manual discount, charges, advance and balance", async () => {
  for (const [plan, saved, expected] of [["starter", 0, 165], ["plus", 14980, 20], ["pro", 0, 413]]) {
    const input = body({ dropTime: "09:00 AM", fastagBalance: 250, discountAmount: 50, bookingAmount: 500,
      pickupDropRequired: true, serviceType: "pickup_drop", pickup: { location: "Fixture", charge: 150 }, drop: { location: "Fixture", charge: 150 } });
    const customer = await Customer.create({ customerName: input.customerName, mobileNumber: input.mobileNumber });
    const membership = await Membership.create({ customerId: customer._id, membershipId: `MEM-TIME-${sequence}`, plan,
      activatedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() + 365 * 86400000), totalSaved: saved, payment: { status: "completed" } });
    const quoted = await api("POST", "/memberships/discount", { ...input, pickupCharge: 150, dropCharge: 150 });
    assert.equal(quoted.status, 200, quoted.json.message);
    assert.equal(quoted.json.discount.eligibleBase, 3300);
    assert.equal(quoted.json.discount.amount, expected);
    const created = await api("POST", "/leads/create", { ...input, expectedMembershipDiscount: expected });
    assert.equal(created.status, 201, created.json.message);
    const payment = created.json.booking.payment;
    assert.equal(payment.vehicleRent, 3000);
    assert.equal(payment.totalAmount, 3550);
    assert.equal(payment.membershipDiscount, expected);
    assert.equal(payment.discountAmount, expected + 50);
    assert.equal(payment.balanceAmount, 3550 - expected - 50 - 500);
    assert.equal((await Membership.findById(membership._id)).totalSaved, saved + expected);
    const flexible = await api("POST", "/memberships/discount", { ...input, flexibleTime: true, pickupCharge: 150, dropCharge: 150 });
    assert.equal(flexible.json.discount.eligibleBase, 2300);
  }
});

test("invalid times, invalid modes and reversed time ranges are rejected without writes", async () => {
  const count = await Booking.countDocuments();
  for (const invalid of ["25:00", "08:60", "13:00 PM", "00:00 AM", "invalid", "", null, {}]) {
    for (const key of ["pickupTime", "dropTime"]) {
      const input = body({ flexibleTime: true, [key]: invalid });
      assert.equal((await api("POST", "/leads/create", input)).status, 400);
      assert.equal((await api("POST", "/memberships/discount", input)).status, 400);
    }
  }
  for (const flexibleTime of ["false", 0, null]) assert.equal((await api("POST", "/leads/create", body({ flexibleTime }))).status, 400);
  const input = body({ pickupTime: "10:00 AM", dropTime: "09:00 AM", flexibleTime: true });
  input.toDate = input.fromDate;
  assert.equal((await api("POST", "/leads/create", input)).status, 400);
  assert.equal(await Booking.countDocuments(), count);
});

test("extended intervals enforce booking and maintenance conflicts and allow exact return boundaries", async () => {
  const input = body({ dropTime: "09:00 AM" });
  const result = await api("POST", "/leads/create", input);
  assert.equal(result.status, 201);
  const effectiveEndDate = result.json.booking.toDate.slice(0, 10);
  const overlap = await api("POST", "/leads/create", body({ fromDate: input.toDate, toDate: dayFromToday(sequence * 5 + 3), flexibleTime: true, pickupTime: "08:30 AM" }));
  assert.equal(overlap.status, 409);
  const adjacent = await api("POST", "/leads/create", body({ fromDate: effectiveEndDate, toDate: effectiveEndDate, flexibleTime: true, pickupTime: "09:00 AM", dropTime: "11:00 AM" }));
  assert.equal(adjacent.status, 201, adjacent.json.message);
  const maintenanceInput = body({ dropTime: "09:00 AM" });
  const maintenance = await Maintenance.create({ vehicle: vehicleId, startDate: `${maintenanceInput.toDate}T10:00:00Z`, endDate: `${maintenanceInput.toDate}T14:00:00Z`, status: "Scheduled" });
  const extendedConflict = await api("POST", "/leads/create", maintenanceInput);
  assert.equal(extendedConflict.status, 409);
  assert.match(extendedConflict.json.message, /maintenance/);
  const blocked = await api("POST", "/leads/create", body({ fromDate: maintenanceInput.toDate, toDate: maintenanceInput.toDate, flexibleTime: true, pickupTime: "11:00 AM", dropTime: "12:00 PM" }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.message, /maintenance/);
  await Maintenance.updateOne({ _id: maintenance._id }, { status: "Completed" });
  assert.equal((await api("POST", "/leads/create", maintenanceInput)).status, 201);
});

test("historical bookings keep their absent mode, saved times and fare on reopen and edit", async () => {
  const template = await api("POST", "/leads/create", body({ flexibleTime: true, pickupTime: "11:00 AM", dropTime: "06:00 PM" }));
  const id = new ctx.mongoose.Types.ObjectId(template.json.booking._id);
  await Booking.collection.updateOne({ _id: id }, { $unset: { flexibleTime: "", originalEndDate: "" }, $set: { totalDays: 7, "payment.vehicleRent": 7777, "payment.totalAmount": 7777, "payment.balanceAmount": 7777 } });
  const before = await Booking.collection.findOne({ _id: id });
  const opened = await api("GET", `/bookings/${id}`);
  assert.equal(opened.json.booking.flexibleTime, undefined);
  assert.equal(opened.json.booking.totalDays, 7);
  const edited = await api("PUT", `/leads/booking-update/${id}`, { customerName: "Legacy still editable" });
  assert.equal(edited.status, 200, edited.json.message);
  const after = await Booking.collection.findOne({ _id: id });
  assert.equal(after.flexibleTime, undefined);
  assert.equal(after.totalDays, 7);
  assert.equal(after.pickupTime, before.pickupTime);
  assert.deepEqual(after.payment, before.payment);
});

test("browser and server duration rules agree at time and date boundaries", async () => {
  const browser = await import("../../my-sawari-Frontend/utils/bookingDuration.mjs");
  for (const flexibleTime of [false, true]) for (const dropTime of ["07:59", "08:00", "08:01", "09:00", "23:59", "12:00 AM", "12:00 PM", "bad"]) {
    const input = { fromDate: "2026-12-31", toDate: "2027-01-02", flexibleTime, pickupTime: "08:00", dropTime };
    assert.deepEqual(browser.bookingDuration(input), bookingDuration(input));
  }
  assert.equal(bookingTimeMinutes("12:00 AM"), 0);
  assert.equal(bookingTimeMinutes("12:00 PM"), 720);
});

test("all dashboard calendar responses retain the saved mode, times, dates and booking id", async () => {
  for (const [flexibleTime, dropTime, days] of [[false, "08:00 AM", 2], [false, "09:00 AM", 3], [false, "11:00 AM", 3], [true, "11:00 AM", 2]]) {
    const input = body({ flexibleTime, dropTime });
    const created = await api("POST", "/leads/create", input);
    assert.equal(created.status, 201, created.json.message);
    const id = created.json.booking._id;
    const count = await Booking.countDocuments();
    const before = await Booking.findById(id).lean();
    const range = new URLSearchParams({ scope: "range", from: `${input.fromDate}T00:00:00Z`, to: `${input.toDate}T23:59:59Z` });
    for (const path of ["/dashboard/bookings/import", "/dashboard/bookings/timeline?scope=live", `/dashboard/bookings/timeline?${range}`]) {
      const result = await api("GET", path);
      assert.equal(result.status, 200, result.json.message);
      const booking = result.json.bookings.find(item => item._id === id);
      assert.ok(booking, path);
      assert.equal(booking.flexibleTime, flexibleTime, path);
      assert.equal(booking.pickupTime, "08:00 AM");
      assert.equal(booking.dropTime, dropTime);
      assert.equal(booking.fromDate.slice(0, 10), input.fromDate);
      assert.equal(booking.originalEndDate.slice(0, 10), input.toDate);
      assert.equal(booking.toDate.slice(0, 10), effectiveBookingEndDate(input.toDate, flexibleTime, dropTime));
      assert.equal(booking.totalDays, days);
    }
    assert.equal(await Booking.countDocuments(), count);
    assert.deepEqual(await Booking.findById(id).lean(), before, "calendar reads leave pricing and records unchanged");
  }
});

test("explicit original/effective dates and forged totals never extend or bill twice", async () => {
  const input = body({ dropTime: "09:00 AM", flexibleTime: false });
  input.originalEndDate = input.toDate;
  input.toDate = effectiveBookingEndDate(input.originalEndDate, false, input.dropTime);
  const created = await api("POST", "/leads/create", { ...input, totalDays: 999, totalAmount: 1 });
  assert.equal(created.status, 201, created.json.message);
  const saved = created.json.booking;
  assert.equal(saved.toDate.slice(0, 10), input.toDate);
  assert.equal(saved.originalEndDate.slice(0, 10), input.originalEndDate);
  assert.equal(saved.totalDays, 3);
  assert.equal(saved.payment.vehicleRent, 3000);
  const quoted = await api("POST", "/memberships/discount", input);
  assert.equal(quoted.status, 200);
  assert.equal(quoted.json.discount.eligibleBase, 3000);
  const count = await Booking.countDocuments();
  for (let retry = 0; retry < 2; retry++) {
    const edited = await api("PUT", `/leads/booking-update/${saved._id}`, { originalEndDate: input.originalEndDate, toDate: input.toDate, dropTime: input.dropTime });
    assert.equal(edited.status, 200, edited.json.message);
    assert.equal(edited.json.booking.toDate.slice(0, 10), input.toDate);
    assert.equal(edited.json.booking.totalDays, 3);
    assert.deepEqual(edited.json.booking.payment, saved.payment);
  }
  assert.equal(await Booking.countDocuments(), count);
});
