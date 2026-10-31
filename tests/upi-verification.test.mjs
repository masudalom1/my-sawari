import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";
import { toDayKey, addDayKeys, collectedOf, dayStartIST, dayEndIST } from "../src/utils/revenue.utils.js";

const URL = "/dashboard/payments-history/upi";
let ctx, api, PaymentHistory, owner, phone, gpay, razorpay, mixed, today;
const oid = () => new ctx.mongoose.Types.ObjectId();
const get = (query = "tab=all") => api("GET", `${URL}?${query}`);
const verify = (row, channel, amount, extra = {}) => api("POST", `${URL}/${row._id}/verify`, { channel, amount, confirmed: true, expectedVerifiedAmount: 0, ...extra });
const make = (extra = {}) => PaymentHistory.create({ company: owner, bookingId: oid(), createdBy: owner, amount: 100,
  paymentMethod: "phonepe", type: "booking", paymentDate: `${today}T12:00:00+05:30`,
  customer: { fullName: "UPI fixture", mobileNumber: "9400100011" },
  vehicle: { vehicleName: "UPI test car", vehicleNumber: "KA01UP0001" }, transactionId: "1234", ...extra });

before(async () => {
  ctx = await startTestApp();
  const login = await createUserAndLogin(ctx.base); owner = login.user._id || login.user.id; api = client(ctx.base, login.token);
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
  today = toDayKey(new Date());
  phone = await make(); gpay = await make({ paymentMethod: "gpay", amount: 200 });
  razorpay = await make({ paymentMethod: "razorpay", amount: 300, customPaymentDate: `${addDayKeys(today, -1)}T12:00:00+05:30` });
  await PaymentHistory.collection.updateOne(
    { _id: razorpay._id },
    { $set: { createdAt: new Date(`${addDayKeys(today, -1)}T12:00:00+05:30`) } },
  );
  mixed = await make({ paymentMethod: "mixed", amount: 1000, paymentBreakdown: { cash: 100, phonePe: 200, gpay: 300, razorpay: 400 } });
  await make({ paymentMethod: "cash", amount: 999 });
  await make({ type: "refund", amount: 999 });
  await make({ paymentMethod: "mixed", amount: 999 });
});
after(async () => ctx?.stop());

test("UPI endpoints require an active authenticated staff session", async () => {
  assert.equal((await client(ctx.base)("GET", URL)).status, 401);
  assert.equal((await client(ctx.base)("POST", `${URL}/${phone._id}/verify`, {})).status, 401);
  const blocked = await createUserAndLogin(ctx.base, { role: "FINANCE_EXECUTIVE" });
  const { default: User } = await import("../src/models/user.model.js");
  await User.updateOne({ _id: blocked.user.id }, { $set: { accountStatus: "BLOCKED" } });
  assert.equal((await client(ctx.base, blocked.token)("GET", URL)).status, 403);
});

test("GET returns the three digital methods and only explicit UPI portions of mixed receipts without writes", async () => {
  const before = await PaymentHistory.find().sort({ _id: 1 }).lean();
  const result = await get();
  assert.equal(result.status, 200); assert.equal(result.json.total, 4);
  assert.equal(result.json.summary.amount, 1500); assert.equal(result.json.summary.pending.amount, 1500);
  assert.deepEqual(result.json.methodTotals, { all: { amount: 1500, count: 4 }, phonepe: { amount: 300, count: 2 },
    gpay: { amount: 500, count: 2 }, razorpay: { amount: 700, count: 2 } });
  assert.equal(new Set(result.json.data.map((row) => row._id)).size, 4);
  const row = result.json.data.find((row) => row._id === String(mixed._id));
  assert.equal(row.upiAmount, 900); assert.equal(row.amount, 1000);
  assert.deepEqual(Object.values(row.verification).map((part) => part.amount), [200, 300, 400]);
  assert.ok(result.json.data.every((row) => row.canVerify));
  assert.equal(result.json.groups.length, 2);
  assert.ok(result.json.data.every((row) => !row.createdBy.email));
  assert.deepEqual(await PaymentHistory.find().sort({ _id: 1 }).lean(), before);
});

