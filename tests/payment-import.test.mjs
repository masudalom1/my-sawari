import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";
import { normalizeData, buildReport } from "../../my-sawari-Frontend/app/features/revenue/engine.js";

test("payment import uses the established revenue allocation without changing source records", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const { token, user } = await createUserAndLogin(ctx.base);
  const api = client(ctx.base, token);
  const { default: PaymentHistory } = await import("../src/models/paymentHistory.model.js");
  const { default: Vehicle } = await import("../src/models/vehicle.model.js");
  const { default: Booking } = await import("../src/models/booking.model.js");
  const oid = () => new ctx.mongoose.Types.ObjectId();
  const owner = new ctx.mongoose.Types.ObjectId(user.id);
  const vehicleA = oid(), vehicleB = oid(), deletedVehicle = oid();
  const bookingA = oid(), bookingB = oid();
  const createdAt = new Date("2026-10-20T06:00:00.000Z");
  const collectedAt = new Date("2026-10-21T07:30:00.000Z");
  const getImport = () => api("GET", "/dashboard/payments/import");

  await t.test("an empty database returns the existing successful empty response", async () => {
    const result = await getImport();
    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.hasPayments, false);
    assert.equal(result.json.count, 0);
    assert.deepEqual(result.json.payments, []);
  });

  const sources = [];
  const add = (name, extra, expected) => {
    const record = { _id: oid(), company: owner, createdBy: owner, bookingId: bookingA,
      type: "booking", amount: 1000, paymentMethod: "cash", createdAt,
      customer: { fullName: "Import fixture A", mobileNumber: "9000001001" },
      vehicle: { vehicleId: vehicleA, vehicleName: "Import fixture vehicle", vehicleNumber: "KA01PI0001" },
      booking: { fromDate: new Date("2026-11-01"), toDate: new Date("2026-11-03"), bookingAmount: 1000 }, ...extra };
    sources.push({ name, record, expected });
    return record;
  };
  const cash = add("cash-only", { collectedAmount: 250, isCollected: false, collectionHistory: [{ _id: oid(), channel: "cash", amount: 250, collectedAt, collectedBy: owner }] },
    { amount: 1000, method: "cash", breakdown: [0, 0, 0], split: [1000, 0, 0, 0] });
  add("PhonePe-only", { amount: 600, paymentMethod: "phonepe", paymentBreakdown: null, collectedPhonePe: 100 },
    { amount: 600, method: "phonepe", breakdown: [0, 0, 0], split: [0, 600, 0, 0] });
  add("Razorpay-only", { amount: 700, paymentMethod: "razorpay", paymentBreakdown: { razorpay: 700 } },
    { amount: 700, method: "razorpay", breakdown: [0, 0, 700], split: [0, 0, 700, 0] });
  add("mixed valid split", { amount: 1300, paymentMethod: "mixed", paymentBreakdown: { cash: 1000, phonePe: 300, razorpay: 0 } },
    { amount: 1300, method: "mixed", breakdown: [1000, 300, 0], split: [1000, 300, 0, 0] });
  add("mixed without split", { amount: 900, paymentMethod: "mixed", bookingId: bookingB },
    { amount: 900, method: "mixed", breakdown: [0, 0, 0], split: [0, 0, 0, 900] });
  const legacy = add("legacy numeric strings and breakdown-only amount", { amount: undefined, paymentMethod: "mixed", paymentBreakdown: { cash: "40.25", phonePe: "59.75", razorpay: "0" } },
    { amount: 100, method: "mixed", breakdown: [40.25, 59.75, 0], split: [40.25, 59.75, 0, 0] });
  delete legacy.amount;
  const noSnapshots = add("legacy missing optional fields and method", { amount: 125, bookingId: bookingB },
    { amount: 125, method: "cash", breakdown: [0, 0, 0], split: [125, 0, 0, 0] });
  for (const key of ["paymentMethod", "customer", "vehicle", "booking"]) delete noSnapshots[key];
  add("partial mixed split keeps its unspecified remainder", { amount: 1000, paymentMethod: "mixed", paymentBreakdown: { cash: 100 }, bookingId: bookingB },
    { amount: 1000, method: "mixed", breakdown: [100, 0, 0], split: [100, 0, 0, 900] });
  const refund = add("refund retains its original type and amount", { amount: 50, type: "refund", paymentMethod: "cash", bookingId: bookingB },
    { amount: 50, method: "cash", breakdown: [0, 0, 0], split: [50, 0, 0, 0] });

  await Vehicle.collection.insertMany([
    { _id: vehicleA, company: owner, isDeleted: false, vehicleName: "Import fixture vehicle", vehicleNumber: "KA01PI0001",
      payments: [...sources.map(({ record }) => record._id), cash._id] },
    { _id: vehicleB, company: owner, isDeleted: false, vehicleName: "Other import fixture", vehicleNumber: "KA01PI0002", payments: [] },
    { _id: deletedVehicle, company: owner, isDeleted: true, payments: [] },
  ]);
  await Booking.collection.insertMany([bookingA, bookingB].map((_id) => ({ _id, company: owner, createdBy: owner, vehicleId: vehicleA, customerName: "Import fixture", mobileNumber: "9000001001", fromDate: new Date("2026-11-01"), toDate: new Date("2026-11-03"), isDeleted: false })));
  await PaymentHistory.collection.insertMany([...sources.map(({ record }) => record),
    { _id: oid(), company: owner, createdBy: owner, bookingId: bookingB, amount: 99999, paymentMethod: "cash", type: "booking", createdAt, vehicle: { vehicleId: deletedVehicle } }]);
  const before = await PaymentHistory.collection.find({}).sort({ _id: 1 }).toArray();

  for (const { name, record, expected } of sources) await t.test(`${name}: authenticated HTTP 200 with the correct amount and allocation`, async () => {
    const response = await getImport();
    assert.equal(response.status, 200, response.json.error || response.json.message);
    const row = response.json.payments.find((payment) => payment._id === String(record._id));
    assert.ok(row);
    assert.equal(row.amount, expected.amount);
    assert.equal(row.paymentMethod, expected.method);
    assert.deepEqual([row.paymentBreakdown.cash, row.paymentBreakdown.phonePe, row.paymentBreakdown.razorpay], expected.breakdown);
    assert.deepEqual([row.channelSplit.cash, row.channelSplit.phonepe, row.channelSplit.razorpay, row.channelSplit.unspecified], expected.split);
    assert.equal(row.bookingId, String(record.bookingId));
    assert.equal(row.type, record.type);
  });

  await t.test("response structure keeps booking/customer snapshots, collection dates and creation dates", async () => {
    const response = await getImport();
    const row = response.json.payments.find((payment) => payment._id === String(cash._id));
    assert.deepEqual(Object.keys(row).sort(), ["_id", "vehicleId", "vehicle", "amount", "type", "paymentMethod", "paymentBreakdown", "channelSplit", "upiLast4", "isCollected", "collectedAmount", "collectedPhonePe", "collectionHistory", "bookingId", "booking", "customer", "note", "createdAt"].sort());
    assert.deepEqual(row.customer, cash.customer);
    assert.equal(row.vehicleId, String(vehicleA));
    assert.equal(row.booking.fromDate, cash.booking.fromDate.toISOString());
    assert.equal(row.booking.toDate, cash.booking.toDate.toISOString());
    assert.equal(row.booking.bookingAmount, 1000);
    assert.equal(row.createdAt, createdAt.toISOString());
    assert.equal(row.collectionHistory[0].collectedAt, collectedAt.toISOString());
    assert.equal(row.collectionHistory[0].amount, 250);
    assert.equal(row.collectedAmount, 250);
    const optional = response.json.payments.find((payment) => payment._id === String(noSnapshots._id));
    assert.deepEqual(optional.customer, { fullName: "", mobileNumber: "" });
    assert.deepEqual(optional.booking, { fromDate: null, toDate: null, bookingAmount: 0 });
    assert.deepEqual(optional.collectionHistory, []);
  });

  await t.test("multiple booking payments and duplicate links yield unique receipts and unchanged Revenue totals", async () => {
    const response = await getImport();
    assert.equal(response.json.count, sources.length);
    assert.equal(new Set(response.json.payments.map(({ _id }) => _id)).size, sources.length);
    assert.equal(new Set(response.json.payments.map(({ bookingId }) => bookingId)).size, 2);
    assert.equal(response.json.payments.reduce((sum, payment) => sum + payment.amount, 0), 5775);
    const normalized = normalizeData({ vehicles: [{ _id: String(vehicleA), pricePerDay: 0 }], payments: response.json.payments });
    const report = buildReport(normalized, { from: "2026-10-01", to: "2026-10-31" });
    assert.equal(report.summary.gross, 5725);
    assert.equal(report.summary.refunds, 50);
    assert.equal(report.summary.net, 5675);
    assert.equal(response.json.payments.find(({ _id }) => _id === String(refund._id)).amount, 50);
  });

  await t.test("empty date results remain HTTP 200 and GET requests never modify payment records", async () => {
    const result = await api("GET", "/dashboard/payments/import?from=2026-10-23&to=2026-10-23");
    assert.equal(result.status, 200);
    assert.equal(result.json.hasPayments, false);
    assert.deepEqual(result.json.payments, []);
    assert.equal(result.json.count, 0);
    assert.deepEqual(await PaymentHistory.collection.find({}).sort({ _id: 1 }).toArray(), before);
  });
});
