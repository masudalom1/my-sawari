import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";
import { addDayKeys, toDayKey } from "../src/utils/revenue.utils.js";

const ENDPOINT = "/dashboard/payments-history/cash";
let ctx, api, PaymentHistory, owner, cash, mixed, completed, yesterday, legacy;
const oid = () => new ctx.mongoose.Types.ObjectId();
before(async () => {
  ctx = await startTestApp();
  const { token, user } = await createUserAndLogin(ctx.base);
  owner = user._id || user.id;
  api = client(ctx.base, token);
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
  const today = toDayKey(new Date());
  const make = (extra = {}) => PaymentHistory.create({
    company: owner, bookingId: oid(), createdBy: owner, amount: 600,
    paymentMethod: "cash", type: "booking", paymentDate: `${today}T12:00:00+05:30`,
    customer: { fullName: "Cash fixture", mobileNumber: "9400100001" },
    vehicle: { vehicleName: "Cash test car", vehicleNumber: "KA01CA0001" }, ...extra,
  });
  cash = await make();
  mixed = await make({ paymentMethod: "mixed", amount: 3000, paymentBreakdown: { cash: 1000, phonePe: 2000 },
    collectedAmount: 200, collectedPhonePe: 2000, collectionHistory: [
      { channel: "cash", amount: 200, collectedBy: owner, collectedByName: "Cash collector" },
      { channel: "phonepe", amount: 2000, collectedBy: owner, collectedByName: "Digital verifier" },
    ] });
  completed = await make({ amount: 400, isCollected: true, collectedAmount: 400 });
  yesterday = await make({ amount: 150, customPaymentDate: `${addDayKeys(today, -1)}T23:59:00+05:30` });
  legacy = await make({ amount: 250, isCollected: true });
  await make({ amount: 100, paymentMethod: "gpay" });
  await make({ amount: 100, paymentMethod: "phonepe" });
  await make({ amount: 100, paymentMethod: "razorpay" });
  await make({ amount: 100, type: "refund" });
  await make({ amount: 100, paymentMethod: "mixed", paymentBreakdown: { cash: 0, phonePe: 100 } });
});
after(async () => { await ctx?.stop(); });

test("cash routes require authentication and reject invalid filters", async () => {
  assert.equal((await client(ctx.base)("GET", ENDPOINT)).status, 401);
  assert.equal((await client(ctx.base)("POST", `${ENDPOINT}/${cash._id}/collect`, { amount: 1 })).status, 401);
  assert.equal((await api("GET", `${ENDPOINT}?tab=invalid`)).status, 400);
});

test("today uses IST payment dates and returns cash only with exact full-set totals", async () => {
  const result = await api("GET", `${ENDPOINT}?tab=today&limit=1`);
  assert.equal(result.status, 200);
  assert.equal(result.json.total, 4);
  assert.equal(result.json.data.length, 1);
  assert.equal(result.json.hasMore, true);
  assert.equal(result.json.cashTotal, 2250);
  assert.deepEqual(result.json.stats.today, { count: 4, amount: 2250,
    collected: { count: 2, amount: 600 }, pending: { count: 2, amount: 1400 } });
  assert.equal(result.json.stats.pending.count, 3);
  assert.equal(result.json.stats.pending.amount, 1550);
  const previous = await api("GET", `${ENDPOINT}?tab=yesterday`);
  assert.deepEqual(previous.json.data.map((row) => row._id), [String(yesterday._id)]);
});

test("search is applied before pagination, including cash amount, customer, phone and vehicle", async () => {
  for (const search of ["Cash fixture", "9400100001", "KA01CA0001", "Cash test car"]) {
    const result = await api("GET", `${ENDPOINT}?tab=pending&search=${encodeURIComponent(search)}&limit=1`);
    assert.equal(result.json.total, 3);
  }
  const amount = await api("GET", `${ENDPOINT}?tab=pending&search=${encodeURIComponent("₹1,000")}`);
  assert.deepEqual(amount.json.data.map((row) => row._id), [String(mixed._id)]);
  const empty = await api("GET", `${ENDPOINT}?tab=pending&search=no-match`);
  assert.deepEqual(empty.json.data, []);
  assert.equal(empty.json.total, 0);
  assert.equal(empty.json.cashTotal, 0);
});

