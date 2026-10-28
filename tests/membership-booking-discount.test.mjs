import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";

let ctx, api, token, Customer, Membership, Booking, PaymentHistory;
let vehicleId, otherVehicleId;
let customerSequence = 0;
let dateSequence = 5;
const DAY = 86400000;

before(async () => {
  ctx = await startTestApp();
  ({ token } = await createUserAndLogin(ctx.base));
  api = client(ctx.base, token);
  ({ default: Customer } = await import("../src/models/customer.model.js"));
  ({ default: Membership } = await import("../src/models/membership.model.js"));
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
  const vehicle = async (plate) => {
    const res = await api("POST", "/vehicles/create", { vehicleName: "Membership pricing fixture", vehicleNumber: plate, manufacturer: "Test", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
    assert.equal(res.status, 201);
    const id = res.json.data._id;
    assert.equal((await api("PUT", `/vehicles/update/${id}`, { pricePerDay: 1000 })).status, 200);
    return id;
  };
  vehicleId = await vehicle("KA01MD0001");
  otherVehicleId = await vehicle("KA01MD0002");
});

after(async () => { await ctx?.stop(); });

async function member(plan = "starter", overrides = {}) {
  customerSequence += 1;
  const mobileNumber = `910000${String(customerSequence).padStart(4, "0")}`;
  const customer = await Customer.create({ customerName: "Isolated pricing customer", mobileNumber });
  const membership = await Membership.create({
    customerId: customer._id, membershipId: `MEM-PRICING-${customerSequence}`,
    plan, createdBy: "customer_app", activatedAt: new Date(Date.now() - DAY),
    expiresAt: new Date(Date.now() + 365 * DAY), totalSaved: 0,
    payment: { status: "completed" }, ...overrides,
  });
  return { customer, membership, mobileNumber };
}

function bodyFor(mobileNumber, extra = {}) {
  dateSequence += 5;
  return {
    customerName: "Isolated pricing customer", mobileNumber, vehicleId,
    fromDate: dayFromToday(dateSequence), toDate: dayFromToday(dateSequence + 2),
    flexibleTime: true, pickupTime: "10:00 AM", dropTime: "10:00 AM", paymentMethod: "cash", tripType: "local", ...extra,
  };
}

const quote = (body) => api("POST", "/memberships/discount", {
  mobileNumber: body.mobileNumber, vehicleId: body.vehicleId,
  fromDate: body.fromDate, toDate: body.toDate,
  flexibleTime: body.flexibleTime, pickupTime: body.pickupTime, dropTime: body.dropTime,
  pickupCharge: body.pickupDropRequired ? Number(body.pickup?.charge || 0) : 0,
  dropCharge: body.pickupDropRequired ? Number(body.drop?.charge || 0) : 0,
});

async function createWithKey(body, key) {
  const res = await fetch(`${ctx.base}/leads/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("the discount quote requires authentication and never increments savings", async () => {
  const fixture = await member();
  const body = bodyFor(fixture.mobileNumber);
  const anon = await client(ctx.base)("POST", "/memberships/discount", body);
  assert.equal(anon.status, 401);
  const quoted = await quote(body);
  assert.equal(quoted.status, 200);
  assert.equal(quoted.json.discount.amount, 100);
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 0);
  assert.equal(await Booking.countDocuments(), 0);
});

test("the server quotes and saves the three established plans", async () => {
  for (const [plan, expected] of [["starter", 100], ["plus", 200], ["pro", 250]]) {
    const fixture = await member(plan);
    const body = bodyFor(fixture.mobileNumber, { fastagBalance: 300 });
    const quoted = await quote(body);
    assert.equal(quoted.json.discount.amount, expected);
    const created = await api("POST", "/leads/create", { ...body, expectedMembershipDiscount: expected, membershipDiscount: 99999, membership: { plan: "pro" } });
    assert.equal(created.status, 201, created.json.message);
    const payment = created.json.booking.payment;
    assert.equal(payment.membershipDiscount, expected);
    assert.equal(payment.totalAmount, 2300, "gross fare and FASTag semantics stay intact");
    assert.equal(payment.discountAmount, expected);
    assert.equal(payment.balanceAmount, 2300 - expected);
    assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, expected);
  }
});

test("membership, manual discount, FASTag, pickup/drop and advance persist and reopen consistently", async () => {
  const fixture = await member("starter", { totalSaved: 10 });
  const body = bodyFor(fixture.mobileNumber, {
    fastagBalance: 250, discountAmount: 50, bookingAmount: 500, paymentMethod: "gpay",
    pickupDropRequired: true, serviceType: "pickup_drop",
    pickup: { location: "Pickup fixture", charge: 150 }, drop: { location: "Drop fixture", charge: 150 },
  });
  const quoted = await quote(body);
  assert.equal(quoted.json.discount.eligibleBase, 2300);
  assert.equal(quoted.json.discount.amount, 115);
  const created = await api("POST", "/leads/create", { ...body, expectedMembershipDiscount: 115 });
  assert.equal(created.status, 201, created.json.message);
  const id = created.json.booking._id;
  const reopened = await api("GET", `/bookings/${id}`);
  const payment = reopened.json.booking.payment;
  assert.equal(payment.vehicleRent, 2000);
  assert.equal(payment.totalAmount, 2550);
  assert.equal(payment.membershipDiscount, 115);
  assert.equal(payment.manualDiscount, 50);
  assert.equal(payment.discountAmount, 165);
  assert.equal(payment.totalAmount - payment.discountAmount, 2385);
  assert.equal(payment.balanceAmount, 1885);
  assert.equal(payment.bookingAmountPaid, 500);
  assert.equal(payment.paymentMethod, "gpay");
  assert.equal(await PaymentHistory.countDocuments({ bookingId: id }), 1);
  assert.equal((await PaymentHistory.findOne({ bookingId: id })).amount, 500);
  const edited = await api("PUT", `/leads/booking-update/${id}`, { destination: "Updated destination" });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.json.booking.payment, payment, "reopening/editing never reapplies savings");
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 125);
});

test("unpaid, legacy, future and expired memberships never receive automatic discounts", async () => {
  for (const overrides of [
    { payment: undefined }, { payment: { status: "pending" } },
    { activatedAt: new Date(Date.now() + DAY) }, { expiresAt: new Date(Date.now() - DAY) },
  ]) {
    const fixture = await member("starter", overrides);
    const body = bodyFor(fixture.mobileNumber);
    assert.equal((await quote(body)).json.discount.amount, 0);
    const created = await api("POST", "/leads/create", body);
    assert.equal(created.status, 201, created.json.message);
    assert.equal(created.json.booking.payment.membershipDiscount, 0);
    assert.equal(created.json.booking.payment.balanceAmount, 2000);
    assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 0);
  }
});

test("each plan respects its remaining annual allowance", async () => {
  for (const [plan, cap] of [["starter", 10000], ["plus", 15000], ["pro", 20000]]) {
    const fixture = await member(plan, { totalSaved: cap - 20 });
    const body = bodyFor(fixture.mobileNumber);
    assert.equal((await quote(body)).json.discount.amount, 20);
    const created = await api("POST", "/leads/create", body);
    assert.equal(created.status, 201, created.json.message);
    assert.equal(created.json.booking.payment.membershipDiscount, 20);
    assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, cap);
    assert.equal((await quote(body)).json.discount.amount, 0);
  }
});

test("same request retries return the saved booking and credit savings/payment only once", async () => {
  const fixture = await member();
  const body = bodyFor(fixture.mobileNumber, { bookingAmount: 500, expectedMembershipDiscount: 100 });
  const key = "isolated-membership-retry-0001";
  const first = await createWithKey(body, key);
  assert.equal(first.status, 201, first.json.message);
  const retry = await createWithKey(body, key);
  assert.equal(retry.status, 200, retry.json.message);
  assert.equal(retry.json.booking._id, first.json.booking._id);
  assert.equal(await Booking.countDocuments({ _id: first.json.booking._id }), 1);
  assert.equal(await PaymentHistory.countDocuments({ bookingId: first.json.booking._id }), 1);
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 100);
});

test("concurrent bookings cannot spend the same remaining annual allowance", async () => {
  const fixture = await member("starter", { totalSaved: 9970 });
  const body = bodyFor(fixture.mobileNumber, { expectedMembershipDiscount: 30 });
  const results = await Promise.all([
    createWithKey(body, "isolated-concurrent-cap-0001"),
    createWithKey({ ...body, vehicleId: otherVehicleId }, "isolated-concurrent-cap-0002"),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 10000);
  assert.equal(await Booking.countDocuments({ mobileNumber: fixture.mobileNumber }), 1);
});

test("concurrent identical same-day requests credit savings only once", async () => {
  const fixture = await member();
  const body = bodyFor(fixture.mobileNumber, { bookingAmount: 100 });
  body.toDate = body.fromDate;
  const key = "isolated-identical-retry-0001";
  const results = await Promise.all([createWithKey(body, key), createWithKey(body, key)]);
  assert.ok(results.some((r) => r.status === 201));
  assert.ok(results.every((r) => [200, 201, 409].includes(r.status)));
  const retry = await createWithKey(body, key);
  assert.equal(retry.status, 200);
  assert.equal(await Booking.countDocuments({ mobileNumber: fixture.mobileNumber }), 1);
  assert.equal(await PaymentHistory.countDocuments({ bookingId: retry.json.booking._id }), 1);
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 50);
});

test("a failed booking transaction rolls back its membership savings and payments", async () => {
  const fixture = await member();
  const body = bodyFor(fixture.mobileNumber, { bookingAmount: 100 });
  const bookingsBefore = await Booking.countDocuments();
  const paymentsBefore = await PaymentHistory.countDocuments();
  const original = PaymentHistory.create;
  PaymentHistory.create = async () => { throw new Error("Isolated payment persistence failure"); };
  let result;
  try { result = await api("POST", "/leads/create", body); }
  finally { PaymentHistory.create = original; }
  assert.equal(result.status, 500);
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 0);
  assert.equal(await Booking.countDocuments(), bookingsBefore);
  assert.equal(await PaymentHistory.countDocuments(), paymentsBefore);
});

test("a stale preview is rejected before booking, payment or savings changes", async () => {
  const fixture = await member();
  const body = bodyFor(fixture.mobileNumber, { expectedMembershipDiscount: 1 });
  const created = await api("POST", "/leads/create", body);
  assert.equal(created.status, 409);
  assert.match(created.json.message, /Membership savings changed/);
  assert.equal(await Booking.countDocuments({ mobileNumber: fixture.mobileNumber }), 0);
  assert.equal((await Membership.findById(fixture.membership._id)).totalSaved, 0);
});
