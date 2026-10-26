import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";
import { paymentReportRow, summarizePayments } from "../../shared/paymentReporting.mjs";

let ctx, api, token, owner, otherApi, otherToken, fixtures, PaymentHistory;
before(async () => {
  ctx = await startTestApp();
  const login = await createUserAndLogin(ctx.base);
  token = login.token;
  owner = new ctx.mongoose.Types.ObjectId(login.user.id);
  process.env.PAYMENTS_REPORT_COMPANY_ID = String(owner);
  api = client(ctx.base, token);
  const other = await createUserAndLogin(ctx.base, { role: "SALES_EXECUTIVE" });
  otherToken = other.token;
  otherApi = client(ctx.base, other.token);
  PaymentHistory = (await import("../src/models/paymentHistory.model.js")).default;
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const base = { company: owner, bookingId: oid(), createdBy: owner, type: "booking", paymentMethod: "cash", collectedAmount: 0, collectedPhonePe: 0, isCollected: false, customer: { fullName: "Asha", mobileNumber: "+91 98765 43210" }, vehicle: { vehicleName: "Swift", vehicleNumber: "KA01AB1234" }, createdAt: new Date("2026-10-25T06:00:00Z") };
  const item = (extra) => ({ ...base, _id: oid(), amount: 1000, ...extra });
  fixtures = [
    ...Array.from({ length: 123 }, (_, index) => item({ amount: (index % 7) + 100, note: `bulk-${index}` })),
    item({ amount: 2500, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 1500 }, note: "mixed-fixture" }),
    item({ amount: "2500", paymentMethod: "mix", paymentBreakdown: { cash: "1000", phonePe: "1500" }, note: "legacy-mix" }),
    item({ amount: 1000, paymentMethod: "phonepe", collectedAmount: 250, collectedPhonePe: 250, note: "phonepe-partial" }),
    item({ amount: 1000, collectedAmount: 600, note: "event-fixture", collectionHistory: [
      { channel: "cash", amount: 200, collectedBy: owner, collectedAt: new Date("2026-10-24T12:00:00Z") },
      { channel: "cash", amount: 400, collectedBy: owner, collectedAt: new Date("2026-10-25T12:00:00Z") },
    ], lastCollectedAt: new Date("2026-10-25T12:00:00Z") }),
    item({ amount: 200, type: "refund", note: "refund-fixture" }),
    item({ amount: 200, collectedAmount: 200, isCollected: true, lastCollectedAt: new Date("2026-10-25T12:00:00Z"), note: "legacy-no-events", createdBy: oid() }),
    item({ amount: 300, paymentMethod: "GPay", paymentBreakdown: { gpay: 300 }, note: "gpay-fixture", transactionId: "TXN-ABC" }),
    item({ amount: 10, note: "boundary-before", createdAt: new Date("2026-10-24T18:29:59.999Z") }),
    item({ amount: 20, note: "boundary-start", createdAt: new Date("2026-10-24T18:30:00Z") }),
    item({ amount: 30, note: "boundary-end", createdAt: new Date("2026-10-25T18:29:59.999Z") }),
    item({ amount: 40, note: "boundary-after", createdAt: new Date("2026-10-25T18:30:00Z") }),
  ];
  await PaymentHistory.collection.insertMany([...fixtures, item({ company: oid(), amount: 999999, note: "bulk-other-company" })]);
});
after(async () => { await ctx?.stop(); });

async function report(params = {}) {
  const response = await api("GET", `/payments/report?${new URLSearchParams(params)}`);
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json;
}

test("server pages return only the requested records with matching global totals", async () => {
  for (const limit of [10, 25, 50, 100]) {
    const result = await report({ search: "bulk-", limit: String(limit) });
    assert.equal(result.data.length, limit);
    assert.equal(result.pagination.total, 123);
    assert.equal(result.pagination.totalPages, Math.ceil(123 / limit));
    const expected = summarizePayments(fixtures.filter((row) => row.note.startsWith("bulk-")).map(paymentReportRow));
    assert.deepEqual(result.summary, expected);
    assert.equal(result.data[0].createdBy.fullName.startsWith("Test User"), true);
    assert.match(result.data[0]._id, /^[a-f0-9]{24}$/);
  }
  const last = await report({ search: "bulk-", limit: "100", page: "2" });
  assert.equal(last.data.length, 23);
  assert.equal(last.pagination.hasMore, false);
});

