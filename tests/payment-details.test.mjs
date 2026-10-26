import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

let ctx, api, otherApi, PaymentHistory, own, legacy, refund, original;
before(async () => {
  ctx = await startTestApp();
  const login = await createUserAndLogin(ctx.base, { role: "ADMIN" });
  api = client(ctx.base, login.token);
  const other = await createUserAndLogin(ctx.base, { role: "SALES_EXECUTIVE" });
  otherApi = client(ctx.base, other.token);
  PaymentHistory = (await import("../src/models/paymentHistory.model.js")).default;
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const owner = new ctx.mongoose.Types.ObjectId(login.user.id);
  process.env.PAYMENTS_REPORT_COMPANY_ID = String(owner);
  const base = { company: owner, bookingId: oid(), handoverId: oid(), createdBy: owner, amount: 2500, paymentMethod: "mixed", type: "handover", paymentBreakdown: { cash: 1000, phonePe: 1500, gpay: 0 }, collectedAmount: 400, collectedPhonePe: 100, isCollected: false, customer: { fullName: "Asha Rao", mobileNumber: "9876543210", identityDocument: "private-identity-value" }, vehicle: { vehicleName: "Swift", vehicleNumber: "KA01AB1234", ownerBankAccount: "private-bank-value" }, transactionId: "TXN-DETAIL-001", note: "Payment received", createdAt: new Date("2026-10-25T06:00:00Z"), updatedAt: new Date("2026-10-25T12:00:00Z"), providerCredentials: "private-provider-value" };
  own = { ...base, _id: oid(), lastCollectedBy: owner, lastCollectedAt: new Date("2026-10-25T11:00:00Z"), collectionHistory: [
    { _id: oid(), channel: "cash", amount: 400, collectedBy: owner, collectedByName: "Collector snapshot", collectedAt: new Date("2026-10-24T12:00:00Z"), note: "Cash received", privateToken: "private-token-value" },
    { _id: oid(), channel: "phonepe", amount: 100, collectedBy: oid(), collectedByName: "Former employee", collectedAt: new Date("2026-10-25T11:00:00Z"), note: "Verified" },
  ] };
  legacy = { ...base, _id: oid(), paymentMethod: "cash", amount: 1000, paymentBreakdown: {}, collectedAmount: 1000, collectedPhonePe: 0, isCollected: true, createdBy: oid(), lastCollectedBy: oid(), lastCollectedAt: new Date("2026-10-25T11:00:00Z"), collectionHistory: [null, { _id: oid(), amount: -1, collectedAt: "bad-date" }] };
  refund = { ...base, _id: oid(), type: "refund", amount: 200, paymentMethod: "cash", paymentBreakdown: { cash: 200 }, collectionHistory: [] };
  await PaymentHistory.collection.insertMany([own, legacy, refund]);
  original = await PaymentHistory.collection.findOne({ _id: own._id });
});
after(async () => { await ctx?.stop(); });

const details = (id, query = "") => api("GET", `/payments/report/${id}${query}`);

test("details expose the requested read-only payment, snapshots, dates and valid allocations", async () => {
  const response = await details(own._id);
  assert.equal(response.status, 200);
  const data = response.json.data;
  assert.equal(data.id, String(own._id));
  assert.equal(data.readOnly, true);
  assert.deepEqual(data.customer, { name: "Asha Rao", mobile: "9876543210", bookingId: String(own.bookingId) });
  assert.deepEqual(data.vehicle, { name: "Swift", registration: "KA01AB1234" });
  assert.equal(data.payment.amount, 2500);
  assert.equal(data.payment.transactionId, "TXN-DETAIL-001");
  assert.equal(data.payment.method, "mixed");
  assert.equal(data.payment.paymentDate, own.createdAt.toISOString());
  assert.equal(data.payment.createdDate, own.createdAt.toISOString());
  assert.equal(data.payment.note, "Payment received");
  assert.equal(data.payment.type, "handover");
  assert.equal(data.breakdown.reduce((sum, entry) => sum + entry.amount, 0), 2500);
  assert.equal(data.audit.vehicleHandoverId, String(own.handoverId));
  assert.equal(data.audit.updatedAt, own.updatedAt.toISOString());
  assert.deepEqual(data.audit.settlementReferences, []);
});

