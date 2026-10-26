import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/harness.mjs";
import { parsePaymentReport, buildPaymentReportPipeline, loadPaymentReport, exportPaymentReport } from "../src/services/paymentReport.service.js";
import { paymentReportRow, summarizePayments } from "../../shared/paymentReporting.mjs";

let ctx, PaymentHistory, owner, source, baseline;
const query = { period: "custom", startDate: "2026-09-01", endDate: "2026-09-30", limit: "25" };
const candidate = { company: 1, createdAt: -1, _id: -1 };
const candidateName = "company_1_createdAt_-1__id_-1";
const walk = (node, visit) => {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
};
function metrics(plan) {
  const root = plan.stages?.find((stage) => stage.$cursor)?.$cursor || plan;
  const stages = [], indexes = [];
  walk(root.queryPlanner.winningPlan, (node) => { if (node.stage) stages.push(node.stage); if (node.indexName) indexes.push(node.indexName); });
  return { documents: root.executionStats.totalDocsExamined, keys: root.executionStats.totalKeysExamined, rootMilliseconds: root.executionStats.executionTimeMillis, stages, indexes };
}
const params = (extra = {}) => parsePaymentReport({ ...query, ...extra }, { _id: owner });
const explain = (extra = {}) => PaymentHistory.aggregate(buildPaymentReportPipeline(params(extra))).allowDiskUse(true).option({ maxTimeMS: 30000 }).explain("executionStats");

before(async () => {
  ctx = await startTestApp();
  PaymentHistory = (await import("../src/models/paymentHistory.model.js")).default;
  const companies = Array.from({ length: 4 }, () => new ctx.mongoose.Types.ObjectId());
  owner = companies[0];
  process.env.PAYMENTS_REPORT_COMPANY_ID = String(owner);
  const booking = new ctx.mongoose.Types.ObjectId();
  const origin = Date.parse("2026-07-01T06:00:00Z");
  source = Array.from({ length: 12000 }, (_, index) => {
    const day = Math.floor(index / 4) % 120;
    const variant = Math.floor(index / 480) % 6;
    const method = ["cash", "phonepe", "mixed", "mix", "gpay", "razorpay"][variant];
    const amount = 300 + (index % 3) / 100;
    const mixed = method === "mixed" || method === "mix";
    const createdAt = new Date(origin + day * 86400000);
    return { _id: new ctx.mongoose.Types.ObjectId(), company: companies[index % 4], bookingId: booking, createdBy: owner,
      type: index % 17 === 0 ? "refund" : "booking", amount, paymentMethod: method, createdAt,
      paymentBreakdown: mixed ? { cash: 100 + (index % 3) / 100, phonePe: 200 } : {},
      collectedAmount: 0, collectedPhonePe: 0, isCollected: false,
      customer: { fullName: `Customer ${index}`, mobileNumber: `98765${String(index).padStart(5, "0")}` },
      vehicle: { vehicleNumber: `KA01AB${String(index % 9999).padStart(4, "0")}` },
      collectionHistory: [], note: `load-${index}`,
    };
  });
  for (let start = 0; start < source.length; start += 1000) await PaymentHistory.collection.insertMany(source.slice(start, start + 1000));
  // Relevant existing live indexes, before the proposed compound index.
  await PaymentHistory.collection.createIndex({ company: 1 });
  await PaymentHistory.collection.createIndex({ createdAt: -1 });
  baseline = metrics(await explain());
  await PaymentHistory.collection.createIndex(candidate);
});
after(async () => { await ctx?.stop(); });

test("12,000 payments: compound company/date/ID index narrows reads and removes root sorting", async () => {
  const indexed = metrics(await explain());
  assert.ok(baseline.stages.includes("SORT"));
  assert.ok(indexed.indexes.includes(candidateName));
  assert.equal(indexed.stages.includes("SORT"), false);
  assert.equal(indexed.documents, 750);
  assert.ok(baseline.documents >= indexed.documents * 4);
  console.log(JSON.stringify({ benchmark: "12000-payments-month", baseline, indexed }));
});

test("indexed filtered aggregates preserve full-scope accounting and bounded pages", async () => {
  for (const extra of [{}, { method: "mixed" }, { collectionStatus: "pending" }, { method: "gpay" }]) {
    const p = params(extra);
    const result = await loadPaymentReport(p);
    const expected = source.filter((payment) => String(payment.company) === String(owner) && payment.createdAt >= p.match.createdAt.$gte && payment.createdAt < p.match.createdAt.$lt).map(paymentReportRow).filter((row) => (p.method === "all" || row.method === p.method) && (p.collection === "all" || row.collection === p.collection));
    assert.deepEqual(result.summary, summarizePayments(expected));
    assert.equal(result.pagination.total, expected.length);
    assert.ok(result.data.length <= 25);
    assert.ok(result.data.every((row) => String(row.company) === String(owner)));
  }
});

test("oldest, mixed and literal-search root scans use the compound index; amount sort stays derived", async () => {
  for (const extra of [{ sort: "oldest" }, { method: "mixed" }, { search: "Customer 1" }, { sort: "highest" }]) {
    const plan = await explain(extra);
    const scan = metrics(plan);
    assert.ok(scan.indexes.includes(candidateName), JSON.stringify(extra));
    assert.ok(scan.documents <= 750);
    assert.equal(scan.stages.includes("SORT"), false);
    if (extra.sort === "highest") assert.ok(JSON.stringify(plan.stages?.find((stage) => stage.$facet)?.$facet.data).includes("$sort"));
    console.log(JSON.stringify({ benchmark: "indexed-variant", query: extra, ...scan }));
  }
});

test("deep pages retain totals, and export reads the complete 750-row scope in bounded chunks", async () => {
  const p = params({ page: "31" });
  const last = await loadPaymentReport(p);
  assert.equal(last.pagination.total, 750);
  assert.deepEqual(last.data, []);
  let rows = 0, chunks = 0;
  for await (const chunk of exportPaymentReport(p)) {
    const lines = chunk.trim().split("\r\n");
    if (chunks > 0) { assert.ok(lines.length <= 100); rows += lines.length; }
    chunks++;
  }
  assert.equal(rows, 750);
  assert.equal(chunks, 9);
});

test("all report commands fit Atlas's nested BSON limit without server-side JavaScript", () => {
  const depth = (node) => node && typeof node === "object" ? 1 + Math.max(0, ...Object.values(node).map(depth)) : 0;
  const command = { explain: { aggregate: "paymenthistories", pipeline: buildPaymentReportPipeline(params({ method: "mixed" })), cursor: {} }, verbosity: "executionStats" };
  assert.ok(depth(command) <= 50, `BSON depth ${depth(command)}`);
  assert.equal(JSON.stringify(command).includes('"$function"'), false);
});