test("newest and oldest use deterministic ID ties without duplicate page records", async () => {
  const expected = fixtures.filter((row) => row.note.startsWith("bulk-")).map((row) => String(row._id)).sort();
  const first = await report({ search: "bulk-", limit: "10", sort: "newest" });
  const second = await report({ search: "bulk-", limit: "10", sort: "newest", page: "2" });
  assert.deepEqual([...first.data, ...second.data].map((row) => row._id), [...expected].reverse().slice(0, 20));
  const oldest = await report({ search: "bulk-", limit: "10", sort: "oldest", basis: "created" });
  assert.deepEqual(oldest.data.map((row) => row._id), expected.slice(0, 10));
});

test("amount sorts are numeric and retain deterministic ties", async () => {
  for (const [sort, direction] of [["highest", -1], ["lowest", 1]]) {
    const result = await report({ search: "bulk-", limit: "100", sort });
    const expected = fixtures.filter((row) => row.note.startsWith("bulk-")).sort((a, b) => direction * (a.amount - b.amount) || String(b._id).localeCompare(String(a._id))).slice(0, 100);
    assert.deepEqual(result.data.map((row) => row._id), expected.map((row) => String(row._id)));
  }
  assert.equal((await report({ search: "legacy-mix", sort: "highest" })).data[0].amountPaise, 250000);
});

test("mixed filters and summary count one receipt and attribute each channel once", async () => {
  const result = await report({ method: "mixed" });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.summary.total, 5000);
  assert.equal(result.summary.cash, 2000);
  assert.equal(result.summary.phonepe, 3000);
  assert.equal(result.summary.mixedCount, 2);
  assert.equal((await report({ method: "gpay" })).summary.gpay, 300);
});

test("settled amounts and event dates never use a full payment at lastCollectedAt", async () => {
  const events = (await report({ search: "event-fixture" })).data[0];
  assert.equal(events.collectedPaise, 60000);
  assert.equal(events.collectionDates.length, 2);
  const phonepe = (await report({ search: "phonepe-partial" })).data[0];
  assert.equal(phonepe.collectedPaise, 25000);
  const legacy = (await report({ search: "legacy-no-events" })).data[0];
  assert.deepEqual(legacy.collectionDates, []);
  assert.equal(legacy.collectedPaise, 20000);
  assert.equal(legacy.createdBy, null);
  assert.equal((await report({ search: "gpay-fixture" })).data[0].collectedPaise, null);
});

test("date and search filters run on the server with IST boundaries and escaped text", async () => {
  const result = await report({ search: "boundary-", from: "2026-10-25", to: "2026-10-25" });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.summary.total, 50);
  assert.equal((await report({ search: "9876543210" })).pagination.total, fixtures.length);
  assert.equal((await report({ search: "TXN-ABC" })).pagination.total, 1);
  assert.equal((await report({ search: String(fixtures[0].bookingId) })).pagination.total, fixtures.length);
  assert.equal((await report({ search: "[.*" })).pagination.total, 0);
});

test("invalid parameters and unauthorized company selection fail closed", async () => {
  assert.equal((await client(ctx.base)("GET", "/payments/report")).status, 401);
  for (const query of ["limit=500", "page=0", "page=1.5", "sort=__proto__", "basis=collected", "from=2026-02-30", "from=2026-10-26&to=2026-10-25", "company=123", "collection=invalid"]) assert.equal((await api("GET", `/payments/report?${query}`)).status, 400, query);
  const other = await otherApi("GET", "/payments/report");
  assert.equal(other.status, 403);
  const empty = await report({ search: "no match", page: "10" });
  assert.equal(empty.pagination.total, 0);
  assert.deepEqual(empty.data, []);
});

test("export streams the same complete filtered scope regardless of page size", async () => {
  const response = await fetch(`${ctx.base}/payments/report/export?search=bulk-&limit=10&page=2`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/csv/);
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="SAWARI_Payments_\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const csv = await response.text();
  assert.equal(csv.trim().split("\r\n").length, 124);
  assert.equal(csv.includes("bulk-other-company"), false);
});

