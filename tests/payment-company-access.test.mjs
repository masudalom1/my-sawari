import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";
import { resolvePaymentReportScope } from "../src/services/paymentReportScope.js";

let ctx, api, otherApi, token, account, company, payment, PaymentHistory, original, deniedApis;
before(async () => {
  ctx = await startTestApp();
  const login = await createUserAndLogin(ctx.base, { role: "SUPER_ADMIN" });
  token = login.token;
  account = login.user.id;
  api = client(ctx.base, token);
  otherApi = client(ctx.base, (await createUserAndLogin(ctx.base, { role: "ADMIN" })).token);
  deniedApis = [];
  for (const role of ["SALES_EXECUTIVE", "FINANCE_EXECUTIVE", "BRANCH_MANAGER"]) deniedApis.push(client(ctx.base, (await createUserAndLogin(ctx.base, { role })).token));
  PaymentHistory = (await import("../src/models/paymentHistory.model.js")).default;
  company = new ctx.mongoose.Types.ObjectId();
  process.env.PAYMENTS_REPORT_COMPANY_ID = String(company);
  payment = new ctx.mongoose.Types.ObjectId();
  await PaymentHistory.collection.insertMany([
    { _id: payment, company, bookingId: new ctx.mongoose.Types.ObjectId(), amount: 300, paymentMethod: "phonepe", paymentBreakdown: { cash: 0, phonePe: 300, gpay: 0, razorpay: 0 }, type: "booking", customPaymentDate: new Date("2026-10-25T12:42:00Z"), paymentDate: new Date("2026-10-25T12:53:00Z"), createdAt: new Date("2026-10-25T12:54:13.420Z"), isCollected: false, isPhonePeCollected: false, collectedAmount: 0, collectedPhonePe: 0, collectionHistory: [], customer: { fullName: "Fixture customer", mobileNumber: "9876543210" }, createdBy: company },
    { company: new ctx.mongoose.Types.ObjectId(), bookingId: new ctx.mongoose.Types.ObjectId(), amount: 9999, paymentMethod: "cash", type: "booking", createdAt: new Date("2026-10-25T12:54:00Z") },
  ]);
  original = await PaymentHistory.collection.findOne({ _id: payment });
});
after(async () => { await ctx?.stop(); });
const scopeQuery = "period=custom&startDate=2026-10-25&endDate=2026-10-25";
test("an admin with no company membership reads the configured company instead of its own user ID", async () => {
  const response = await api("GET", `/payments/report?${scopeQuery}`);
  assert.equal(response.status, 200);
  assert.notEqual(account, String(company));
  assert.equal(response.json.pagination.total, 1);
  assert.equal(response.json.summary.total, 300);
  assert.equal(response.json.scopeSource, "configured");
});

test("list and full summary include uncollected PhonePe as a customer payment", async () => {
  for (const query of [scopeQuery, `${scopeQuery}&method=phonepe&collectionStatus=pending`, `${scopeQuery}&dateBasis=createdAt`]) {
    const response = await api("GET", `/payments/report?${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.json.scopeSource, "configured");
    assert.equal(response.json.pagination.total, 1);
    assert.equal(response.json.data[0]._id, String(payment));
    assert.equal(response.json.data[0].isCollected, false);
    assert.equal(response.json.summary.total, 300);
    assert.equal(response.json.summary.phonepe, 300);
    assert.equal(response.json.summary.pending, 300);
    assert.equal(response.json.data[0].collectedPaise, 0);
    const summary = await api("GET", `/payments/report/summary?${query}`);
    assert.deepEqual(summary.json.summary, response.json.summary);
  }
});

test("detail and export use the same configured company without modifying the payment", async () => {
  const detail = await api("GET", `/payments/report/${payment}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.payment.amount, 300);
  assert.equal(detail.json.data.collection.amount, 0);
  assert.equal(detail.json.data.readOnly, true);
  const exported = await fetch(`${ctx.base}/payments/report/export?${scopeQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.equal(csv.trim().split("\r\n").length, 2);
  assert.ok(csv.includes(String(payment)));
  assert.ok(csv.includes('"300.00"'));
  assert.equal(csv.includes("9999.00"), false);
  assert.deepEqual(await PaymentHistory.collection.findOne({ _id: payment }), original);
});

test("both admin roles share the configured target; browser company overrides stay rejected", async () => {
  assert.equal((await otherApi("GET", `/payments/report?${scopeQuery}`)).json.pagination.total, 1);
  assert.equal((await otherApi("GET", `/payments/report/${payment}`)).status, 200);
  assert.equal((await api("GET", `/payments/report?company=${company}`)).status, 400);
  assert.equal((await api("GET", `/payments/report/${payment}?companyId=${company}`)).status, 400);
});

test("missing or invalid company configuration fails closed instead of returning false zero results", async () => {
  const old = process.env.PAYMENTS_REPORT_COMPANY_ID;
  try {
    for (const value of ["", "invalid-company"]) {
      process.env.PAYMENTS_REPORT_COMPANY_ID = value;
      const response = await api("GET", `/payments/report?${scopeQuery}`);
      assert.equal(response.status, 503);
      assert.match(response.json.message, /Invalid payments report company configuration/);
    }
  } finally { process.env.PAYMENTS_REPORT_COMPANY_ID = old; }
});

test("user company fields never override the backend target and malformed configuration is rejected", () => {
  for (const user of [{ _id: account }, { _id: account, company: "" }, { companyId: account }, { _id: account, company: account }]) {
    assert.equal(String(resolvePaymentReportScope(user, String(company)).company), String(company));
    assert.equal(resolvePaymentReportScope(user, String(company)).source, "configured");
  }
  for (const value of ["null", "[]", "{", "123", `${company}\n`, { $ne: null }]) assert.throws(() => resolvePaymentReportScope({}, value), /Invalid payments report company configuration/);
});

test("non-admin roles receive 403 on every reporting endpoint, including detail aliases and exports", async () => {
  for (const denied of deniedApis) for (const path of ["/payments/report", "/payments/report/summary", "/payments/report/export", `/payments/report/${payment}`, `/payments/${payment}`]) {
    const response = await denied("GET", path);
    assert.equal(response.status, 403, path);
    assert.equal(JSON.stringify(response.json).includes("Fixture customer"), false);
  }
});

test("database query failures return errors instead of an empty successful report", async () => {
  const aggregate = PaymentHistory.aggregate;
  PaymentHistory.aggregate = () => { throw new Error("test database outage"); };
  try {
    for (const path of ["/payments/report", "/payments/report/summary"]) {
      const response = await api("GET", path);
      assert.equal(response.status, 500);
      assert.equal(response.json.success, false);
      assert.equal(Object.hasOwn(response.json, "summary"), false);
    }
  } finally { PaymentHistory.aggregate = aggregate; }
});