test("UPI read includes legacy payment-method spellings supported by the shared normalizer", async () => {
  const marker = "Legacy method alias fixture";
  const now = new Date();
  const rows = [
    { paymentMethod: "Google Pay", amount: 125 },
    { paymentMethod: "GPay", amount: 50 },
    { paymentMethod: "Phone Pe", amount: 100 },
    { paymentMethod: "razor-pay", amount: 75 },
    { paymentMethod: "MIX", amount: 300, paymentBreakdown: { cash: 100, phonePe: 100, gpay: 100 } },
  ].map(({ paymentMethod, amount, paymentBreakdown = {} }) => ({
    company: owner,
    bookingId: oid(),
    createdBy: owner,
    amount,
    paymentMethod,
    paymentBreakdown,
    type: "booking",
    customer: { fullName: marker, mobileNumber: "9400100011" },
    vehicle: { vehicleName: "UPI test car", vehicleNumber: "KA01UP0001" },
    paymentDate: now,
    customPaymentDate: now,
    createdAt: now,
    updatedAt: now,
  }));
  const inserted = await PaymentHistory.collection.insertMany(rows);
  try {
    const result = await get(`tab=all&search=${encodeURIComponent(marker)}`);
    assert.equal(result.status, 200);
    assert.equal(result.json.total, 5);
    assert.equal(result.json.summary.amount, 550);
    assert.deepEqual(result.json.methodTotals, {
      all: { amount: 550, count: 5 },
      phonepe: { amount: 200, count: 2 },
      gpay: { amount: 275, count: 3 },
      razorpay: { amount: 75, count: 1 },
    });
    const mixed = await get(`tab=all&method=mixed&search=${encodeURIComponent(marker)}`);
    assert.equal(mixed.json.total, 1);
    assert.equal(mixed.json.summary.amount, 200);
  } finally {
    await PaymentHistory.deleteMany({ _id: { $in: Object.values(inserted.insertedIds) } });
  }
});

test("relative tabs use IST createdAt; channel, month, date and transaction search compose", async () => {
  assert.equal((await get("tab=today")).json.total, 3);
  assert.equal((await get("tab=yesterday")).json.data[0]._id, String(razorpay._id));
  assert.equal((await get("tab=all&method=gpay")).json.total, 2);
  assert.equal((await get("tab=all&method=gpay")).json.summary.amount, 500);
  assert.equal((await get("tab=all&method=mixed")).json.total, 1);
  assert.equal((await get(`tab=all&month=${today.slice(0, 7)}&date=${today}&search=1234`)).json.total, 3);
  const empty = await get("tab=all&search=no-match");
  assert.equal(empty.json.summary.amount, 0); assert.deepEqual(empty.json.groups, []);
  for (const total of Object.values(empty.json.methodTotals)) assert.deepEqual(total, { amount: 0, count: 0 });
});

test("all page sizes include the full filtered totals and deterministic pages without duplicates", async () => {
  const rows = await PaymentHistory.insertMany(Array.from({ length: 107 }, (_, index) => ({ company: owner, bookingId: oid(), createdBy: owner,
    type: "booking", paymentMethod: "gpay", amount: 1, customer: { fullName: "Pagination UPI" }, paymentDate: `${today}T12:00:00+05:30` })));
  try {
    const all = await get("tab=all&search=Pagination%20UPI&limit=all&page=999");
    assert.equal(all.json.data.length, 107); assert.equal(all.json.pagination.page, 1);
    for (const limit of [25, 50, 100]) {
      const ids = [];
      for (let page = 1; page <= Math.ceil(107 / limit); page++) {
        const result = await get(`tab=all&search=Pagination%20UPI&limit=${limit}&page=${page}`);
        assert.deepEqual(result.json.summary, all.json.summary);
        assert.deepEqual(result.json.methodTotals, all.json.methodTotals);
        assert.deepEqual(result.json.groups.flatMap((group) => group.payments.map((row) => row._id)), result.json.data.map((row) => row._id));
        for (const group of result.json.groups) {
          assert.equal(group.count, group.payments.length);
          assert.equal(group.amount, group.payments.length);
        }
        ids.push(...result.json.data.map((row) => row._id));
      }
      assert.deepEqual(ids, all.json.data.map((row) => row._id));
    }
    const last = await get("tab=all&search=Pagination%20UPI&limit=25&page=999");
    assert.equal(last.json.pagination.page, 5); assert.equal(last.json.pagination.from, 101); assert.equal(last.json.pagination.to, 107);
  } finally { await PaymentHistory.deleteMany({ _id: { $in: rows.map((row) => row._id) } }); }
});

