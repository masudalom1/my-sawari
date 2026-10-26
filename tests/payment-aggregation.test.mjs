import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";
import { paymentReportRow, summarizePayments } from "../shared/paymentReporting.mjs";

let ctx, api, token, owner, PaymentHistory, User, source, parsePaymentReport, buildPaymentReportPipeline, stages;
before(async () => {
  ctx = await startTestApp();
  const login = await createUserAndLogin(ctx.base, { role: "ADMIN" });
  token = login.token;
  owner = new ctx.mongoose.Types.ObjectId(login.user.id);
  process.env.PAYMENTS_REPORT_COMPANY_ID = String(owner);
  api = client(ctx.base, token);
  PaymentHistory = (await import("../src/models/paymentHistory.model.js")).default;
  User = (await import("../src/models/user.model.js")).default;
  ({ parsePaymentReport, buildPaymentReportPipeline } = await import("../src/services/paymentReport.service.js"));
  stages = (await import("../src/services/paymentReport.pipeline.js")).paymentClassificationStages;
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const item = (extra = {}) => ({ _id: oid(), company: owner, createdBy: owner, bookingId: oid(), createdAt: new Date("2026-10-25T12:00:00Z"), customer: { fullName: "Fixture", mobileNumber: "+91 98765 43210" }, amount: 1000, type: "booking", paymentMethod: "cash", collectedAmount: 0, collectedPhonePe: 0, isCollected: false, ...extra });
  const moneyCases = [0, 0.1 + 0.2, 1.001, 1000, "1000.00", " 1000 ", "", "1e3", "1,000", -1, null, true, NaN, Infinity, ctx.mongoose.Types.Decimal128.fromString("1000.00")];
  const methods = ["cash", "phonepe", "mixed", "mix", "gpay", "razorpay", "phone_pe", " UPI ", null];
  const allocations = [undefined, {}, { cash: 1000 }, { phonePe: 1000 }, { cash: 400, phonePe: 600 }, { gpay: 1000 }, { CASH: "400", phone_pe: "600", razorpay: "0" }, { cash: -1 }, { cash: null }, { phonePe: 500, phonepe: 500 }, { cash: 1000, unknown: 1 }, { cash: 1000, unknown: null }, [], new Date("2026-01-01")];
  const cases = [
    ...moneyCases.map((amount) => item({ amount })),
    ...allocations.map((paymentBreakdown) => item({ paymentBreakdown, paymentMethod: "mixed" })),
    ...Array.from({ length: 180 }, (_, index) => item({
      paymentMethod: methods[index % methods.length], paymentBreakdown: allocations[(index * 3) % allocations.length],
      amount: moneyCases[(index * 7) % moneyCases.length], type: ["booking", "refund", "unknown", "extension"][index % 4],
      collectedAmount: [0, 400, 1000, null, "400", -1][index % 6], collectedPhonePe: [0, 600, 1000, null, "600"][index % 5], isCollected: [true, false, "false", "", 0, null, NaN][index % 7],
    })),
    item({ paymentMethod: "mixed", paymentBreakdown: { cash: 400, phonePe: 600 }, collectedAmount: 400, collectedPhonePe: 100, isCollected: true }),
    item({ paymentMethod: "phonepe", paymentBreakdown: { phonePe: 1000 }, collectedAmount: 250, collectedPhonePe: 250 }),
    item({ paymentMethod: "phonepe", paymentBreakdown: { phonePe: 1000 }, collectedAmount: 1000, collectedPhonePe: 1000, isCollected: true }),
    item({ paymentMethod: "\ufeffPHONE_PE\u00a0", paymentBreakdown: { cash: "0", phonePe: "1000" } }),
    item({ amount: 1, paymentMethod: "mixed", paymentBreakdown: { cash: 0.1, gpay: 0.2, phonePe: 0.3, razorpay: 0.4 } }),
    item({ amount: 1, paymentMethod: "mixed", paymentBreakdown: { cash: 0.4, phonePe: 0.4 } }),
    item({ amount: 1, paymentMethod: "mixed", paymentBreakdown: { cash: 0.6, phonePe: 0.6 } }),
    item({ amount: 10.25, paymentMethod: "Google Pay", paymentBreakdown: { cash: null, gpay: null, phonePe: null } }),
  ];
  await PaymentHistory.collection.insertMany(cases);
  source = await PaymentHistory.collection.find({ company: owner }).toArray();
});
after(async () => { await ctx?.stop(); });

