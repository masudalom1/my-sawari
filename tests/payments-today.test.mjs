// "Today" in payment summaries is the IST day even when the server runs in UTC
// (as on Render). Payments are inserted around today's IST midnight.

process.env.TZ = "UTC";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

let ctx;
let api;

before(async () => {
  ctx = await startTestApp();
  const { token } = await createUserAndLogin(ctx.base);
  api = client(ctx.base, token);
});

after(async () => {
  await ctx?.stop();
});

test("todaySummary and cash 'collected today' use IST day boundaries", async () => {
  const { default: PaymentHistory } = await import("../src/models/paymentHistory.model.js");
  const { toDayKey, dayStartIST } = await import("../src/utils/revenue.utils.js");
  const { default: mongoose } = await import("mongoose");

  const istMidnight = dayStartIST(toDayKey(new Date()));
  const minute = 60 * 1000;
  const base = {
    company: new mongoose.Types.ObjectId(),
    bookingId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    paymentMethod: "cash",
    type: "booking",
    collectionHistory: [],
  };

  // Inserted directly so createdAt / lastCollectedAt are exactly what we set.
  await PaymentHistory.collection.insertMany([
    { ...base, amount: 111, createdAt: new Date(istMidnight - minute), isCollected: true, collectedAmount: 111, lastCollectedAt: new Date(istMidnight - minute) },
    { ...base, amount: 222, createdAt: new Date(istMidnight.getTime() + minute), isCollected: true, collectedAmount: 222, lastCollectedAt: new Date(istMidnight.getTime() + minute) },
  ]);

  const history = await api("GET", "/payments?page=1");
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.todaySummary, { totalCollection: 222, cash: 222, phonePe: 0 });

  const cash = await api("GET", "/payments/pending?status=collected");
  assert.equal(cash.status, 200);
  assert.deepEqual(cash.json.stats.collectedToday, { count: 1, amount: 222 });
  assert.deepEqual(cash.json.stats.collectedTotal, { count: 2, amount: 333 });
});