test("malformed filters and client-selected scope are rejected", async () => {
  for (const query of ["tab=bad", "method=cash", "limit=0", "limit=500", "page=0", "page=1x", "month=2026-13", "date=2026-02-30", "company=anything", "month=2026-10&date=2026-11-01"]) {
    assert.equal((await get(query)).status, 400, query);
  }
});

test("partial PhonePe verification appends one audit and keeps existing mirror fields in sync", async () => {
  const result = await verify(phone, "phonepe", 40, { note: "Bank matched", view: { tab: "pending", limit: "25" } });
  assert.equal(result.status, 200); assert.equal(result.json.data.remainingAmount, 60);
  assert.equal(result.json.view.summary.verified.amount, 40);
  const saved = await PaymentHistory.findById(phone._id).lean();
  assert.equal(saved.collectedPhonePe, 40); assert.equal(saved.collectedAmount, 40); assert.equal(saved.isCollected, false);
  assert.equal(saved.collectionHistory.length, 1); assert.equal(saved.collectionHistory[0].channel, "phonepe");
  assert.equal(String(saved.collectionHistory[0].collectedBy), String(owner)); assert.equal(saved.collectionHistory[0].note, "Bank matched");
  assert.equal(saved.amount, 100); assert.equal(collectedOf(saved, saved.amount), 40);
  assert.equal((await verify(phone, "phonepe", 40)).status, 409);
  assert.equal((await verify(phone, "phonepe", 60, { expectedVerifiedAmount: 40 })).status, 200);
  const full = await PaymentHistory.findById(phone._id).lean();
  assert.equal(full.isPhonePeCollected, true); assert.equal(full.isCollected, true);
  assert.equal((await verify(phone, "phonepe", 1, { expectedVerifiedAmount: 100 })).status, 409);
});

test("GPay and Razorpay verification persist to their existing audit channels without new receipts", async () => {
  const count = await PaymentHistory.countDocuments();
  for (const [row, channel] of [[gpay, "gpay"], [razorpay, "razorpay"]]) {
    const result = await verify(row, channel, row.amount);
    assert.equal(result.status, 200);
    const saved = await PaymentHistory.findById(row._id).lean();
    assert.equal(saved.collectedAmount, row.amount); assert.equal(saved.collectedPhonePe, 0);
    assert.equal(saved.isCollected, true); assert.equal(saved.collectionHistory[0].channel, channel);
    assert.equal(collectedOf(saved, saved.amount), row.amount); assert.equal(saved.amount, row.amount);
  }
  assert.equal(await PaymentHistory.countDocuments(), count);
  assert.equal((await get("tab=verified")).json.total, 3);
});

test("mixed digital channels are independently verified and leave the cash collection untouched", async () => {
  const cashResult = await api("POST", `/dashboard/payments-history/cash/${mixed._id}/collect`, { amount: 40, expectedCollectedAmount: 0 });
  assert.equal(cashResult.status, 200);
  const before = await PaymentHistory.findById(mixed._id).lean();
  for (const [channel, amount] of [["phonepe", 200], ["gpay", 300], ["razorpay", 400]]) assert.equal((await verify(mixed, channel, amount)).status, 200);
  const saved = await PaymentHistory.findById(mixed._id).lean();
  assert.equal(saved.collectedAmount, 40); assert.equal(saved.isCollected, false); assert.equal(saved.collectedPhonePe, 200);
  assert.equal(saved.amount, 1000); assert.deepEqual(saved.paymentBreakdown, before.paymentBreakdown);
  assert.equal(saved.collectionHistory.length, 4); assert.equal(collectedOf(saved, 1000), 940);
  const cash = await api("GET", "/dashboard/payments-history/cash?tab=pending");
  const cashRow = cash.json.data.find((row) => row._id === String(mixed._id));
  assert.equal(cashRow.remainingAmount, 60); assert.equal(cashRow.collectionHistory.length, 1);
  const row = (await get("tab=verified")).json.data.find((row) => row._id === String(mixed._id));
  assert.equal(row.verifiedAmount, 900); assert.equal(row.verified, true);
});