test("collection detail counts each channel once and preserves actor snapshots and event references", async () => {
  const data = (await details(own._id)).json.data;
  assert.equal(data.collection.amount, 500);
  assert.equal(data.collection.outstanding, 2000);
  assert.equal(data.collection.status, "partial");
  assert.deepEqual(data.collection.dates, ["2026-10-24T12:00:00.000Z", "2026-10-25T11:00:00.000Z"]);
  assert.equal(data.collection.history.length, 2);
  assert.equal(data.collection.history[0].collector.name, "Collector snapshot");
  assert.equal(data.collection.history[1].collector.name, "Former employee");
  assert.equal(data.collection.history[0].id, String(own.collectionHistory[0]._id));
  assert.match(data.collection.lastCollector.name, /^Test User/);
  assert.equal(data.collection.lastRecordedAt, own.lastCollectedAt.toISOString());
});

test("unavailable event histories and deleted actors stay explicit without fabricated dates", async () => {
  const data = (await details(legacy._id)).json.data;
  assert.deepEqual(data.collection.dates, []);
  assert.equal(data.collection.lastRecordedAt, legacy.lastCollectedAt.toISOString());
  assert.equal(data.collection.amount, 1000);
  assert.equal(data.collection.outstanding, 0);
  assert.equal(data.audit.createdBy.name, null);
  assert.equal(data.collection.lastCollector.name, null);
  assert.equal(data.collection.history.length, 1);
  assert.equal(data.collection.history[0].amount, null);
  assert.equal(data.collection.history[0].collectedAt, null);
  const outflow = (await details(refund._id)).json.data;
  assert.equal(outflow.payment.refund, true);
  assert.equal(outflow.collection.amount, null);
  assert.equal(outflow.collection.outstanding, null);
});

test("cross-company and missing records share a 404; authentication and ID validation are enforced", async () => {
  const inaccessible = await otherApi("GET", `/payments/report/${own._id}`);
  const missing = await details(new ctx.mongoose.Types.ObjectId());
  assert.equal(inaccessible.status, 403);
  assert.equal(missing.status, 404);
  const foreign = { ...own, _id: new ctx.mongoose.Types.ObjectId(), company: new ctx.mongoose.Types.ObjectId() };
  await PaymentHistory.collection.insertOne(foreign);
  const crossCompany = await details(foreign._id);
  assert.equal(crossCompany.status, 404);
  assert.equal(crossCompany.json.message, missing.json.message);
  assert.equal((await client(ctx.base)("GET", `/payments/report/${own._id}`)).status, 401);
  assert.equal((await details("invalid-id")).status, 400);
  assert.equal((await details(own._id, `?company=${own.company}`)).status, 400);
});

test("detail and list projections exclude private snapshot fields and actor credentials", async () => {
  const data = (await details(own._id)).json.data;
  const payload = JSON.stringify(data);
  for (const secret of ["private-identity-value", "private-bank-value", "private-provider-value", "private-token-value", "password", "refreshToken", "lastLoginIP", "permissions"]) assert.equal(payload.includes(secret), false, secret);
  assert.deepEqual(Object.keys(data.audit.createdBy).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(data.collection.history[0].collector).sort(), ["id", "name"]);
  const list = await api("GET", "/payments/report");
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(list.json).includes("private-identity-value"), false);
  assert.equal(JSON.stringify(list.json).includes("private-bank-value"), false);
  assert.equal(JSON.stringify(list.json).includes("private-token-value"), false);
});

test("viewing or retrying details never mutates the payment; no edit endpoint is added", async () => {
  await details(own._id);
  await details(own._id);
  assert.equal((await api("PATCH", `/payments/report/${own._id}`, { amount: 1 })).status, 404);
  assert.deepEqual(await PaymentHistory.collection.findOne({ _id: own._id }), original);
});