test("native Mongo expressions match the established classifier on diverse legacy records", async () => {
  const rows = await PaymentHistory.aggregate([{ $match: { company: owner } }, ...stages(), { $project: { _pr: 1 } }]);
  const byId = new Map(rows.map((row) => [String(row._id), row._pr]));
  for (const payment of source) {
    const expected = paymentReportRow(payment);
    const actual = byId.get(String(payment._id));
    const description = `record ${payment._id}: ${String(payment.paymentMethod)} / ${String(payment.amount)}`;
    assert.equal(actual.method, expected.method, description);
    assert.equal(actual.amount, expected.amountPaise, description);
    assert.deepEqual(actual.channels, expected.channels, description);
    assert.equal(actual.allocated, expected.allocatedPaise, description);
    assert.equal(actual.difference, expected.differencePaise, description);
    assert.equal(actual.allocation, expected.allocationValid, description);
    assert.equal(actual.pending, expected.pendingPaise, description);
    assert.equal(actual.collection, expected.collection, description);
    assert.equal(actual.anomaly, expected.reviewReasons.length > 0 || !expected.allocationValid || (!expected.receipt && !expected.refund), description);
  }
});

test("database summary is complete and identical to the shared accounting rules for each filter", async () => {
  for (const query of [{}, { method: "mixed" }, { method: "gpay" }, { collectionStatus: "collected" }, { collectionStatus: "partial" }, { collectionStatus: "pending" }]) {
    const response = await api("GET", `/payments/report/summary?${new URLSearchParams({ ...query, page: "20", limit: "10" })}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const rows = source.map(paymentReportRow).filter((row) => (!query.method || row.method === query.method) && (!query.collectionStatus || row.collection === ({ collected: "settled", partial: "partial", pending: "pending" })[query.collectionStatus]));
    assert.deepEqual(response.json.summary, summarizePayments(rows));
    assert.equal(response.json.totalMatchingRecords, rows.length);
    assert.equal(Object.hasOwn(response.json, "data"), false);
  }
});

test("new and legacy query names return the same list, total, and summary", async () => {
  const canonical = await api("GET", "/payments/report?period=custom&dateBasis=createdAt&startDate=2026-10-25&endDate=2026-10-25&collectionStatus=pending&limit=10");
  const legacy = await api("GET", "/payments/report?basis=created&from=2026-10-25&to=2026-10-25&collection=pending&limit=10");
  assert.equal(canonical.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(canonical.json.data, legacy.json.data);
  assert.deepEqual(canonical.json.summary, legacy.json.summary);
  assert.deepEqual(canonical.json.pagination, legacy.json.pagination);
});

test("period parsing uses IST including midnight, Monday weeks and leap months", () => {
  const user = { _id: owner };
  const now = new Date("2026-12-31T18:30:00Z");
  const today = parsePaymentReport({ period: "today", dateBasis: "paymentDate" }, user, now);
  assert.equal(today.from, "2027-01-01");
  assert.equal(today.match.createdAt.$gte.toISOString(), "2026-12-31T18:30:00.000Z");
  assert.equal(today.match.createdAt.$lt.toISOString(), "2027-01-01T18:30:00.000Z");
  assert.equal(parsePaymentReport({ period: "yesterday" }, user, now).from, "2026-12-31");
  const week = parsePaymentReport({ period: "week" }, user, now);
  assert.deepEqual([week.from, week.to], ["2026-12-28", "2027-01-03"]);
  assert.equal(parsePaymentReport({ period: "month" }, user, new Date("2024-02-10T12:00:00Z")).to, "2024-02-29");
});

test("malformed, ambiguous, polluted and unsupported queries return 400", async () => {
  for (const query of [
    "dateBasis=invalid", "dateBasis=payment", "dateBasis=collectedDate", "collectionStatus=settled", "period=invalid", "period=all&startDate=2026-10-25", "period=", "period=custom", "period=custom&startDate=2026-10-25", "startDate=2026-02-30", "startDate=", "dateBasis=createdAt&basis=payment", "startDate=2026-10-25&from=2026-10-24", "collectionStatus=collected&collection=pending", "limit=10&limit=100", "search=a&search=b", "method%5B%24ne%5D=cash", "companyId=123", "tenant=123", "timezone=UTC", "search=%00", `search=${"a".repeat(121)}`, "page=NaN", "limit=25.5", "method=",
  ]) assert.equal((await api("GET", `/payments/report?${query}`)).status, 400, query);
  assert.throws(() => parsePaymentReport({ method: ["cash", "phonepe"] }, { _id: owner }), /Invalid method/);
  assert.throws(() => parsePaymentReport({ period: "today", startDate: "2000-01-01" }, { _id: owner }), /conflict/);
});

test("static report routes and conventional detail aliases do not conflict", async () => {
  const id = String(source[0]._id);
  const a = await api("GET", `/payments/report/${id}`);
  const b = await api("GET", `/payments/${id}`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.data, b.json.data);
  assert.equal((await api("GET", "/payments/report/summary")).status, 200);
  assert.equal((await api("GET", "/payments/pending")).status, 200);
  for (const path of ["/payments/report", "/payments/report/summary", "/payments/report/export", `/payments/${id}`]) assert.equal((await client(ctx.base)("GET", path)).status, 401);
});

test("user company fields cannot override the configured reporting company", async () => {
  const company = new ctx.mongoose.Types.ObjectId();
  const record = { ...source[0], _id: new ctx.mongoose.Types.ObjectId(), company, amount: 12345, paymentMethod: "cash", paymentBreakdown: {}, note: "company membership fixture" };
  await PaymentHistory.collection.insertOne(record);
  try {
    await User.collection.updateOne({ _id: owner }, { $set: { company } });
    const report = await api("GET", "/payments/report");
    assert.equal(report.status, 200);
    assert.equal(report.json.pagination.total, source.length);
    assert.equal(report.json.data.some((row) => row._id === String(record._id)), false);
    assert.equal((await api("GET", `/payments/${source[0]._id}`)).status, 200);
    assert.equal((await api("GET", "/payments/report/summary")).json.totalMatchingRecords, source.length);
    await User.collection.updateOne({ _id: owner }, { $set: { company: "" } });
    assert.equal((await api("GET", "/payments/report")).status, 200);
  } finally {
    await User.collection.updateOne({ _id: owner }, { $unset: { company: 1 } });
    await PaymentHistory.collection.deleteOne({ _id: record._id });
  }
});

test("company/date/id index can serve the actual aggregation's ordered root scan", async () => {
  await PaymentHistory.collection.createIndex({ company: 1, createdAt: -1, _id: -1 });
  const params = parsePaymentReport({ startDate: "2026-10-25", endDate: "2026-10-25" }, { _id: owner });
  const plan = await PaymentHistory.aggregate(buildPaymentReportPipeline(params)).explain("queryPlanner");
  const cursorPlan = plan.stages?.find((stage) => stage.$cursor)?.$cursor?.queryPlanner || plan.queryPlanner;
  assert.ok(cursorPlan, "aggregation exposes its root query plan");
  assert.match(JSON.stringify(cursorPlan.winningPlan), /company_1_createdAt_-1__id_-1/);
});


test("All has no date condition and IST periods use exclusive next-day or next-month starts", () => {
  const user = { _id: owner };
  const now = new Date("2026-08-16T12:00:51.349Z");
  assert.equal(Object.hasOwn(parsePaymentReport({ period: "all" }, user, now).match, "createdAt"), false);
  const cases = [
    [{ period: "today" }, "2026-08-15T18:30:00.000Z", "2026-08-16T18:30:00.000Z"],
    [{ period: "month" }, "2026-07-31T18:30:00.000Z", "2026-08-31T18:30:00.000Z"],
    [{ period: "custom", from: "2026-08-16", to: "2026-08-16" }, "2026-08-15T18:30:00.000Z", "2026-08-16T18:30:00.000Z"],
  ];
  for (const [query, start, end] of cases) {
    const bounds = parsePaymentReport(query, user, now).match.createdAt;
    assert.equal(bounds.$gte.toISOString(), start);
    assert.equal(bounds.$lt.toISOString(), end);
    assert.ok(now >= bounds.$gte && now < bounds.$lt);
  }
  const feb = parsePaymentReport({ period: "month" }, user, new Date("2024-02-20T00:00:00Z")).match.createdAt;
  assert.equal(feb.$lt.toISOString(), "2024-02-29T18:30:00.000Z");
});