test("a channel filter reports only that portion and its independent verification status", async () => {
  const row = await make({ paymentMethod: "mixed", amount: 200, paymentBreakdown: { phonePe: 80, gpay: 120 }, customer: { fullName: "Channel filter fixture" } });
  assert.equal((await verify(row, "phonepe", 80)).status, 200);
  const verified = await get("tab=verified&method=phonepe&search=Channel%20filter%20fixture");
  assert.equal(verified.json.total, 1); assert.equal(verified.json.summary.amount, 80); assert.equal(verified.json.summary.verified.amount, 80);
  assert.deepEqual(verified.json.data[0].visibleChannels, ["phonepe"]);
  const pending = await get("tab=pending&method=gpay&search=Channel%20filter%20fixture");
  assert.equal(pending.json.total, 1); assert.equal(pending.json.summary.amount, 120); assert.equal(pending.json.data[0].canVerify, true);
});

test("method card totals follow date/search/status and each channel's mixed verification without writes", async () => {
  const row = await make({ paymentMethod: "mixed", amount: 1000,
    paymentBreakdown: { cash: 100, phonePe: 200, gpay: 300, razorpay: 400 },
    customer: { fullName: "Method totals fixture" } });
  assert.equal((await verify(row, "phonepe", 200)).status, 200);
  assert.equal((await verify(row, "gpay", 150)).status, 200);
  const before = await PaymentHistory.find().sort({ _id: 1 }).lean();
  const base = `search=Method%20totals%20fixture&month=${today.slice(0, 7)}&date=${today}`;
  const expected = {
    all: [900, 200, 300, 400], pending: [700, 0, 300, 400], completed: [200, 200, 0, 0],
    today: [900, 200, 300, 400], yesterday: [0, 0, 0, 0],
  };
  for (const [tab, amounts] of Object.entries(expected)) {
    const result = await get(`tab=${tab}&${base}`);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.values(result.json.methodTotals).map((value) => value.amount), amounts, tab);
    for (const method of ["all", "phonepe", "gpay", "razorpay"]) {
      const selected = await get(`tab=${tab}&method=${method}&${base}`);
      assert.deepEqual(selected.json.methodTotals, result.json.methodTotals, `${tab}/${method} facets`);
      assert.equal(selected.json.summary.amount, result.json.methodTotals[method].amount, `${tab}/${method} amount`);
      assert.equal(selected.json.summary.count, result.json.methodTotals[method].count, `${tab}/${method} count`);
    }
  }
  const missing = await get(`tab=all&search=Method%20totals%20fixture&date=${addDayKeys(today, -1)}`);
  assert.ok(Object.values(missing.json.methodTotals).every((value) => value.amount === 0));
  const numeric = await get("tab=all&search=200");
  assert.equal(numeric.json.methodTotals.phonepe.amount, (await get("tab=all&method=phonepe&search=200")).json.summary.amount);
  assert.deepEqual(await PaymentHistory.find().sort({ _id: 1 }).lean(), before);
});

test("invalid split, refund, overpayment, missing confirmation and tampered actor cannot be verified", async () => {
  const invalid = await make({ paymentMethod: "mixed", amount: 100, paymentBreakdown: { cash: 30, gpay: 80 } });
  const row = (await get()).json.data.find((row) => row._id === String(invalid._id));
  assert.equal(row.canVerify, false); assert.ok(row.reviewReasons.length);
  assert.equal((await verify(invalid, "gpay", 80)).status, 409);
  const fresh = await make({ paymentMethod: "gpay" });
  for (const extra of [{ confirmed: false }, { amount: 100.01 }, { amount: 1.001 }, { amount: -1 }, { amount: "10" }, { expectedVerifiedAmount: undefined }, { channel: "cash" }, { collectedBy: owner }, { note: {} }]) {
    assert.equal((await verify(fresh, "gpay", 10, extra)).status, 400);
  }
  const refund = await make({ type: "refund" });
  assert.equal((await verify(refund, "phonepe", 1)).status, 404);
  assert.equal((await verify({ _id: "invalid" }, "phonepe", 1)).status, 400);
  assert.equal((await PaymentHistory.findById(fresh._id)).collectionHistory.length, 0);
});