test("export shares method, collection, date, search and stable sorting with the full report", async () => {
  const params = { method: "cash", collectionStatus: "pending", dateBasis: "createdAt", period: "custom", startDate: "2026-10-25", endDate: "2026-10-25", search: "bulk-", sort: "highest" };
  const expected = await report({ ...params, limit: "100" });
  const remaining = await report({ ...params, limit: "100", page: "2" });
  const response = await fetch(`${ctx.base}/payments/report/export?${new URLSearchParams({ ...params, limit: "10", page: "999" })}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const records = (await response.text()).trim().split("\r\n").slice(1);
  assert.deepEqual(records.map((line) => line.match(/^"([a-f\d]{24})",/)[1]), [...expected.data, ...remaining.data].map((row) => row._id));
});

test("export includes table collection fields and safe breakdowns without exposing nested private data", async () => {
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const id = oid();
  await PaymentHistory.collection.insertOne({
    _id: id, company: owner, bookingId: oid(), createdBy: owner, type: "booking", amount: 2500.25,
    paymentMethod: "mixed", paymentBreakdown: { cash: 1000.25, phonePe: 1500 },
    collectedAmount: 1000.25, collectedPhonePe: 0, isCollected: true, transactionId: "TXN-EXPORT",
    customer: { fullName: '=HYPERLINK("bad")', mobileNumber: "+919876543210", identityDocument: "PRIVATE-CUSTOMER" },
    vehicle: { vehicleName: "Swift", vehicleNumber: "KA01AB1234", bankAccount: "PRIVATE-BANK" },
    collectionHistory: [{ channel: "cash", amount: 1000.25, collectedBy: owner, collectedAt: new Date("2026-10-24T18:30:00Z"), privateToken: "PRIVATE-EVENT" }],
    createdAt: new Date("2026-10-24T18:30:00Z"), secret: "PRIVATE-TOPLEVEL",
  });
  const original = await PaymentHistory.collection.findOne({ _id: id });
  const response = await fetch(`${ctx.base}/payments/report/export?search=${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.equal(csv.trim().split("\r\n").length, 2);
  for (const column of ["Booking ID", "Payment Date (IST)", "Created Date (IST)", "Collected Amount (INR)", "Collected Dates (IST)", "Payment Breakdown (INR)", "Transaction ID"]) assert.ok(csv.includes(`"${column}"`));
  assert.ok(csv.includes('"Cash 1000.25 + PhonePe 1500.00"'));
  assert.ok(csv.includes('"Partially Collected"'));
  assert.ok(csv.includes('"TXN-EXPORT"'));
  assert.ok(csv.includes('"2500.25"'));
  assert.match(csv, /25 Oct 2026/);
  assert.match(csv, /'=HYPERLINK\(""bad""\)/);
  for (const secret of ["PRIVATE-CUSTOMER", "PRIVATE-BANK", "PRIVATE-EVENT", "PRIVATE-TOPLEVEL", "password", "refreshToken"]) assert.equal(csv.includes(secret), false);
  assert.deepEqual(await PaymentHistory.collection.findOne({ _id: id }), original);
  const foreign = await fetch(`${ctx.base}/payments/report/export?search=${id}`, { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(foreign.status, 403);
  const rejected = await api("GET", `/payments/report/export?company=${owner}`);
  assert.equal(rejected.status, 400);
});


test("the requested 16 August mixed payment is one row and one CSV record for booking and handover", async () => {
  const { allocateRevenuePayment } = await import("../src/services/paymentAllocation.service.js");
  const oid = () => new ctx.mongoose.Types.ObjectId();
  for (const type of ["booking", "handover"]) {
    const payment = { _id: oid(), company: owner, bookingId: oid(), createdBy: owner,
      amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 300, razorpay: 0 },
      type, createdAt: new Date("2026-08-16T12:00:51.349Z"),
      customPaymentDate: new Date("2000-01-01"), collectedAmount: 0, collectedPhonePe: 0, isCollected: false };
    await PaymentHistory.collection.insertOne(payment);
    const original = await PaymentHistory.collection.findOne({ _id: payment._id });
    const query = { period: "custom", dateBasis: "createdAt", startDate: "2026-08-16", endDate: "2026-08-16", search: String(payment._id) };
    const result = await report(query);
    assert.equal(result.data.length, 1);
    assert.equal(result.pagination.total, 1);
    assert.equal(result.summary.count, 1);
    assert.deepEqual([result.summary.cash, result.summary.gpay, result.summary.phonepe, result.summary.razorpay, result.summary.total], [1000, 0, 300, 0, 1300]);
    assert.equal(result.summary.unreconciledCount, 0);
    assert.equal(result.summary.allocatedTotal, 1300);
    assert.deepEqual(result.data[0].channels, { cash: 100000, gpay: 0, phonepe: 30000, razorpay: 0 });
    assert.deepEqual(allocateRevenuePayment(payment), { cash: 1000, phonepe: 300, razorpay: 0, unspecified: 0 });
    const response = await fetch(`${ctx.base}/payments/report/export?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const csv = await response.text();
    assert.equal(csv.trim().split("\r\n").length, 2);
    assert.ok(csv.includes('"Cash 1000.00 + PhonePe 300.00"'));
    assert.ok(csv.includes('"1300.00"'));
    assert.equal((await report({ ...query, startDate: "2026-08-17", endDate: "2026-08-17" })).pagination.total, 0);
    assert.deepEqual(await PaymentHistory.collection.findOne({ _id: payment._id }), original);
  }
});

test("refunds remain labeled table/CSV records but never enter positive channel totals or review flags", async () => {
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const base = { company: owner, bookingId: oid(), createdBy: owner, note: "refund-channel-regression", createdAt: new Date("2026-08-16T12:00:51.349Z") };
  const records = [
    { ...base, _id: oid(), type: "handover", amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 300 } },
    { ...base, _id: oid(), type: "refund", amount: 200, paymentMethod: "mixed", paymentBreakdown: { cash: 100, phonePe: 100 } },
    { ...base, _id: oid(), type: "refund", amount: 300, paymentMethod: "cash", paymentBreakdown: { cash: "invalid" } },
  ];
  await PaymentHistory.collection.insertMany(records);
  const original = await PaymentHistory.collection.find({ note: base.note }).toArray();
  const query = { period: "custom", startDate: "2026-08-16", endDate: "2026-08-16", search: base.note };
  const result = await report(query);
  assert.equal(result.pagination.total, 3);
  assert.equal(result.data.length, 3);
  assert.equal(result.summary.total, 1800);
  assert.equal(result.summary.refundCount, 2);
  assert.deepEqual(result.data.filter((row) => row.refund).map((row) => row.collection), ["refund", "refund"]);
  const chart = result.summary.channelSummary;
  assert.deepEqual([chart.total, chart.cash, chart.phonepe, chart.gpay, chart.razorpay], [1300, 1000, 300, 0, 0]);
  assert.equal(chart.count, 1);
  assert.equal(chart.anomalyCount, 0);
  assert.equal(chart.unreconciledCount, 0);
  const response = await fetch(`${ctx.base}/payments/report/export?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.equal(csv.trim().split("\r\n").length, 4);
  assert.equal((csv.match(/"Refund"/g) || []).length, 2);
  const refundsOnly = await report({ ...query, collection: "refund" });
  assert.equal(refundsOnly.pagination.total, 2);
  assert.equal(refundsOnly.summary.channelSummary.total, 0);
  assert.equal(refundsOnly.summary.channelSummary.anomalyCount, 0);
  assert.deepEqual(await PaymentHistory.collection.find({ note: base.note }).toArray(), original);
});

test("missing, null, dangling and deleted vehicles never remove authorized payments from table, chart or CSV", async () => {
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const Vehicle = (await import("../src/models/vehicle.model.js")).default;
  const deletedId = oid();
  await Vehicle.collection.insertOne({ _id: deletedId, isDeleted: true, vehicleName: "Deleted test vehicle" });
  const deletedBefore = await Vehicle.collection.findOne({ _id: deletedId });
  const base = { company: owner, bookingId: oid(), createdBy: owner, type: "handover", paymentMethod: "cash", note: "vehicle-preservation-regression", createdAt: new Date("2026-08-16T12:00:51.349Z") };
  const records = [
    { ...base, _id: oid(), amount: 100 },
    { ...base, _id: oid(), amount: 200, vehicle: null },
    { ...base, _id: oid(), amount: 300, vehicle: { vehicleName: "Snapshot without ID" } },
    { ...base, _id: oid(), amount: 400, vehicle: { vehicleId: oid(), vehicleName: "Dangling snapshot" } },
    { ...base, _id: oid(), amount: 500, vehicle: { vehicleId: deletedId, vehicleName: "Deleted snapshot" } },
    { ...base, _id: oid(), amount: 50, type: "refund", vehicle: { vehicleId: deletedId } },
  ];
  await PaymentHistory.collection.insertMany([...records, { ...base, _id: oid(), amount: 9999, company: oid() }]);
  const before = await PaymentHistory.collection.find({ note: base.note }).toArray();
  const query = { period: "custom", startDate: "2026-08-16", endDate: "2026-08-16", search: base.note, limit: "10" };
  const result = await report(query);
  assert.equal(result.pagination.total, 6);
  assert.deepEqual(new Set(result.data.map((row) => row._id)), new Set(records.map((row) => String(row._id))));
  assert.equal(result.summary.total, 1550);
  assert.equal(result.summary.channelSummary.total, 1500);
  assert.equal(result.summary.channelSummary.cash, 1500);
  assert.equal(result.summary.channelSummary.count, 5);
  const detail = await api("GET", `/payments/report/${records[0]._id}`);
  assert.equal(detail.status, 200);
  const response = await fetch(`${ctx.base}/payments/report/export?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.equal(csv.trim().split("\r\n").length, 7);
  for (const row of records) assert.ok(csv.includes(String(row._id)));
  assert.deepEqual(await PaymentHistory.collection.find({ note: base.note }).toArray(), before);
  assert.deepEqual(await Vehicle.collection.findOne({ _id: deletedId }), deletedBefore);
});

test("handover breakdown, legacy gaps and display dates stay read-only in the createdAt scope", async () => {
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const base = { company: owner, bookingId: oid(), createdBy: owner, note: "simplified-report-regression", isCollected: false, createdAt: new Date("2026-08-16T12:00:51.349Z"), updatedAt: new Date("2026-10-25T12:00:00Z") };
  const records = [
    { ...base, _id: oid(), type: "handover", amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 300 }, customPaymentDate: new Date("2026-08-10T12:00:00Z") },
    { ...base, _id: oid(), type: "booking", amount: 200, paymentMethod: "cash" },
    { ...base, _id: oid(), amount: 100, paymentMethod: "mixed" },
  ];
  await PaymentHistory.collection.insertMany(records);
  const before = await PaymentHistory.collection.find({ note: base.note }).toArray();
  const result = await report({ search: base.note, from: "2026-08-16", to: "2026-08-16", basis: "created" });
  assert.equal(result.data.length, 3);
  assert.deepEqual([result.summary.total, result.summary.cash, result.summary.phonepe, result.summary.gpay, result.summary.razorpay], [1600, 1200, 300, 0, 0]);
  const mixed = result.data.find((row) => row.type === "handover");
  assert.equal(new Date(mixed.effectivePaymentDate).toISOString(), records[0].customPaymentDate.toISOString());
  assert.equal((await report({ search: base.note, from: "2026-10-25", to: "2026-10-25" })).pagination.total, 0);
  const detail = await api("GET", `/payments/report/${mixed._id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.payment.paymentDate, records[0].customPaymentDate.toISOString());
  assert.deepEqual(await PaymentHistory.collection.find({ note: base.note }).toArray(), before);
});


test("All, Today, Month and Custom keep table, chart count, search and CSV in the same read-only scope", async () => {
  const { parsePaymentReport } = await import("../src/services/paymentReport.service.js");
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const now = new Date();
  const marker = "four-period-regression";
  const base = { company: owner, bookingId: oid(), createdBy: owner, type: "handover", amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 300 }, transactionId: marker, note: marker, isCollected: false, customPaymentDate: new Date("2000-01-01"), updatedAt: now };
  const bounds = parsePaymentReport({ period: "month" }, { _id: owner }, now).match.createdAt;
  const todayBounds = parsePaymentReport({ period: "today" }, { _id: owner }, now).match.createdAt;
  const records = [undefined, new Date("2000-01-01"), new Date("2026-08-16T12:00:51.349Z"), now,
    new Date(bounds.$gte.getTime() - 1), bounds.$gte, new Date(bounds.$lt.getTime() - 1), bounds.$lt,
    new Date(todayBounds.$gte.getTime() - 1), todayBounds.$gte, new Date(todayBounds.$lt.getTime() - 1), todayBounds.$lt,
  ].map((createdAt) => ({ ...base, _id: oid(), ...(createdAt ? { createdAt } : {}) }));
  await PaymentHistory.collection.insertMany(records);
  const before = await PaymentHistory.collection.find({ transactionId: marker }).toArray();
  for (const dateQuery of [{ period: "all" }, { period: "today" }, { period: "month" }, { period: "custom", from: "2026-08-16", to: "2026-08-16" }]) {
    const query = { ...dateQuery, search: marker, limit: "25" };
    const params = parsePaymentReport(query, { _id: owner }, now);
    const range = params.match.createdAt;
    const expected = records.filter((row) => !range || (row.createdAt && row.createdAt >= range.$gte && row.createdAt < range.$lt));
    const result = await report(query);
    assert.equal(result.pagination.total, expected.length);
    assert.equal(result.summary.count, expected.length);
    assert.deepEqual([result.summary.total, result.summary.cash, result.summary.phonepe, result.summary.gpay, result.summary.razorpay], [1300 * expected.length, 1000 * expected.length, 300 * expected.length, 0, 0]);
    assert.deepEqual(new Set(result.data.map((row) => row._id)), new Set(expected.map((row) => String(row._id))));
    const response = await fetch(`${ctx.base}/payments/report/export?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const csv = await response.text();
    for (const row of records) assert.equal(csv.includes(String(row._id)), expected.includes(row));
    assert.equal((await report({ ...query, search: "absent-four-period-record" })).pagination.total, 0);
  }
  assert.deepEqual(await PaymentHistory.collection.find({ transactionId: marker }).toArray(), before);
});