test("mixed records expose only the cash portion and cash audit history", async () => {
  const response = await api("GET", `${ENDPOINT}?tab=pending`);
  const row = response.json.data.find((payment) => payment._id === String(mixed._id));
  assert.equal(row.collectibleAmount, 1000);
  assert.equal(row.collectedAmount, 200);
  assert.equal(row.remainingAmount, 800);
  assert.equal(row.lastCollectedByName, "Cash collector");
  assert.deepEqual(row.collectionHistory.map((entry) => entry.channel), ["cash"]);
  assert.equal(row.createdBy.fullName.startsWith("Test User"), true);
  assert.equal(row.createdBy.password, undefined);
  assert.equal(row.createdBy.email, undefined);
});

test("all five views return their own complete summary and cash-only counts", async () => {
  const expected = {
    today: [4, 2250, 600, 1400, 2, 2], yesterday: [1, 150, 0, 150, 0, 1],
    pending: [3, 1750, 200, 1550, 0, 3], completed: [2, 650, 400, 0, 2, 0],
    all: [5, 2400, 600, 1550, 2, 3],
  };
  for (const [tab, [count, amount, collected, pending, collectedCount, pendingCount]] of Object.entries(expected)) {
    const response = await api("GET", `${ENDPOINT}?tab=${tab}&limit=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.summary, { count, amount,
      collected: { count: collectedCount, amount: collected }, pending: { count: pendingCount, amount: pending },
      partialCount: ["today", "pending", "all"].includes(tab) ? 1 : 0 });
    assert.equal(response.json.data.length, 1);
    assert.equal(response.json.total, count);
    assert.equal(response.json.stats.all.count, 5);
  }
});

test("date groups and totals stay complete across stable payment-date pagination", async () => {
  const before = await PaymentHistory.find().lean();
  const first = await api("GET", `${ENDPOINT}?tab=all&limit=2`);
  const second = await api("GET", `${ENDPOINT}?tab=all&limit=2&page=2`);
  const third = await api("GET", `${ENDPOINT}?tab=all&limit=2&page=3`);
  const ids = [...first.json.data, ...second.json.data, ...third.json.data].map((row) => row._id);
  assert.equal(new Set(ids).size, 5);
  assert.equal(ids.length, 5);
  assert.deepEqual(first.json.summary, second.json.summary);
  assert.equal(first.json.groups[0].count, 4, "the group counts every matching payment, not just the current page");
  assert.equal(first.json.groups[0].amount, 2250);
  assert.equal(first.json.groups[0].payments.length, 2);
  assert.equal(second.json.groups[0].date, first.json.groups[0].date);
  assert.equal(third.json.groups[0].date, toDayKey(yesterday.customPaymentDate));
  assert.deepEqual(await PaymentHistory.find().lean(), before, "viewing and grouping never modifies payment documents");
});

test("month and exact date filters use IST boundaries, leap days and the same search/status scope", async () => {
  const make = (amount, instant) => PaymentHistory.create({ company: owner, bookingId: oid(), createdBy: owner,
    type: "booking", paymentMethod: "cash", amount, paymentDate: instant,
    customer: { fullName: "Month fixture", mobileNumber: "9400556666" } });
  const fixtures = await Promise.all([
    make(10, "2024-02-01T00:00:00+05:30"),
    make(20, "2024-02-29T23:59:59+05:30"),
    make(30, "2024-03-01T00:00:00+05:30"),
  ]);
  try {
    const month = await api("GET", `${ENDPOINT}?tab=all&month=2024-02&search=Month%20fixture&limit=1`);
    assert.equal(month.status, 200);
    assert.equal(month.json.total, 2);
    assert.equal(month.json.summary.amount, 30);
    assert.equal(month.json.stats.all.count, 2);
    assert.equal(month.json.stats.pending.count, 2);
    assert.equal(month.json.groups[0].date, "2024-02-29");
    const day = await api("GET", `${ENDPOINT}?tab=pending&month=2024-02&date=2024-02-29&search=Month%20fixture`);
    assert.equal(day.json.total, 1);
    assert.equal(day.json.summary.pending.amount, 20);
    assert.equal(day.json.data[0]._id, String(fixtures[1]._id));
    const march = await api("GET", `${ENDPOINT}?tab=all&date=2024-03-01&search=Month%20fixture`);
    assert.equal(march.json.total, 1);
    assert.equal(march.json.summary.amount, 30);
    const completed = await api("GET", `${ENDPOINT}?tab=completed&month=2024-02&search=Month%20fixture`);
    assert.equal(completed.json.summary.count, 0);
    assert.equal(completed.json.summary.amount, 0);
    assert.deepEqual(completed.json.groups, []);
    for (const query of ["month=2024-13", "month=bad", "date=2023-02-29", "date=2024-02-30", "month=2024-02&date=2024-03-01"]) {
      assert.equal((await api("GET", `${ENDPOINT}?tab=all&${query}`)).status, 400);
    }
  } finally { await PaymentHistory.deleteMany({ _id: { $in: fixtures.map((row) => row._id) } }); }
});

test("25, 50, 100 and All return complete stable pages with the same filtered totals", async () => {
  const today = toDayKey(new Date());
  const inserted = await PaymentHistory.insertMany(Array.from({ length: 537 }, (_, index) => ({
    company: owner, bookingId: oid(), createdBy: owner, type: "booking", paymentMethod: "cash", amount: index + 1,
    paymentDate: `${index < 70 ? today : addDayKeys(today, -1)}T12:00:00+05:30`,
    customer: { fullName: "Pagination fixture", mobileNumber: "9400667700" },
  })));
  try {
    const url = `${ENDPOINT}?tab=all&search=Pagination%20fixture`;
    const all = await api("GET", `${url}&limit=all&page=999`);
    assert.equal(all.status, 200);
    assert.equal(all.json.data.length, 537);
    assert.equal(all.json.limit, "all");
    assert.deepEqual(all.json.pagination, { page: 1, pageSize: "all", total: 537, totalPages: 1, from: 1, to: 537, hasPrevious: false, hasNext: false });
    assert.deepEqual(all.json.groups.map((group) => group.count), [70, 467]);
    const allIds = all.json.data.map((row) => row._id);
    for (const size of [25, 50, 100]) {
      const ids = [];
      for (let page = 1; page <= Math.ceil(537 / size); page += 1) {
        const result = await api("GET", `${url}&limit=${size}&page=${page}`);
        assert.equal(result.status, 200);
        assert.equal(result.json.data.length, Math.min(size, 537 - (page - 1) * size));
        assert.equal(result.json.pagination.from, (page - 1) * size + 1);
        assert.equal(result.json.pagination.to, Math.min(537, page * size));
        assert.deepEqual(result.json.summary, all.json.summary);
        ids.push(...result.json.data.map((row) => row._id));
      }
      assert.deepEqual(ids, allIds, `page size ${size} has no omitted or duplicate records`);
    }
    const clamped = await api("GET", `${url}&limit=25&page=999`);
    assert.equal(clamped.json.page, 22);
    assert.equal(clamped.json.data.length, 12);
    assert.equal(clamped.json.pagination.from, 526);
    assert.equal(clamped.json.pagination.to, 537);
    const empty = await api("GET", `${url}&limit=all&date=2000-01-01`);
    assert.equal(empty.json.pagination.from, 0);
    assert.equal(empty.json.pagination.to, 0);
    assert.equal(empty.json.pagination.totalPages, 1);
    for (const invalid of ["limit=invalid", "limit=0", "limit=25.5", "limit=1000001", "page=0", "page=1x"]) {
      assert.equal((await api("GET", `${url}&${invalid}`)).status, 400);
    }
  } finally { await PaymentHistory.deleteMany({ _id: { $in: inserted.map((row) => row._id) } }); }
});

test("collection POST supplies the updated filtered view without needing a refresh request", async () => {
  const payment = await PaymentHistory.create({ company: owner, bookingId: oid(), createdBy: owner, type: "booking", paymentMethod: "cash", amount: 100,
    customer: { fullName: "Action view fixture" } });
  const view = { tab: "pending", search: "Action view fixture", page: "1", limit: "25" };
  try {
    const invalid = await api("POST", `${ENDPOINT}/${payment._id}/collect`, { amount: 30, view: { ...view, page: "0" } });
    assert.equal(invalid.status, 400);
    assert.equal((await PaymentHistory.findById(payment._id)).collectedAmount, 0);
    const partial = await api("POST", `${ENDPOINT}/${payment._id}/collect`, { amount: 30, expectedCollectedAmount: 0, view });
    assert.equal(partial.status, 200);
    assert.equal(partial.json.view.summary.collected.amount, 30);
    assert.equal(partial.json.view.summary.pending.amount, 70);
    assert.equal(partial.json.view.data[0].collectionHistory.length, 1);
    const full = await api("POST", `${ENDPOINT}/${payment._id}/collect`, { amount: 70, expectedCollectedAmount: 30, view });
    assert.equal(full.status, 200);
    assert.equal(full.json.view.summary.pending.amount, 0);
    assert.deepEqual(full.json.view.data, []);
    assert.equal(full.json.view.stats.pending.count, 0);
    assert.equal(full.json.view.stats.collectedTotal.count, 1);
    assert.equal((await PaymentHistory.findById(payment._id)).amount, 100);
  } finally { await PaymentHistory.deleteOne({ _id: payment._id }); }
});

test("a post-collection view read failure does not undo or misreport a successful collection", async () => {
  const payment = await PaymentHistory.create({ company: owner, bookingId: oid(), createdBy: owner, type: "booking", paymentMethod: "cash", amount: 100 });
  const originalFind = PaymentHistory.find;
  try {
    PaymentHistory.find = () => { throw new Error("Isolated view read failure"); };
    const result = await api("POST", `${ENDPOINT}/${payment._id}/collect`, { amount: 20, view: { tab: "all", limit: "25" } });
    assert.equal(result.status, 200);
    assert.equal(result.json.data.transactionAmount, 20);
    assert.equal(result.json.view, null);
    const saved = await PaymentHistory.findById(payment._id);
    assert.equal(saved.collectedAmount, 20);
    assert.equal(saved.collectionHistory.length, 1);
  } finally { PaymentHistory.find = originalFind; await PaymentHistory.deleteOne({ _id: payment._id }); }
});

test("partial and full collection update the existing record and preserve financial amounts", async () => {
  const before = await PaymentHistory.findById(cash._id).lean();
  const count = await PaymentHistory.countDocuments();
  const collect = (body) => api("POST", `${ENDPOINT}/${cash._id}/collect`, body);
  const first = await collect({ amount: 200, note: " Received at desk ", expectedCollectedAmount: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.remainingAmount, 400);
  assert.equal(first.json.data.isCollected, false);
  const refreshed = await api("GET", `${ENDPOINT}?tab=pending`);
  assert.equal(refreshed.json.summary.collected.amount, 400);
  assert.equal(refreshed.json.summary.pending.amount, 1350);
  assert.equal((await collect({ amount: 200, expectedCollectedAmount: 0 })).status, 409, "a retry cannot duplicate partial cash collection");
  const second = await collect({ amount: 400, expectedCollectedAmount: 200 });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.isCollected, true);
  const saved = await PaymentHistory.findById(cash._id).lean();
  assert.equal(saved.collectedAmount, 600);
  assert.equal(saved.collectionHistory.length, 2);
  assert.equal(saved.collectionHistory[0].note, "Received at desk");
  assert.equal(String(saved.collectionHistory[0].collectedBy), String(owner));
  assert.equal(saved.amount, before.amount);
  assert.deepEqual(saved.paymentBreakdown, before.paymentBreakdown);
  assert.equal(String(saved.bookingId), String(before.bookingId));
  assert.equal(await PaymentHistory.countDocuments(), count);
  const reopened = await api("GET", `${ENDPOINT}?tab=completed`);
  assert.ok(reopened.json.data.some((row) => row._id === String(cash._id)));
  assert.equal((await collect({ amount: 1 })).status, 409);
});

test("mixed cash collection leaves digital verification and allocation unchanged", async () => {
  const before = await PaymentHistory.findById(mixed._id).lean();
  const response = await api("POST", `${ENDPOINT}/${mixed._id}/collect`, { amount: 800, expectedCollectedAmount: 200 });
  assert.equal(response.status, 200);
  const saved = await PaymentHistory.findById(mixed._id).lean();
  assert.equal(saved.amount, 3000);
  assert.equal(saved.collectedPhonePe, 2000);
  assert.deepEqual(saved.paymentBreakdown, before.paymentBreakdown);
  assert.equal(saved.collectionHistory.length, 3);
  assert.equal(saved.collectionHistory.at(-1).channel, "cash");
});

test("cash collection rejects refunds, digital methods, invalid amounts and invalid notes", async () => {
  const digital = await PaymentHistory.findOne({ paymentMethod: "gpay" });
  const refund = await PaymentHistory.findOne({ type: "refund" });
  for (const id of [digital._id, refund._id]) assert.equal((await api("POST", `${ENDPOINT}/${id}/collect`, { amount: 1 })).status, 400);
  for (const amount of [0, -1, 151, 150.01, 1.001, true, [], "invalid"]) {
    assert.equal((await api("POST", `${ENDPOINT}/${yesterday._id}/collect`, { amount })).status, 400);
  }
  assert.equal((await api("POST", `${ENDPOINT}/${yesterday._id}/collect`, { amount: 1, note: {} })).status, 400);
  assert.equal((await api("POST", `${ENDPOINT}/invalid/collect`, { amount: 1 })).status, 400);
  assert.equal((await api("POST", `${ENDPOINT}/${oid()}/collect`, { amount: 1 })).status, 404);
});

test("concurrent collections create exactly one audit entry and do not lose the last paisa", async () => {
  const results = await Promise.all([1, 2].map(() => api("POST", `${ENDPOINT}/${yesterday._id}/collect`, { amount: 149.99, expectedCollectedAmount: 0 })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const row = (await api("GET", `${ENDPOINT}?tab=pending`)).json.data.find((payment) => payment._id === String(yesterday._id));
  assert.equal(row.remainingAmount, 0.01);
  assert.equal(row.isCollected, false);
  assert.equal((await api("POST", `${ENDPOINT}/${yesterday._id}/collect`, { amount: 0.01, expectedCollectedAmount: 149.99 })).status, 200);
  assert.equal((await PaymentHistory.findById(yesterday._id)).collectionHistory.length, 2);
});

test("legacy completed flags remain completed without inventing collection amounts", async () => {
  const row = (await api("GET", `${ENDPOINT}?tab=completed`)).json.data.find((payment) => payment._id === String(legacy._id));
  assert.equal(row.isCollected, true);
  assert.equal(row.remainingAmount, 0);
  assert.equal(row.collectedAmount, 0);
  assert.equal((await api("POST", `${ENDPOINT}/${legacy._id}/collect`, { amount: 1 })).status, 409);
});

test("optional company scoping applies equally to listing and collection", async () => {
  const other = await PaymentHistory.create({ company: oid(), bookingId: oid(), createdBy: owner, type: "booking", amount: 100, paymentMethod: "cash" });
  const previous = process.env.PAYMENTS_SCOPE_BY_COMPANY;
  process.env.PAYMENTS_SCOPE_BY_COMPANY = "true";
  try {
    assert.ok(!(await api("GET", `${ENDPOINT}?tab=pending`)).json.data.some((row) => row._id === String(other._id)));
    assert.equal((await api("POST", `${ENDPOINT}/${other._id}/collect`, { amount: 100 })).status, 404);
  } finally {
    if (previous === undefined) delete process.env.PAYMENTS_SCOPE_BY_COMPANY;
    else process.env.PAYMENTS_SCOPE_BY_COMPANY = previous;
  }
});