test("UPI reconciliation warnings report an over-recorded channel amount without hiding it", async () => {
  const row = await make({ paymentMethod: "gpay", amount: 500, collectedAmount: 600 });
  const result = await get(`tab=all&search=${row.transactionId}`);
  const payment = result.json.data.find((item) => item._id === String(row._id));
  assert.equal(payment.upiAmount, 500);
  assert.equal(payment.canVerify, false);
  assert.ok(payment.reviewReasons.some((reason) =>
    reason.includes("Recorded gpay amount (600.00) exceeds its allocated channel portion (500.00)."),
  ));
});

test("concurrent partial verifications and replayed submissions append exactly one event", async () => {
  const row = await make({ paymentMethod: "gpay", amount: 10 });
  const results = await Promise.all([1, 2].map(() => verify(row, "gpay", 9.99)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const saved = await PaymentHistory.findById(row._id).lean();
  assert.equal(saved.collectionHistory.length, 1); assert.equal(saved.collectedAmount, 9.99);
  assert.equal((await verify(row, "gpay", 0.01, { expectedVerifiedAmount: 9.99 })).status, 200);
  assert.equal((await PaymentHistory.findById(row._id)).isCollected, true);
});

test("collection flags and legacy counters do not prove staff verification", async () => {
  const legacy = await make({ paymentMethod: "gpay", isCollected: true });
  const partial = await make({ paymentMethod: "phonepe", collectedPhonePe: 20, collectedAmount: 20 });
  const cashLegacy = await make({ paymentMethod: "mixed", amount: 200, paymentBreakdown: { cash: 100, gpay: 100 }, collectedAmount: 30 });
  const rows = (await get()).json.data;
  const complete = rows.find((row) => row._id === String(legacy._id));
  assert.equal(complete.verified, false); assert.equal(complete.verifiedAmount, 0);
  assert.equal(complete.remainingAmount, 100); assert.equal(complete.canVerify, false);
  assert.ok(complete.reviewReasons.some((reason) => reason.includes("not proof of staff verification")));
  assert.ok(!(await get("tab=completed&limit=all")).json.data.some((row) => row._id === String(legacy._id)));
  for (const [row, channel, expected] of [[partial, "phonepe", 20], [cashLegacy, "gpay", 0]]) {
    assert.equal(rows.find((item) => item._id === String(row._id)).canVerify, false);
    assert.equal((await verify(row, channel, 10, { expectedVerifiedAmount: expected })).status, 409);
  }
});

test("Pending and Completed partition mixed components and verification refresh keeps the same receipt", async () => {
  const row = await make({ paymentMethod: "mixed", amount: 1000, customer: { fullName: "Status partition fixture" },
    paymentBreakdown: { cash: 100, phonePe: 200, gpay: 300, razorpay: 400 } });
  assert.equal((await verify(row, "phonepe", 200)).status, 200);
  assert.equal((await verify(row, "gpay", 150)).status, 200);
  const search = "Status%20partition%20fixture";
  const pending = (await get(`tab=pending&search=${search}`)).json;
  const completed = (await get(`tab=completed&search=${search}`)).json;
  assert.deepEqual(pending.data[0].visibleChannels, ["gpay", "razorpay"]);
  assert.deepEqual(completed.data[0].visibleChannels, ["phonepe"]);
  assert.equal(pending.summary.amount, 700); assert.equal(pending.summary.pending.amount, 550);
  assert.equal(completed.summary.amount, 200); assert.equal(completed.summary.pending.amount, 0);
  assert.equal(completed.data[0].canVerify, false);
  assert.equal(pending.data[0]._id, String(row._id)); assert.equal(completed.data[0]._id, String(row._id));
  assert.equal(pending.stats.completed.amount, completed.summary.amount);
  const all = (await get(`tab=all&search=${search}`)).json;
  assert.equal(all.summary.count, 1);
  assert.equal(all.summary.verified.count, all.stats.completed.count);
  assert.equal(all.summary.pending.count, all.stats.pending.count);
  assert.equal(all.summary.verified.count, 1); assert.equal(all.summary.pending.count, 1);
  assert.deepEqual((await get(`tab=verified&search=${search}`)).json, completed, "old tab alias remains compatible");
  const count = await PaymentHistory.countDocuments();
  const result = await verify(row, "gpay", 150, { expectedVerifiedAmount: 150,
    view: { tab: "pending", search: "Status partition fixture" } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.view.data[0].visibleChannels, ["razorpay"]);
  assert.equal(result.json.view.summary.amount, 400);
  const after = (await get(`tab=completed&search=${search}`)).json;
  assert.deepEqual(after.data[0].visibleChannels, ["phonepe", "gpay"]);
  assert.equal(after.summary.amount, 500); assert.equal(after.total, 1);
  assert.equal(await PaymentHistory.countDocuments(), count);
});

test("Completed requires a digital staff audit, not payment success, collection flags or another channel's audit", async () => {
  const base = { customer: { fullName: "Verification evidence fixture" } };
  const successOnly = await make({ ...base, paymentMethod: "gpay", isCollected: true, collectedAmount: 100 });
  await PaymentHistory.collection.updateOne({ _id: successOnly._id }, { $set: { paymentStatus: "paid", status: "confirmed", payment: { status: "completed" } } });
  const flagOnly = await make({ ...base, isPhonePeCollected: true });
  const wrongChannel = await make({ ...base, paymentMethod: "razorpay", collectionHistory: [{ channel: "cash", amount: 100, collectedBy: owner }] });
  const noActor = await make({ ...base, paymentMethod: "gpay", collectedAmount: 100 });
  await PaymentHistory.collection.updateOne({ _id: noActor._id }, { $set: { collectionHistory: [{ channel: "gpay", amount: 100, collectedAt: new Date() }] } });
  const noDate = await make({ ...base, paymentMethod: "gpay", collectedAmount: 100 });
  await PaymentHistory.collection.updateOne({ _id: noDate._id }, { $set: { collectionHistory: [{ channel: "gpay", amount: 100, collectedBy: new ctx.mongoose.Types.ObjectId(owner) }] } });
  const audited = await make({ ...base, paymentMethod: "razorpay", collectedAmount: 100, isCollected: false,
    collectionHistory: [{ channel: "razorpay", amount: 100, collectedBy: owner, collectedAt: new Date() }] });
  const before = await PaymentHistory.find().sort({ _id: 1 }).lean();
  const completed = await get("tab=completed&search=Verification%20evidence%20fixture");
  assert.deepEqual(completed.json.data.map((row) => row._id), [String(audited._id)]);
  assert.equal(completed.json.summary.verified.amount, 100);
  const pending = await get("tab=pending&search=Verification%20evidence%20fixture");
  assert.deepEqual(new Set(pending.json.data.map((row) => row._id)), new Set([successOnly, flagOnly, wrongChannel, noActor, noDate].map((row) => String(row._id))));
  assert.equal(pending.json.summary.verified.amount, 0);
  for (const row of pending.json.data) assert.equal(row.canVerify, false);
  assert.deepEqual(await PaymentHistory.find().sort({ _id: 1 }).lean(), before);
});

test("Today and Yesterday use Payment Report recorded-date boundaries; cards retain the original payment date", async () => {
  const base = { customer: { fullName: "IST filter fixture" }, paymentMethod: "gpay" };
  const start = dayStartIST(today), end = dayEndIST(today);
  const atStart = await make({ ...base, paymentDate: start });
  const atEnd = await make({ ...base, paymentDate: end });
  const beforeStart = await make({ ...base, paymentDate: new Date(start.getTime() - 1) });
  const afterEnd = await make({ ...base, paymentDate: new Date(end.getTime() + 1) });
  const overridden = await make({ ...base, paymentDate: start, customPaymentDate: new Date(start.getTime() - 1) });
  const missingDate = await make({ ...base, paymentDate: null, customPaymentDate: null });
  await PaymentHistory.collection.updateOne({ _id: atStart._id }, { $set: { createdAt: start } });
  await PaymentHistory.collection.updateOne({ _id: atEnd._id }, { $set: { createdAt: end } });
  await PaymentHistory.collection.updateOne({ _id: beforeStart._id }, { $set: { createdAt: new Date(start.getTime() - 1) } });
  await PaymentHistory.collection.updateOne({ _id: afterEnd._id }, { $set: { createdAt: new Date(end.getTime() + 1) } });
  await PaymentHistory.collection.updateOne({ _id: overridden._id }, { $set: { createdAt: start } });
  await PaymentHistory.collection.updateOne({ _id: missingDate._id }, { $set: { createdAt: start } });
  assert.equal((await verify(atEnd, "gpay", 100)).status, 200);
  assert.equal((await verify(beforeStart, "gpay", 100)).status, 200);
  const before = await PaymentHistory.find().sort({ _id: 1 }).lean();
  const current = (await get("tab=today&search=IST%20filter%20fixture")).json;
  const previous = (await get("tab=yesterday&search=IST%20filter%20fixture")).json;
  assert.deepEqual(new Set(current.data.map((row) => row._id)), new Set([atStart, atEnd, overridden, missingDate].map((row) => String(row._id))));
  assert.deepEqual(new Set(previous.data.map((row) => row._id)), new Set([beforeStart].map((row) => String(row._id))));
  assert.ok(!current.data.some((row) => row._id === String(afterEnd._id)));
  assert.equal(current.data.find((row) => row._id === String(overridden._id)).paymentDay, addDayKeys(today, -1));
  assert.equal(current.data.find((row) => row._id === String(overridden._id)).recordedDay, today);
  for (const result of [current, previous]) {
    assert.equal(result.summary.amount, result === current ? 400 : 100);
    assert.equal(result.dateBasis, "createdAt");
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].date, result === current ? today : addDayKeys(today, -1));
    assert.equal(result.groups[0].count, result.total);
    assert.equal(result.groups[0].amount, result.summary.amount);
  }
  assert.equal(current.summary.verified.count, 1); assert.equal(current.summary.pending.count, 3);
  assert.equal(previous.summary.verified.count, 1); assert.equal(previous.summary.pending.count, 0);
  const all = (await get("tab=all&search=IST%20filter%20fixture")).json;
  assert.equal(all.total, 6);
  assert.equal(all.data.find((row) => row._id === String(missingDate._id)).paymentDay, null);
  assert.equal(all.data.find((row) => row._id === String(missingDate._id)).recordedDay, today);
  assert.deepEqual(await PaymentHistory.find().sort({ _id: 1 }).lean(), before);
});

test("createdAt groups retain missing optional fields, sort deterministically and total only matching UPI portions", async () => {
  const marker = "Recorded grouping fixture", nextDay = "2027-01-01", previousDay = "2026-12-31";
  const base = { company: new ctx.mongoose.Types.ObjectId(owner), createdBy: new ctx.mongoose.Types.ObjectId(owner),
    bookingId: oid(), type: "booking", customer: { fullName: marker } };
  const audit = (channel, amount) => [{ channel, amount, collectedBy: base.createdBy, collectedAt: new Date() }];
  const fixtures = [
    { ...base, _id: oid(), paymentMethod: "mixed", amount: 1000, createdAt: dayStartIST(nextDay),
      paymentBreakdown: { cash: 100, phonePe: 200, gpay: 300, razorpay: 400 },
      collectedPhonePe: 200, collectionHistory: audit("phonepe", 200) },
    { ...base, _id: oid(), paymentMethod: "phonepe", amount: 0.2, createdAt: dayStartIST(nextDay), paymentDate: "", paymentTime: "", upiLast4: "1234" },
    { ...base, _id: oid(), paymentMethod: "gpay", amount: 0.1, createdAt: dayEndIST(previousDay),
      paymentDate: dayStartIST("2031-06-01"), customPaymentDate: dayStartIST("2031-05-01"), paymentTime: "7:34 pm",
      collectedAmount: 0.1, collectionHistory: audit("gpay", 0.1) },
    { ...base, _id: oid(), paymentMethod: "razorpay", amount: 50, paymentDate: new Date() },
    { ...base, _id: oid(), paymentMethod: "phonepe", amount: 25, createdAt: "invalid", paymentDate: new Date() },
    { ...base, _id: oid(), paymentMethod: "gpay", amount: 1, createdAt: "", paymentDate: "", paymentTime: "" },
  ];
  await PaymentHistory.collection.insertMany(fixtures);
  try {
    const before = await PaymentHistory.collection.find({ "customer.fullName": marker }).sort({ _id: 1 }).toArray();
    const scope = `search=${encodeURIComponent(marker)}&limit=all`;
    const all = (await get(`tab=all&${scope}`)).json;
    assert.equal(all.total, 6); assert.equal(all.summary.amount, 976.3);
    assert.deepEqual(all.groups.map((group) => group.date), [nextDay, previousDay, null]);
    assert.deepEqual(all.groups.map((group) => [group.count, group.amount]), [[2, 900.2], [1, 0.1], [3, 76]]);
    assert.deepEqual(all.data.slice(0, 2).map((row) => row._id), fixtures.slice(0, 2).map((row) => String(row._id)).sort().reverse());
    assert.equal(new Set(all.groups.flatMap((group) => group.payments.map((row) => row._id))).size, 6);
    const missing = all.data.find((row) => row._id === String(fixtures[0]._id));
    assert.equal(missing.paymentDate, null); assert.equal(missing.effectivePaymentDate, null); assert.equal(missing.paymentTime, "");
    assert.equal(missing.recordedDay, nextDay);
    assert.deepEqual(all.data.find((row) => row._id === String(fixtures[1]._id)).upiLast4, ["1234"]);
    const pending = (await get(`tab=pending&${scope}`)).json;
    assert.deepEqual(pending.groups.map((group) => [group.date, group.count, group.amount]), [[nextDay, 2, 700.2], [null, 3, 76]]);
    const completed = (await get(`tab=completed&${scope}`)).json;
    assert.deepEqual(completed.groups.map((group) => [group.date, group.count, group.amount]), [[nextDay, 1, 200], [previousDay, 1, 0.1]]);
    const byDate = (await get(`tab=all&date=${nextDay}&${scope}`)).json;
    assert.equal(byDate.total, 2); assert.equal(byDate.summary.amount, 900.2);
    const byMonth = (await get(`tab=all&month=2026-12&${scope}`)).json;
    assert.equal(byMonth.total, 1); assert.equal(byMonth.data[0].paymentTime, "7:34 pm");
    assert.equal((await get(`tab=all&month=2031-06&${scope}`)).json.total, 0);
    const channel = (await get(`tab=all&method=gpay&date=${nextDay}&${scope}`)).json;
    assert.equal(channel.groups[0].amount, 300);
    assert.deepEqual(await PaymentHistory.collection.find({ "customer.fullName": marker }).sort({ _id: 1 }).toArray(), before);
  } finally {
    await PaymentHistory.deleteMany({ _id: { $in: fixtures.map((row) => row._id) } });
  }
});

test("configured company scoping applies to both reads and verification", async () => {
  const outside = await make({ company: oid(), paymentMethod: "gpay" });
  const previous = process.env.PAYMENTS_SCOPE_BY_COMPANY; process.env.PAYMENTS_SCOPE_BY_COMPANY = "true";
  try {
    assert.ok(!(await get("tab=all&limit=all")).json.data.some((row) => row._id === String(outside._id)));
    assert.equal((await verify(outside, "gpay", 100)).status, 404);
  } finally { if (previous === undefined) delete process.env.PAYMENTS_SCOPE_BY_COMPANY; else process.env.PAYMENTS_SCOPE_BY_COMPANY = previous; }
});

test("an updated-view read failure reports a successful verification without repeating the write", async () => {
  const row = await make({ paymentMethod: "gpay" }), originalFind = PaymentHistory.find;
  try {
    PaymentHistory.find = () => { throw new Error("Temporary view read failure"); };
    const result = await verify(row, "gpay", 30, { view: { tab: "pending", limit: "25" } });
    assert.equal(result.status, 200); assert.equal(result.json.view, null);
    assert.equal((await PaymentHistory.findById(row._id)).collectionHistory.length, 1);
  } finally { PaymentHistory.find = originalFind; }
});
