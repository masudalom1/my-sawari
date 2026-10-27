// Membership lookup for the New Booking form:
// mobile number -> Customer -> Membership.customerId, read-only, minimal response.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

let ctx;
let anon;
let api;
let Customer;
let Membership;

const DAY = 24 * 60 * 60 * 1000;
const PAID = { status: "completed", amount: 499, paymentMethod: "razorpay", paymentId: "pay_secret", transactionId: "txn_secret", upiLastFour: "4321" };
const MEMBERSHIP_FIELDS = ["activatedAt", "expiresAt", "membershipId", "plan", "totalSaved"];

async function customerWith(mobileNumber, membership) {
  const customer = await Customer.create({ customerName: `Customer ${mobileNumber}`, mobileNumber });
  if (membership) {
    await Membership.create({ customerId: customer._id, customerName: customer.customerName, createdBy: "customer_app", ...membership });
  }
  return customer;
}

before(async () => {
  ctx = await startTestApp();
  anon = client(ctx.base);
  api = client(ctx.base, (await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" })).token);
  ({ default: Customer } = await import("../src/models/customer.model.js"));
  ({ default: Membership } = await import("../src/models/membership.model.js"));

  const now = Date.now();
  await customerWith("9000000001", { membershipId: "MEM-ACTIVE", plan: "plus", activatedAt: new Date(now - 10 * DAY), expiresAt: new Date(now + 30 * DAY), totalSaved: 73.25, payment: PAID });
  await customerWith("9000000002", { membershipId: "MEM-EXPIRED", plan: "starter", activatedAt: new Date(now - 400 * DAY), expiresAt: new Date(now - DAY), payment: PAID });
  await customerWith("9000000003");
  await customerWith("9000000004", { membershipId: "MEM-UNPAID", plan: "pro", activatedAt: new Date(now - DAY), expiresAt: new Date(now + 30 * DAY), payment: { status: "pending" } });
  await customerWith("9000000005", { membershipId: "MEM-FUTURE", plan: "pro", activatedAt: new Date(now + 5 * DAY), expiresAt: new Date(now + 400 * DAY), payment: PAID });
  // Older records exist without membershipId or payment.
  await customerWith("9000000006", { plan: "starter", activatedAt: new Date(now - DAY), expiresAt: new Date(now + 30 * DAY) });
  await customerWith("9000000007", { membershipId: "MEM-FAILED", plan: "plus", activatedAt: new Date(now - DAY), expiresAt: new Date(now + 30 * DAY), payment: { ...PAID, status: "failed" } });
  await customerWith("9000000008", { membershipId: "MEM-NO-ACTIVATION", plan: "starter", expiresAt: new Date(now + 30 * DAY), payment: PAID });
  await customerWith("9000000009", { membershipId: "MEM-NO-EXPIRY", plan: "starter", activatedAt: new Date(now - DAY), payment: PAID });
});

after(async () => {
  await ctx?.stop();
});

const check = (mobileNumber) => api("POST", "/memberships/check", { mobileNumber });

test("membership check requires authentication", async () => {
  const res = await anon("POST", "/memberships/check", { mobileNumber: "9000000001" });
  assert.equal(res.status, 401);
});

test("blocked, suspended and deleted accounts cannot check memberships", async () => {
  const { default: User } = await import("../src/models/user.model.js");
  const account = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const restricted = client(ctx.base, account.token);
  for (const update of [
    { accountStatus: "BLOCKED" },
    { accountStatus: "SUSPENDED" },
    { accountStatus: "DELETED" },
    { accountStatus: "ACTIVE", deletedAt: new Date() },
  ]) {
    await User.updateOne({ email: account.email }, { $set: update });
    const res = await restricted("POST", "/memberships/check", { mobileNumber: "9000000001" });
    assert.equal(res.status, 403);
    assert.equal(res.json.membership, undefined);
  }
});

test("membership responses cannot be cached", async () => {
  const account = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const res = await fetch(`${ctx.base}/memberships/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ mobileNumber: "9000000001" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  await res.json();
});

test("an active membership returns only the safe membership details and actual savings", async () => {
  const res = await check("9000000001");
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "active");
  assert.deepEqual(Object.keys(res.json).sort(), ["membership", "status", "success"]);
  assert.deepEqual(Object.keys(res.json.membership).sort(), MEMBERSHIP_FIELDS);
  assert.equal(res.json.membership.membershipId, "MEM-ACTIVE");
  assert.equal(res.json.membership.plan, "plus");
  assert.ok(new Date(res.json.membership.activatedAt) <= new Date());
  assert.equal(res.json.membership.totalSaved, 73.25);

  const body = JSON.stringify(res.json);
  for (const secret of ["pay_secret", "txn_secret", "4321", "Customer 9000000001", "9000000001"]) {
    assert.ok(!body.includes(secret), `response must not include ${secret}`);
  }
});

test("customer-app and operation-app memberships use the linked Customer ObjectId without a root status", async () => {
  const staff = client(ctx.base, (await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" })).token);
  const activatedAt = new Date(Date.now() - DAY);
  const expiresAt = new Date(Date.now() + 365 * DAY);
  for (const [index, createdBy] of ["customer_app", "operation_app"].entries()) {
    const mobileNumber = `900000001${index}`;
    const customer = await customerWith(mobileNumber, {
      membershipId: `MEM-ORIGIN-${index}`,
      customerName: "A stale name must not affect the ObjectId lookup",
      createdBy,
      plan: "starter",
      activatedAt,
      expiresAt,
      totalSaved: 42.5,
      payment: { ...PAID, paymentMethod: "upi", paymentBreakdown: { cash: 0, phonePe: 0, razorpay: 499 }, paidAt: activatedAt },
    });
    const stored = await Membership.findOne({ customerId: customer._id }).lean();
    assert.equal(stored.customerId.toString(), customer._id.toString());
    assert.equal(stored.status, undefined);
    const res = await staff("POST", "/memberships/check", { mobileNumber });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "active");
    assert.deepEqual(res.json.membership, {
      membershipId: `MEM-ORIGIN-${index}`,
      plan: "starter",
      activatedAt: activatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      totalSaved: 42.5,
    });
  }
});

test("duplicate customer mobile numbers are rejected without choosing a membership", async () => {
  const staff = client(ctx.base, (await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" })).token);
  const mobileNumber = "9000000012";
  await customerWith(mobileNumber, {
    membershipId: "MEM-AMBIGUOUS", plan: "pro", activatedAt: new Date(Date.now() - DAY),
    expiresAt: new Date(Date.now() + DAY), payment: PAID,
  });
  await customerWith(mobileNumber);
  const res = await staff("POST", "/memberships/check", { mobileNumber });
  assert.equal(res.status, 409);
  assert.equal(res.json.success, false);
  assert.match(res.json.message, /More than one customer/);
  assert.equal(res.json.membership, undefined);
  assert.ok(!JSON.stringify(res.json).includes(mobileNumber));
});

test("activation and expiry boundaries use exact UTC instants", async () => {
  const { membershipStatus } = await import("../src/controllers/membership.controller.js");
  const now = new Date("2030-01-10T06:00:00.000Z");
  const membership = { payment: { status: "completed" }, activatedAt: now, expiresAt: new Date(now.getTime() + 1) };
  assert.equal(membershipStatus(membership, now), "active");
  assert.equal(membershipStatus({ ...membership, expiresAt: now }, now), "expired");
  assert.equal(membershipStatus({ ...membership, activatedAt: new Date(now.getTime() + 1) }, now), "inactive");
  assert.equal(membershipStatus({ ...membership, payment: { status: "pending" } }, now), "inactive");
});

test("formatted numbers (+91, spaces, leading 0) find the same customer", async () => {
  for (const input of ["+91 90000 00001", "090000-00001", " 9000000001 "]) {
    const res = await check(input);
    assert.equal(res.json.status, "active", input);
  }
});

test("an expired membership reports expired with its expiry date", async () => {
  const res = await check("9000000002");
  assert.equal(res.json.status, "expired");
  assert.equal(res.json.membership.plan, "starter");
  assert.ok(new Date(res.json.membership.expiresAt) < new Date());
});

test("a customer without a membership reports none", async () => {
  const res = await check("9000000003");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, status: "none" });
});

test("found memberships retain their details when payment or activation is unverified", async () => {
  for (const [mobileNumber, reason] of [
    ["9000000004", "payment_unverified"],
    ["9000000005", "activation_scheduled"],
    ["9000000006", "payment_unverified"],
    ["9000000007", "payment_unverified"],
    ["9000000008", "incomplete_dates"],
    ["9000000009", "incomplete_dates"],
  ]) {
    const res = await check(mobileNumber);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "inactive");
    assert.equal(res.json.reason, reason);
    assert.deepEqual(Object.keys(res.json.membership).sort(), MEMBERSHIP_FIELDS);
    assert.ok(res.json.membership.plan);
    const body = JSON.stringify(res.json);
    for (const secret of [mobileNumber, "pay_secret", "txn_secret", "4321", "customerId", "paymentMethod"]) {
      assert.ok(!body.includes(secret), "response must not expose personal or payment data");
    }
  }
});

test("a legacy membership is found without inventing an ID or treating it as paid", async () => {
  const res = await check("9000000006");
  assert.equal(res.json.status, "inactive");
  assert.equal(res.json.reason, "payment_unverified");
  assert.equal(res.json.membership.membershipId, "");
  assert.equal(res.json.membership.plan, "starter");
  assert.ok(new Date(res.json.membership.expiresAt) > new Date());
});

test("an unknown mobile number reports customer not found", async () => {
  const res = await check("9111111111");
  assert.deepEqual(res.json, { success: true, status: "customer_not_found" });
});

test("invalid or non-string mobile numbers are rejected with 400", async () => {
  for (const mobileNumber of ["", "12345", "98765abcde", "+1 9000000001", "00919000000001", { $ne: null }, ["9000000001"], undefined]) {
    const res = await check(mobileNumber);
    assert.equal(res.status, 400, JSON.stringify(mobileNumber));
    assert.equal(res.json.success, false);
  }
});

test("a database failure returns a retryable error without the mobile number", async () => {
  const originalFind = Customer.find;
  const originalError = console.error;
  const errors = [];
  Customer.find = () => { throw new Error('Query failed: { mobileNumber: "9000000001" }'); };
  console.error = (...args) => errors.push(args.join(" "));
  let res;
  try {
    res = await check("9000000001");
  } finally {
    Customer.find = originalFind;
    console.error = originalError;
  }
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { success: false, message: "Unable to check membership. Please try again." });
  assert.ok(!errors.join("\n").includes("9000000001"), "mobile number must not be logged");
  assert.equal((await check("9000000001")).json.status, "active", "the next check works again");
});

test("checks never change memberships and never log the mobile number", async () => {
  const before = await Membership.find({}).lean();
  const customersBefore = await Customer.find({}).lean();
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  process.env.NODE_ENV = "development";
  try {
    await check("9000000001");
  } finally {
    console.log = originalLog;
    process.env.NODE_ENV = "test";
  }
  assert.ok(!lines.join("\n").includes("9000000001"), "mobile number must not be logged");
  assert.deepEqual(await Membership.find({}).lean(), before);
  assert.deepEqual(await Customer.find({}).lean(), customersBefore);
});

test("membership checks are rate limited per staff account", async () => {
  const limited = client(ctx.base, (await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" })).token);
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await limited("POST", "/memberships/check", { mobileNumber: "9000000003" });
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.success, false);

  // Another account still has its own allowance.
  assert.equal((await check("9000000003")).status, 200);
});
