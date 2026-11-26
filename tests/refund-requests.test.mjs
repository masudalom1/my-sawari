import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  client,
  createUserAndLogin,
  dayFromToday,
} from "./helpers/harness.mjs";

let ctx;
let api;
let models;
let vehicleId;
let bookingSequence = 0;

before(async () => {
  ctx = await startTestApp();
  const { token } = await createUserAndLogin(ctx.base);
  api = client(ctx.base, token);
  models = {
    Booking: (await import("../src/models/booking.model.js")).default,
    Handover: (await import("../src/models/handover.model.js")).default,
    PaymentHistory: (await import("../src/models/paymentHistory.model.js")).default,
    RefundRequest: (await import("../src/models/refundRequest.model.js")).default,
  };
  await models.RefundRequest.createIndexes();
  await models.PaymentHistory.createIndexes();

  const created = await api("POST", "/vehicles/create", {
    vehicleName: "Refund Request Test Car",
    vehicleNumber: "KA01RF1001",
    manufacturer: "Maruti",
    fuelType: "Petrol",
    transmission: "Manual",
    seatingCapacity: 5,
  });
  assert.equal(created.status, 201, created.json.message);
  vehicleId = created.json.data._id;
  const priced = await api("PUT", `/vehicles/update/${vehicleId}`, {
    pricePerDay: 1000,
  });
  assert.equal(priced.status, 200, priced.json.message);
});

after(async () => {
  await ctx?.stop();
});

// Each global-report scenario gets an independent test-only refund collection.
beforeEach(async () => { await models.RefundRequest.deleteMany({}); });

test("status and literal search combine before stable pagination across all authorized rows", async () => {
  const login = await createUserAndLogin(ctx.base, { businessName: "Refund Pagination" });
  const User = (await import("../src/models/user.model.js")).default;
  const owner = await User.findOne({ email: login.email });
  const scoped = client(ctx.base, login.token);
  const createdAt = new Date("2026-11-01T12:00:00Z");
  const rows = Array.from({ length: 27 }, (_, index) => ({
    company: owner._id, amount: index + 1, customerName: `Phase3 Customer ${index}`,
    customerMobile: `987660${String(index).padStart(4, "0")}`, upiId: `phase3-${index}@bank`,
    customerUpiId: `alternate-${index}@bank`, transactionReference: `REFERENCE-${index}`, utr: `UTR-${index}`,
    status: ["pending", "Approved", "refunded", "Rejected"][index % 4], createdAt,
    requestedBy: owner._id,
    statusHistory: [{ status: "pending", by: null, byName: `Initial Requester ${index}`, at: createdAt },
      { status: "approved", by: null, byName: `Later Operator ${index}`, at: createdAt }],
  }));
  const inserted = await models.RefundRequest.collection.insertMany(rows);
  const extraRows = [
    { company: new ctx.mongoose.Types.ObjectId(), amount: 2, customerName: "Other company", status: "pending", createdAt },
    { company: null, amount: 3, customerName: "No company", status: "pending", createdAt },
  ];
  await models.RefundRequest.collection.insertMany(extraRows);
  const ids = (await models.RefundRequest.find().sort({ createdAt: -1, _id: -1 }).select("_id").lean()).map(row => String(row._id));
  const all = await scoped("GET", "/refund-requests");
  assert.equal(all.status, 200, all.json.message);
  assert.equal(all.json.data.length, 20);
  assert.equal(all.json.pagination.total, 29);
  assert.equal(all.json.pagination.totalPages, 2);
  const first = await scoped("GET", "/refund-requests?limit=5&page=1");
  const second = await scoped("GET", "/refund-requests?limit=5&page=2");
  assert.deepEqual(first.json.data.map(row => row._id), ids.slice(0, 5));
  assert.deepEqual(second.json.data.map(row => row._id), ids.slice(5, 10));
  assert.equal(new Set([...first.json.data, ...second.json.data].map(row => row._id)).size, 10);
  for (const status of ["Pending", "Approved", "Refunded", "Rejected"]) {
    const filtered = await scoped("GET", `/refund-requests?status=${status}&limit=100`);
    assert.equal(filtered.status, 200, filtered.json.message);
    assert.equal(filtered.json.pagination.total, [...rows, ...extraRows].filter(row => row.status.toLowerCase() === status.toLowerCase()).length);
    assert.ok(filtered.json.data.every(row => row.status === status));
    assert.deepEqual(filtered.json.summary, all.json.summary);
  }
  // The oldest row is beyond page one, and each alias must be searchable.
  for (const term of ["Phase3 Customer 0", "9876600000", "phase3-0@bank", "alternate-0@bank", "REFERENCE-0", "UTR-0", "Initial Requester 0"]) {
    const result = await scoped("GET", `/refund-requests?status=Pending&limit=1&q=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200, result.json.message);
    assert.deepEqual(result.json.data.map(row => row._id), [String(inserted.insertedIds[0])]);
    assert.equal(result.json.pagination.total, 1);
    assert.deepEqual(result.json.summary, all.json.summary);
    const wrongStatus = await scoped("GET", `/refund-requests?status=Rejected&q=${encodeURIComponent(term)}`);
    assert.equal(wrongStatus.json.pagination.total, 0);
  }
  for (const term of ["Later Operator", "phase3-[0]@bank", "not-a-match"]) {
    const empty = await scoped("GET", `/refund-requests?q=${encodeURIComponent(term)}`);
    assert.equal(empty.json.pagination.total, 0);
    assert.deepEqual(empty.json.data, []);
    assert.deepEqual(empty.json.summary, all.json.summary);
  }
  for (const query of ["page=0", "page=-1", "page=1.5", "page=1&page=2", "limit=101", "limit=0", "page=9007199254740992"]) {
    assert.equal((await scoped("GET", `/refund-requests?${query}`)).status, 400, query);
  }

  const bookingId = new ctx.mongoose.Types.ObjectId();
  await models.Booking.collection.insertOne({ _id: bookingId, company: owner._id, isDeleted: false,
    customerName: "Saved fallback customer", mobileNumber: "9876699999", vehicleName: "Saved fallback vehicle" });
  const legacy = await models.RefundRequest.collection.insertOne({ company: owner._id, bookingId,
    amount: 3, status: "pending", customerName: "", customerMobile: "", requestedBy: owner._id, createdAt });
  for (const term of ["Saved fallback customer", "9876699999", owner.fullName]) {
    const result = await scoped("GET", `/refund-requests?status=Pending&q=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200, result.json.message);
    assert.deepEqual(result.json.data.map(row => row._id), [String(legacy.insertedId)]);
  }
});

test("request date filters use inclusive IST days before status, search, and pagination without changing summaries", async () => {
  const { toDayKey, dayStartIST, addDayKeys, monthEndKey } = await import("../src/utils/revenue.utils.js");
  const login = await createUserAndLogin(ctx.base, { businessName: "Refund Request Dates" });
  const User = (await import("../src/models/user.model.js")).default;
  const owner = await User.findOne({ email: login.email });
  const scoped = client(ctx.base, login.token);
  const today = toDayKey(new Date());
  const start = dayStartIST(today), tomorrow = dayStartIST(addDayKeys(today, 1));
  const monthStart = dayStartIST(`${today.slice(0, 7)}-01`);
  const nextMonth = dayStartIST(addDayKeys(monthEndKey(today), 1));
  const instants = [new Date(+start - 1), start, new Date(+start + 1), new Date(+tomorrow - 1), tomorrow,
    new Date(+monthStart - 1), monthStart, new Date(+nextMonth - 1), nextMonth,
    new Date("2024-02-28T18:30:00Z"), new Date("2024-02-29T18:29:59.999Z"), new Date("2024-02-29T18:30:00Z")];
  const rows = instants.map((createdAt, index) => ({ company: owner._id, createdAt,
    customerName: `Date match ${index}`, amount: index + 1, status: index === 2 ? "approved" : "pending",
    // Request date filtering must not use requester history or payout date.
    statusHistory: [{ status: "pending", byName: "Date requester", at: new Date("2000-01-01") }] }));
  rows.push({ company: owner._id, amount: 700, status: "refunded", refundedAt: start, createdAt: new Date("2000-01-01") });
  const inserted = await models.RefundRequest.collection.insertMany(rows);
  const all = await scoped("GET", "/refund-requests");
  const allDates = await scoped("GET", "/refund-requests?period=all");
  assert.equal(allDates.status, 200, allDates.json.message);
  assert.deepEqual(allDates.json, all.json, "All dates restores the default date view");
  const check = async (query, from, until) => {
    const result = await scoped("GET", `/refund-requests?${query}&limit=100`);
    assert.equal(result.status, 200, result.json.message);
    const expected = rows.map((row, index) => ({ ...row, _id: String(inserted.insertedIds[index]) }))
      .filter(row => +row.createdAt >= +from && +row.createdAt < +until)
      .sort((a, b) => +b.createdAt - +a.createdAt || b._id.localeCompare(a._id));
    assert.deepEqual(result.json.data.map(row => row._id), expected.map(row => row._id), query);
    assert.deepEqual(result.json.summary, all.json.summary, query);
    return expected;
  };
  await check("period=today", start, tomorrow);
  await check("period=yesterday", dayStartIST(addDayKeys(today, -1)), start);
  await check("period=month", monthStart, nextMonth);
  await check(`period=custom&startDate=${today}&endDate=${today}`, start, tomorrow);
  await check(`period=custom&startDate=${addDayKeys(today, -1)}&endDate=${today}`, dayStartIST(addDayKeys(today, -1)), tomorrow);
  await check("period=custom&startDate=2024-02-29&endDate=2024-02-29", dayStartIST("2024-02-29"), dayStartIST("2024-03-01"));
  const combined = await scoped("GET", `/refund-requests?period=today&status=Pending&q=Date%20match&limit=1&page=2`);
  const expectedPending = rows.map((row, index) => ({ ...row, _id: String(inserted.insertedIds[index]) }))
    .filter(row => row.status === "pending" && +row.createdAt >= +start && +row.createdAt < +tomorrow)
    .sort((a, b) => +b.createdAt - +a.createdAt || b._id.localeCompare(a._id));
  assert.equal(combined.json.pagination.total, expectedPending.length);
  assert.deepEqual(combined.json.data.map(row => row._id), expectedPending.slice(1, 2).map(row => row._id));
  assert.deepEqual(combined.json.summary, all.json.summary);
  const empty = await scoped("GET", "/refund-requests?period=custom&startDate=1999-01-01&endDate=1999-01-02");
  assert.equal(empty.json.pagination.total, 0);
  assert.deepEqual(empty.json.summary, all.json.summary);
  for (const query of ["period=unknown", "period=today&period=month", "period=custom", "period=custom&startDate=2026-11-01",
    "period=custom&startDate=2026-11-02&endDate=2026-11-01", "period=custom&startDate=2026-02-29&endDate=2026-03-01",
    "period=custom&startDate=2026-2-01&endDate=2026-03-01", "period=custom&startDate=2026-11-01&startDate=2026-11-02&endDate=2026-11-03",
    "period=today&startDate=2026-11-01", "startDate=2026-11-01&endDate=2026-11-02"]) {
    assert.equal((await scoped("GET", `/refund-requests?${query}`)).status, 400, query);
  }
});

test("summary periods use recorded completion times in IST independently of filters and pages", async () => {
  const { toDayKey, dayStartIST, addDayKeys } = await import("../src/utils/revenue.utils.js");
  const login = await createUserAndLogin(ctx.base, { businessName: "Refund Summary Boundaries" });
  const User = (await import("../src/models/user.model.js")).default;
  const owner = await User.findOne({ email: login.email });
  const scoped = client(ctx.base, login.token);
  const today = toDayKey(new Date());
  const todayStart = dayStartIST(today), tomorrowStart = dayStartIST(addDayKeys(today, 1));
  const monthStart = dayStartIST(`${today.slice(0, 7)}-01`);
  const [year, month] = today.slice(0, 7).split("-").map(Number);
  const nextMonthStart = dayStartIST(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10));
  const rows = [
    { amount: 11, status: "refunded", refundedAt: todayStart },
    { amount: 13, status: "Refunded", refundedAt: tomorrowStart },
    { amount: 17, status: "refunded", statusHistory: [{ status: "refunded", at: new Date(+todayStart + 1000) }] },
    { amount: 19, status: "refunded", refundedAt: new Date(+todayStart - 1) },
    { amount: 23, status: "Refunded", refundedAt: new Date(+monthStart - 1) },
    { amount: 29, status: "refunded" },
    { amount: 31, status: "pending" }, { amount: 37, status: "Approved" },
    { amount: 41, status: "refunded", refundedAt: monthStart },
    { amount: 43, status: "refunded", refundedAt: nextMonthStart },
    { amount: 47, status: "refunded", refundedAt: new Date(+todayStart - 1), statusHistory: [{ status: "refunded", at: todayStart }] },
    { amount: 53, status: "Rejected", refundedAt: todayStart },
  ];
  rows.push({ company: new ctx.mongoose.Types.ObjectId(), amount: 9999, status: "refunded", refundedAt: todayStart });
  await models.RefundRequest.collection.insertMany(rows.map(row => ({ ...row, company: row.company || owner._id, createdAt: new Date() })));
  const expectedIn = (start, end) => rows.filter(row => {
    const at = row.refundedAt || row.statusHistory?.[0]?.at;
    return row.status.toLowerCase() === "refunded" && at && +at >= +start && +at < +end;
  });
  const expected = {
    refundedToday: { amount: expectedIn(todayStart, tomorrowStart).reduce((sum, row) => sum + row.amount, 0), count: expectedIn(todayStart, tomorrowStart).length },
    thisMonth: { amount: expectedIn(monthStart, nextMonthStart).reduce((sum, row) => sum + row.amount, 0), count: expectedIn(monthStart, nextMonthStart).length },
    toBePaid: { amount: 68, count: 2 },
  };
  for (const query of ["", "?status=Pending&limit=1", "?status=Refunded&limit=2&page=2", "?status=Rejected&q=not-found", "?page=99"]) {
    const result = await scoped("GET", `/refund-requests${query}`);
    assert.equal(result.status, 200, result.json.message);
    assert.deepEqual(result.json.summary, expected, query);
  }
});

async function createBooking({ bookingAmount = 500 } = {}) {
  bookingSequence += 1;
  const offset = bookingSequence * 4;
  const response = await api("POST", "/leads/create", {
    customerName: `Refund Customer ${bookingSequence}`,
    mobileNumber: `9876502${String(bookingSequence).padStart(3, "0")}`,
    vehicleId,
    vehicleType: "car",
    fromDate: dayFromToday(offset),
    toDate: dayFromToday(offset + 2),
    pickupTime: "10:00 AM",
    dropTime: "10:00 AM",
    flexibleTime: true,
    bookingAmount,
    paymentMethod: "cash",
    paymentDate: dayFromToday(-1),
    paymentTime: "14:35",
  });
  assert.equal(response.status, 201, response.json.message);
  return response.json.booking;
}

test("refund handover picker resolves legacy Booking.handover links and returns positive balances", async () => {
  const booking = await createBooking();
  const handover = await models.Handover.create({
    company: booking.company,
    createdBy: booking.createdBy,
    customer: {
      fullName: booking.customerName,
      mobileNumber: booking.mobileNumber,
      destination: "Mysore",
    },
    identity: { aadhaarNumber: "111122223333", drivingLicenseNumber: "KA0520200002" },
    vehicle: {
      vehicleId,
      vehicleName: booking.vehicleName,
      vehicleNumber: booking.vehicleNumber,
    },
    trip: {
      numberOfDays: 2,
      pickupDateTime: new Date(booking.fromDate),
      dropDateTime: new Date(booking.toDate),
    },
    payment: {
      totalFare: booking.bookingAmount,
      totalAmount: booking.bookingAmount,
      amountReceivedNow: 0,
      paymentMethod: "cash",
    },
    bookingStatus: "confirmed",
    handoverStatus: "active",
  });
  await models.Booking.updateOne(
    { _id: booking._id },
    { $set: { handover: handover._id } },
  );
  // Older handovers can be associated through Booking.handover only.
  await models.Handover.updateOne(
    { _id: handover._id },
    { $unset: { bookingId: "" } },
  );

  const options = await api("GET", "/refund-requests/options");
  assert.equal(options.status, 200, options.json.message);
  const row = options.json.handovers.find((item) => item._id === String(handover._id));
  assert.ok(row, "picker should include the handover shown by the Handover screen");
  assert.equal(row.bookingId, String(booking._id));
  assert.ok(row.refundableAmount > 0);

  const created = await api("POST", "/refund-requests", {
    idempotencyKey: "legacy-handover-refund-0001",
    handoverId: String(handover._id),
    bookingId: String(booking._id),
    customerMobile: booking.mobileNumber,
    amount: 25,
    method: "cash",
    reason: "Security deposit return",
  });
  assert.equal(created.status, 201, created.json.message);
  assert.equal(created.json.data.bookingId, String(booking._id));
});

test("manual requests reserve booking balance and record one completed refund", async () => {
  const booking = await createBooking();
  const options = await api("GET", "/refund-requests/options");
  assert.equal(options.status, 200, options.json.message);
  assert.ok(
    options.json.customers.some(
      (customer) => customer.mobileNumber === booking.mobileNumber,
    ),
  );
  assert.ok(
    options.json.bookings.some(
      (option) => String(option._id) === String(booking._id),
    ),
  );

  const payload = {
    idempotencyKey: "manual-refund-create-0001",
    customerMobile: booking.mobileNumber,
    bookingId: String(booking._id),
    amount: 400,
    reason: "Customer refund approved",
    method: "gpay",
    customerUpiId: "customer@okbank",
    proofImageUrl: "https://images.example.test/customer-proof.png",
  };
  const [created, retry] = await Promise.all([
    api("POST", "/refund-requests", payload),
    api("POST", "/refund-requests", payload),
  ]);
  assert.ok([200, 201].includes(created.status), created.json.message);
  assert.ok([200, 201].includes(retry.status), retry.json.message);
  assert.equal(
    await models.RefundRequest.countDocuments({
      requestKey: { $regex: "manual-refund-create-0001$" },
    }),
    1,
  );
  const requestId = created.json.data?._id || retry.json.data?._id;
  const request = await models.RefundRequest.findById(requestId).lean();
  assert.equal(request.source, "Manual");
  assert.equal(request.status, "pending");
  assert.equal(request.refundSource, "manual");
  assert.equal(request.refundType, "upi");
  assert.equal(request.upiId, payload.customerUpiId);
  assert.equal(request.amount, 400);
  assert.equal(request.method, "gpay");
  assert.equal(request.customerUpiId, "customer@okbank");
  assert.equal(request.reason, payload.reason);
  assert.equal(String(request.requestedBy), String(booking.createdBy));
  assert.ok(request.requestedAt instanceof Date);

  const balance = await api(
    "GET",
    `/refund-requests/balance/${booking._id}`,
  );
  assert.equal(balance.status, 200);
  assert.equal(balance.json.reservedAmount, 400);
  assert.equal(balance.json.refundableAmount, 100);

  const pendingCompletion = await api(
    "PATCH",
    `/refund-requests/${requestId}/refunded`,
    {
      completionProofImageUrl: "https://images.example.test/pending-proof.png",
    },
  );
  assert.equal(pendingCompletion.status, 409);
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: requestId,
    }),
    0,
  );

  const overBalance = await api("POST", "/refund-requests", {
    ...payload,
    idempotencyKey: "manual-refund-over-balance",
    amount: 101,
  });
  assert.equal(overBalance.status, 409);
  assert.equal(overBalance.json.balance.refundableAmount, 100);
  assert.equal(
    (await models.Booking.findById(booking._id).lean()).status,
    "confirmed",
  );

  const rejected = await api(
    "PATCH",
    `/refund-requests/${requestId}/reject`,
    { reason: "Insufficient proof" },
  );
  assert.equal(rejected.status, 200, rejected.json.message);
  assert.equal(rejected.json.data.status, "Rejected");
  assert.equal(
    (await models.Booking.findById(booking._id).lean()).status,
    "confirmed",
  );
  const rejectedAgainAsApproved = await api(
    "PATCH",
    `/refund-requests/${requestId}/approve`,
  );
  assert.equal(rejectedAgainAsApproved.status, 409);
  const released = await api(
    "GET",
    `/refund-requests/balance/${booking._id}`,
  );
  assert.equal(released.json.reservedAmount, 0);
  assert.equal(released.json.refundableAmount, 500);

  const nextRequest = await api("POST", "/refund-requests", {
    ...payload,
    idempotencyKey: "manual-refund-complete-0002",
    amount: 125,
  });
  assert.equal(nextRequest.status, 201, nextRequest.json.message);
  const nextRequestId = nextRequest.json.data._id;
  const approved = await api(
    "PATCH",
    `/refund-requests/${nextRequestId}/approve`,
  );
  assert.equal(approved.status, 200, approved.json.message);
  assert.equal(approved.json.data.status, "Approved");

  const reusedCustomerEvidence = await api(
    "PATCH",
    `/refund-requests/${nextRequestId}/refunded`,
    { completionProofImageUrl: payload.proofImageUrl },
  );
  assert.equal(reusedCustomerEvidence.status, 400);
  assert.equal(
    (await models.RefundRequest.findById(nextRequestId).lean()).status,
    "Approved",
  );
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: nextRequestId,
      type: "refund",
    }),
    0,
  );

  const completedPayload = {
    completionProofImageUrl: "https://images.example.test/refund-proof.png",
    utr: "UTR-REFUND-125",
  };
  const [completed, completionRetry] = await Promise.all([
    api(
      "PATCH",
      `/refund-requests/${nextRequestId}/refunded`,
      completedPayload,
    ),
    api(
      "PATCH",
      `/refund-requests/${nextRequestId}/refunded`,
      completedPayload,
    ),
  ]);
  assert.equal(completed.status, 200, completed.json.message);
  assert.equal(completed.json.data.status, "Refunded");
  assert.equal(completed.json.data.utr, completedPayload.utr);
  assert.equal(
    completed.json.data.completionProofImageUrl,
    completedPayload.completionProofImageUrl,
  );
  assert.equal(completionRetry.status, 200);
  assert.equal(
    [completed, completionRetry].filter((response) => response.json.replayed).length,
    1,
  );

  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: nextRequestId,
      type: "refund",
    }),
    1,
  );
  const afterRefund = await api(
    "GET",
    `/refund-requests/balance/${booking._id}`,
  );
  assert.equal(afterRefund.json.completedRefundAmount, 125);
  assert.equal(afterRefund.json.reservedAmount, 0);
  assert.equal(afterRefund.json.refundableAmount, 375);

  const list = await api("GET", "/refund-requests");
  assert.equal(list.status, 200, list.json.message);
  assert.equal(list.json.summary.refundedToday.amount, 125);
  assert.equal(list.json.summary.refundedToday.count, 1);
  assert.equal(list.json.summary.thisMonth.amount, 125);
  assert.equal(list.json.summary.toBePaid.amount, 0);
  const listed = list.json.data.find(
    (item) => String(item._id) === String(nextRequestId),
  );
  assert.equal(listed.status, "Refunded");
  assert.equal(listed.source, "Manual");
  assert.equal(listed.customerName, booking.customerName);
  assert.match(listed.requestedBy.fullName, /^Test User/);
  assert.match(listed.approvedBy.fullName, /^Test User/);
  assert.match(listed.refundedBy.fullName, /^Test User/);
  assert.ok(listed.approvedAt);
  assert.ok(listed.refundedAt);
  const rejectAfterRefund = await api(
    "PATCH",
    `/refund-requests/${nextRequestId}/reject`,
    { reason: "Late rejection" },
  );
  assert.equal(rejectAfterRefund.status, 409);
});

test("completion resolves an archived cancelled booking without changing its history and replays once", async () => {
  const booking = await createBooking({ bookingAmount: 700 });
  const cancelled = await api("PUT", `/leads/${booking._id}/cancel`, {
    reason: "Archived cancellation refund", refund: { amount: 700, method: "phonepe" },
  });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  const id = cancelled.json.refundRequest._id;
  assert.equal((await api("PATCH", `/refund-requests/${id}/approve`)).status, 200);
  await models.Booking.updateOne({ _id: booking._id }, { $set: { isDeleted: true } });
  const before = await models.Booking.findById(booking._id).lean();
  assert.equal(before.status, "cancelled");
  // Reproduce the former completion predicate against the actual saved ID.
  assert.equal(await models.Booking.findOne({ _id: booking._id, company: before.company, isDeleted: { $ne: true } }), null);
  assert.ok(await models.Booking.findOne({ _id: booking._id, company: before.company }));
  const payload = {
    completionProofImageUrl: "https://images.example.test/archived-refund.png", utr: "",
    amount: 1, method: "gpay", bookingId: String(new ctx.mongoose.Types.ObjectId()),
    refundedAt: "2000-01-01T00:00:00.000Z",
  };
  const confirmationStartedAt = Date.now();
  const [completed, retry] = await Promise.all([
    api("PATCH", `/refund-requests/${id}/refunded`, payload),
    api("PATCH", `/refund-requests/${id}/refunded`, payload),
  ]);
  assert.equal(completed.status, 200, completed.json.message);
  assert.equal(retry.status, 200, retry.json.message);
  assert.equal([completed, retry].filter(response => response.json.replayed).length, 1);
  const saved = await models.RefundRequest.findById(id).lean();
  assert.equal(saved.status, "Refunded");
  assert.equal(saved.amount, 700);
  assert.equal(saved.method, "phonepe");
  assert.equal(saved.completionProofImageUrl, payload.completionProofImageUrl);
  assert.equal(saved.transactionReference, "");
  assert.equal(saved.statusHistory.filter(entry => entry.status === "refunded").length, 1);
  assert.equal(saved.statusHistory.find(entry => entry.status === "refunded").at.toISOString(), saved.refundedAt.toISOString());
  assert.ok(saved.refundedAt);
  assert.ok(+saved.refundedAt >= confirmationStartedAt && +saved.refundedAt <= Date.now());
  assert.equal(String(saved.refundedBy), String(saved.approvedBy));
  const completionHistory = saved.statusHistory.find(entry => entry.status === "refunded");
  assert.equal(String(completionHistory.by), String(saved.refundedBy));
  assert.ok(completionHistory.byName);
  const ledger = await models.PaymentHistory.find({ refundRequestId: id }).lean();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount, 700);
  assert.equal(ledger[0].paymentMethod, "phonepe");
  assert.equal(String(ledger[0].bookingId), booking._id);
  assert.equal(ledger[0].paymentDate.toISOString(), saved.refundedAt.toISOString());
  assert.equal(String(ledger[0].createdBy), String(saved.refundedBy));
  const sequentialRetry = await api("PATCH", `/refund-requests/${id}/refunded`, {
    completionProofImageUrl: "https://images.example.test/retry-must-not-replace-proof.png",
    utr: "RETRY-MUST-NOT-REPLACE-REFERENCE",
  });
  assert.equal(sequentialRetry.status, 200, sequentialRetry.json.message);
  assert.equal(sequentialRetry.json.replayed, true);
  assert.deepEqual(await models.RefundRequest.findById(id).lean(), saved);
  assert.deepEqual(await models.PaymentHistory.find({ refundRequestId: id }).lean(), ledger);
  assert.deepEqual(await models.Booking.findById(booking._id).lean(), before);
});

test("a genuinely missing linked booking keeps the 700 request Approved and creates no accounting entry", async () => {
  const booking = await createBooking({ bookingAmount: 700 });
  const cancelled = await api("PUT", `/leads/${booking._id}/cancel`, {
    refund: { amount: 700, method: "phonepe" },
  });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  const id = cancelled.json.refundRequest._id;
  assert.equal((await api("PATCH", `/refund-requests/${id}/approve`)).status, 200);
  await models.Booking.collection.deleteOne({ _id: new ctx.mongoose.Types.ObjectId(booking._id) });
  const before = await models.RefundRequest.findById(id).lean();
  const response = await api("PATCH", `/refund-requests/${id}/refunded`, {
    completionProofImageUrl: "https://images.example.test/missing-booking-proof.png", utr: "",
  });
  assert.equal(response.status, 409, response.json.message);
  assert.match(response.json.message, /linked booking/i);
  assert.match(response.json.message, /Refund accounting could not be recorded/);
  assert.match(response.json.message, /ledger requires a saved booking.*no standalone accounting path against a refund ID/);
  assert.match(response.json.message, /remains Approved.*administrator.*then retry/i);
  assert.ok(response.json.message.includes(`Refund reference: ${id}`));
  assert.ok(response.json.message.includes(`Linked booking: ${booking._id}`));
  assert.match(response.json.message, /original cancellation and payment records.*restore.*correct.*retry/i);
  assert.deepEqual(await models.RefundRequest.findById(id).lean(), before);
  assert.equal(await models.PaymentHistory.countDocuments({ refundRequestId: id }), 0);
  assert.equal(await models.Booking.countDocuments({ _id: booking._id }), 0);
});

test("a cancellation with no saved booking ID cannot use the unlinked Manual completion path", async () => {
  const booking = await createBooking();
  const request = await models.RefundRequest.create({
    company: booking.company, bookingId: null, amount: 25, refundSource: "cancellation",
    source: "Booking Cancellation", status: "Approved", method: "cash",
  });
  const before = await models.RefundRequest.findById(request._id).lean();
  const response = await api("PATCH", `/refund-requests/${request._id}/refunded`, {
    completionProofImageUrl: "https://images.example.test/no-link.png",
  });
  assert.equal(response.status, 409, response.json.message);
  assert.ok(response.json.message.includes(`Refund reference: ${request._id}`));
  assert.match(response.json.message, /Linked booking: not saved/);
  assert.match(response.json.message, /no standalone accounting path against a refund ID/);
  assert.deepEqual(await models.RefundRequest.findById(request._id).lean(), before);
  assert.equal(await models.PaymentHistory.countDocuments({ refundRequestId: request._id }), 0);
});

test("shared cancellation writer requires a persisted booking and always saves its canonical ID", async () => {
  const { createRefundRequest } = await import("../src/services/createRefundRequest.js");
  const booking = await createBooking();
  const saved = await models.Booking.findById(booking._id).lean();
  const actor = await ctx.mongoose.model("User").findById(saved.createdBy);
  const fakeId = new ctx.mongoose.Types.ObjectId();
  const details = { source: "Booking Cancellation", amount: 5, method: "cash",
    bookingId: fakeId, requestKey: `booking-cancellation:${fakeId}` };
  const request = await createRefundRequest({ booking: { ...saved, bookingId: fakeId }, actor, details });
  assert.equal(String(request.bookingId), booking._id);
  assert.equal(request.requestKey, `booking-cancellation:${booking._id}`);
  assert.equal(String(request.company), String(saved.company));
  const before = await models.RefundRequest.countDocuments({});
  for (const invalid of [undefined, { ...saved, _id: fakeId }, { ...saved, _id: "calendar-event-id" }, { ...saved, company: fakeId }]) {
    await assert.rejects(createRefundRequest({ booking: invalid, actor, details }), error =>
      error.statusCode === 409 && /original saved booking/.test(error.message));
  }
  assert.equal(await models.RefundRequest.countDocuments({}), before);
  assert.deepEqual(await models.Booking.findById(booking._id).lean(), saved);
});

test("completion authorizes the refund independently of the linked booking's company", async () => {
  const booking = await createBooking();
  const cancelled = await api("PUT", `/leads/${booking._id}/cancel`, { refund: { amount: 25, method: "cash" } });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  const id = cancelled.json.refundRequest._id;
  assert.equal((await api("PATCH", `/refund-requests/${id}/approve`)).status, 200);
  const other = await createUserAndLogin(ctx.base, { businessName: "Foreign Refund Archive" });
  const otherUser = await ctx.mongoose.model("User").findOne({ email: other.email });
  await models.Booking.updateOne({ _id: booking._id }, { $set: { company: otherUser._id, isDeleted: true } });
  const foreignBooking = await models.Booking.findById(booking._id).lean();
  const before = await models.RefundRequest.findById(id).lean();
  const staff = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE", businessName: "Refund Action Owner" });
  const User = ctx.mongoose.model("User");
  await User.updateOne({ email: staff.email }, { $set: { createdBy: before.company } });
  const staffUser = await User.findOne({ email: staff.email });
  const policy = await ctx.mongoose.model("RolePermission").create({
    businessName: "Refund Action Owner", role: "BOOKING_EXECUTIVE", updatedBy: before.company,
    permissions: { "page.paymentsHistory.view": true, "page.bookings.edit": false, "page.dashboard.edit": false },
  });
  const staffApi = client(ctx.base, staff.token);
  const payload = { completionProofImageUrl: "https://images.example.test/foreign-proof.png" };
  assert.equal((await staffApi("GET", `/refund-requests/${id}`)).json.data.allowedActions.refund, false);
  assert.equal((await staffApi("PATCH", `/refund-requests/${id}/refunded`, payload)).status, 403);
  assert.deepEqual(await models.RefundRequest.findById(id).lean(), before);
  assert.equal(await models.PaymentHistory.countDocuments({ refundRequestId: id }), 0);
  await ctx.mongoose.model("RolePermission").updateOne({ _id: policy._id }, { $set: { permissions: {
    "page.paymentsHistory.view": true, "page.bookings.edit": true, "page.dashboard.edit": true,
  } } });
  assert.equal((await staffApi("GET", `/refund-requests/${id}`)).json.data.allowedActions.refund, true);
  const completed = await staffApi("PATCH", `/refund-requests/${id}/refunded`, payload);
  assert.equal(completed.status, 200, completed.json.message);
  const saved = await models.RefundRequest.findById(id).lean();
  assert.equal(saved.status, "Refunded");
  assert.equal(String(saved.refundedBy), String(staffUser._id));
  assert.equal(String(saved.company), String(before.company));
  const ledger = await models.PaymentHistory.find({ refundRequestId: id }).lean();
  assert.equal(ledger.length, 1);
  assert.equal(String(ledger[0].company), String(before.company));
  assert.equal(String(ledger[0].bookingId), String(foreignBooking._id));
  const replay = await client(ctx.base, other.token)("PATCH", `/refund-requests/${id}/refunded`, payload);
  assert.equal(replay.status, 200, replay.json.message);
  assert.equal(replay.json.replayed, true);
  assert.deepEqual(await models.RefundRequest.findById(id).lean(), saved);
  assert.deepEqual(await models.PaymentHistory.find({ refundRequestId: id }).lean(), ledger);
  assert.deepEqual(await models.Booking.findById(booking._id).lean(), foreignBooking);
});

test("rejection records its stage and leaves a cancelled booking cancelled", async () => {
  const booking = await createBooking();
  const cancelled = await api("PUT", `/leads/${booking._id}/cancel`, {
    reason: "Customer changed plans",
    refund: {
      amount: 50,
      method: "phonepe",
    },
  });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  const requestId = cancelled.json.refundRequest._id;

  const pendingCompletion = await api(
    "PATCH",
    `/refund-requests/${requestId}/refunded`,
    { completionProofImageUrl: "https://images.example.test/proof.png" },
  );
  assert.equal(pendingCompletion.status, 409);
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: requestId,
      type: "refund",
    }),
    0,
  );

  const reserved = await api(
    "GET",
    `/refund-requests/balance/${booking._id}`,
  );
  assert.equal(reserved.json.reservedAmount, 50);
  assert.equal(reserved.json.refundableAmount, 450);

  const approved = await api(
    "PATCH",
    `/refund-requests/${requestId}/approve`,
  );
  assert.equal(approved.status, 200, approved.json.message);
  const rejectionReason = "Cancelled < 24 hours before pickup";
  const rejected = await api(
    "PATCH",
    `/refund-requests/${requestId}/reject`,
    { reason: rejectionReason },
  );
  assert.equal(rejected.status, 200, rejected.json.message);
  assert.equal(rejected.json.data.status, "Rejected");

  const savedBooking = await models.Booking.findById(booking._id).lean();
  const savedRequest = await models.RefundRequest.findById(requestId).lean();
  assert.equal(savedBooking.status, "cancelled");
  assert.equal(savedBooking.cancellationReason, "Customer changed plans");
  assert.equal(savedRequest.status, "Rejected");
  assert.equal(savedRequest.rejectionReason, rejectionReason);
  assert.equal(String(savedRequest.rejectedBy), String(booking.createdBy));
  assert.ok(savedRequest.rejectedAt instanceof Date);
  const released = await api(
    "GET",
    `/refund-requests/balance/${booking._id}`,
  );
  assert.equal(released.json.reservedAmount, 0);
  assert.equal(released.json.refundableAmount, 500);
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: requestId,
      type: "refund",
    }),
    0,
  );

  const list = await api("GET", "/refund-requests");
  const tracked = list.json.data.find(
    (item) => String(item._id) === String(requestId),
  );
  assert.equal(tracked.status, "Rejected");
  assert.equal(tracked.rejectionReason, rejectionReason);
  assert.match(tracked.rejectedBy.fullName, /^Test User/);
  assert.match(tracked.approvedBy.fullName, /^Test User/);
  assert.ok(tracked.rejectedAt);
  assert.ok(tracked.approvedAt);
  const refundAfterRejection = await api(
    "PATCH",
    `/refund-requests/${requestId}/refunded`,
    { completionProofImageUrl: "https://images.example.test/proof.png" },
  );
  assert.equal(refundAfterRejection.status, 409);
});

test("manual requests without a booking are allowed for existing customers", async () => {
  const booking = await createBooking();
  const response = await api("POST", "/refund-requests", {
    idempotencyKey: "manual-unlinked-request-0003",
    customerMobile: booking.mobileNumber,
    amount: 25,
    reason: "Goodwill adjustment",
    method: "cash",
  });
  assert.equal(response.status, 201, response.json.message);
  assert.equal(response.json.data.source, "Manual");
  assert.equal(response.json.data.bookingId, null);
  assert.equal(response.json.data.customerName, booking.customerName);
});

test("refund completion requires proof but does not require a transaction reference", async () => {
  const booking = await createBooking();
  const created = await api("POST", "/refund-requests", {
    idempotencyKey: "manual-proof-optional-0005",
    customerMobile: booking.mobileNumber,
    amount: 25,
    reason: "Proof requirement test",
    method: "cash",
  });
  assert.equal(created.status, 201, created.json.message);
  const requestId = created.json.data._id;

  const approved = await api(
    "PATCH",
    `/refund-requests/${requestId}/approve`,
  );
  assert.equal(approved.status, 200);

  const missingProof = await api(
    "PATCH",
    `/refund-requests/${requestId}/refunded`,
    { utr: "" },
  );
  assert.equal(missingProof.status, 400);
  assert.equal(
    (await models.RefundRequest.findById(requestId).lean()).status,
    "Approved",
  );

  const completed = await api(
    "PATCH",
    `/refund-requests/${requestId}/refunded`,
    {
      completionProofImageUrl:
        "https://images.example.test/proof-without-utr.png",
    },
  );
  assert.equal(completed.status, 200, completed.json.message);
  assert.equal(completed.json.data.status, "Refunded");
  assert.equal(completed.json.data.utr, "");
  assert.equal(
    completed.json.data.completionProofImageUrl,
    "https://images.example.test/proof-without-utr.png",
  );
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: requestId,
    }),
    0,
    "unlinked manual requests do not create booking ledger entries",
  );
});

test("concurrent linked manual requests cannot reserve more than the balance", async () => {
  const booking = await createBooking();
  const makeRequest = (idempotencyKey) =>
    api("POST", "/refund-requests", {
      idempotencyKey,
      customerMobile: booking.mobileNumber,
      bookingId: String(booking._id),
      amount: 300,
      reason: "Concurrent balance test",
      method: "cash",
    });

  const responses = await Promise.all([
    makeRequest("manual-concurrent-request-0001"),
    makeRequest("manual-concurrent-request-0002"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  );
  const balance = await api(
    "GET",
    `/refund-requests/balance/${booking._id}`,
  );
  assert.equal(balance.json.reservedAmount, 300);
  assert.equal(balance.json.refundableAmount, 200);
});

test("failed refund ledger writes leave the request approved", async () => {
  const booking = await createBooking();
  const request = await api("POST", "/refund-requests", {
    idempotencyKey: "manual-refund-atomicity-0004",
    customerMobile: booking.mobileNumber,
    bookingId: String(booking._id),
    amount: 25,
    reason: "Atomicity test",
    method: "phonepe",
  });
  assert.equal(request.status, 201);

  const approval = await api(
    "PATCH",
    `/refund-requests/${request.json.data._id}/approve`,
    {},
  );
  assert.equal(approval.status, 200);

  const beforeCompletion = await models.RefundRequest.findById(request.json.data._id).lean();
  const originalCreate = models.PaymentHistory.create;
  models.PaymentHistory.create = async () => {
    throw new Error("Refund ledger write failed");
  };
  let response;
  try {
    response = await api(
      "PATCH",
      `/refund-requests/${request.json.data._id}/refunded`,
      {
        completionProofImageUrl:
          "https://images.example.test/refund-proof.png",
      },
    );
  } finally {
    models.PaymentHistory.create = originalCreate;
  }

  assert.equal(response.status, 500);
  const saved = await models.RefundRequest.findById(request.json.data._id).lean();
  assert.equal(saved.status, "Approved");
  assert.deepEqual(saved, beforeCompletion);
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: request.json.data._id,
    }),
    0,
  );
  const originalSave = models.RefundRequest.prototype.save;
  models.RefundRequest.prototype.save = async function (...args) {
    if (String(this._id) === String(saved._id)) throw new Error("Refund status write failed");
    return originalSave.apply(this, args);
  };
  try {
    const failedStatus = await api("PATCH", `/refund-requests/${saved._id}/refunded`, {
      completionProofImageUrl: "https://images.example.test/refund-proof.png",
    });
    assert.equal(failedStatus.status, 500);
  } finally { models.RefundRequest.prototype.save = originalSave; }
  assert.deepEqual(await models.RefundRequest.findById(saved._id).lean(), saved);
  assert.equal(await models.PaymentHistory.countDocuments({ refundRequestId: saved._id }), 0);
  const retried = await api("PATCH", `/refund-requests/${saved._id}/refunded`, {
    completionProofImageUrl: "https://images.example.test/refund-proof.png",
  });
  assert.equal(retried.status, 200, retried.json.message);
  assert.equal(await models.PaymentHistory.countDocuments({ refundRequestId: saved._id }), 1);
});

test("legacy refund documents remain readable without new contract fields or rewrites", async () => {
  const booking = await createBooking();
  const savedBooking = await models.Booking.findById(booking._id).lean();
  const legacyDocuments = ["Pending", "Approved", "Refunded", "Rejected"].map((status) => ({
    company: savedBooking.company,
    bookingId: savedBooking._id,
    source: "Booking Cancellation",
    customerName: booking.customerName,
    customerMobile: booking.mobileNumber,
    amount: 25,
    method: "phonepe",
    customerUpiId: "legacy@bank",
    reason: "Historical refund",
    status,
    requestedBy: savedBooking.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  // Bypass schema defaults to reproduce documents saved before Phase 1.
  const inserted = await models.RefundRequest.collection.insertMany(legacyDocuments);
  const before = await models.RefundRequest.collection.find({
    _id: { $in: Object.values(inserted.insertedIds) },
  }).sort({ _id: 1 }).toArray();
  const response = await api("GET", "/refund-requests");
  assert.equal(response.status, 200, response.json.message);
  for (const legacy of before) {
    assert.equal(Object.hasOwn(legacy, "refundType"), false);
    assert.equal(Object.hasOwn(legacy, "statusHistory"), false);
    const matches = response.json.data.filter((item) => String(item._id) === String(legacy._id));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, legacy.status);
    assert.equal(matches[0].method, "phonepe");
    assert.equal(matches[0].customerUpiId, "legacy@bank");
    assert.equal(matches[0].amount, 25);
    assert.equal(matches[0].vehicleName, booking.vehicleName);
    assert.equal(matches[0].bookingAmount, booking.bookingAmount);
    assert.equal(String(matches[0].bookingId), String(booking._id));
  }
  assert.deepEqual(await models.RefundRequest.collection.find({
    _id: { $in: Object.values(inserted.insertedIds) },
  }).sort({ _id: 1 }).toArray(), before);
});

test("canonical legacy rows use saved history names, generic UPI, and history dates", async () => {
  const booking = await createBooking();
  const savedBooking = await models.Booking.findById(booking._id).lean();
  const at = new Date();
  const inserted = await models.RefundRequest.collection.insertOne({
    company: savedBooking.company, bookingId: savedBooking._id,
    amount: 35, bookingAmount: 0, refundSource: "cancellation", refundType: "upi",
    upiId: "historical@bank", transactionReference: "LEGACY-REF-35", status: "pending",
    accountDetails: { accountNumber: "123456789", ifscCode: "TEST0001234", accountHolderName: "Saved Customer", bankName: "Test Bank" },
    statusHistory: [{ status: "pending", by: null, byName: "Saved requester", note: "Old cancellation", at }],
    createdAt: at, updatedAt: at,
  });
  const id = inserted.insertedId;
  const before = await models.RefundRequest.collection.findOne({ _id: id });
  const response = await api("GET", `/refund-requests/${id}`);
  assert.equal(response.status, 200, response.json.message);
  const view = response.json.data;
  assert.equal(view.requestedBy._id, null);
  assert.equal(view.requestedBy.fullName, "Saved requester");
  assert.equal(view.requestedAt, at.toISOString());
  assert.equal(view.method, "upi");
  assert.equal(view.customerUpiId, "historical@bank");
  assert.equal(view.utr, "LEGACY-REF-35");
  assert.equal(view.source, "Booking Cancellation");
  assert.equal(view.bookingAmount, 0);
  assert.equal(view.booking.bookingCode, savedBooking.bookingCode || "");
  assert.equal(view.booking._id, booking._id);
  assert.equal(view.customerName, booking.customerName);
  assert.equal(view.accountDetails.bankName, "Test Bank");
  const search = await api("GET", "/refund-requests?q=Saved%20requester&status=pending");
  assert.equal(search.status, 200);
  assert.equal(search.json.data.filter((row) => row._id === String(id)).length, 1);
  assert.deepEqual(await models.RefundRequest.collection.findOne({ _id: id }), before);
  const approved = await api("PATCH", `/refund-requests/${id}/approve`);
  assert.equal(approved.status, 200, approved.json.message);
  assert.equal(approved.json.data.statusHistory[0].by, null);
  assert.equal(approved.json.data.statusHistory[1].byName.startsWith("Test User"), true);

  const summaryBefore = await api("GET", "/refund-requests");
  await models.RefundRequest.collection.insertOne({
    company: savedBooking.company, amount: 7, refundType: "upi", status: "refunded",
    statusHistory: [{ status: "refunded", by: null, byName: "Historical operator", at }],
    createdAt: at, updatedAt: at,
  });
  const summaryAfter = await api("GET", "/refund-requests");
  assert.equal(summaryAfter.json.summary.refundedToday.amount - summaryBefore.json.summary.refundedToday.amount, 7);
  assert.equal((await api("GET", "/refund-requests?q=first&q=second")).status, 400);
});

test("global reading preserves separate action permissions and cross-company refund authorization", async () => {
  const booking = await createBooking();
  const saved = await models.Booking.findById(booking._id).lean();
  const other = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE", businessName: "Other Refund Tenant" });
  await ctx.mongoose.model("RolePermission").create({
    businessName: "Other Refund Tenant", role: "BOOKING_EXECUTIVE", updatedBy: saved.createdBy,
    permissions: { "page.paymentsHistory.view": true, "page.bookings.edit": true, "page.dashboard.edit": true },
  });
  const otherApi = client(ctx.base, other.token);
  const baseline = await api("GET", "/refund-requests");
  const inserted = await models.RefundRequest.collection.insertOne({
    company: null, bookingId: saved._id, customerName: "Unattributed private customer",
    requestedBy: saved.createdBy,
    statusHistory: [{ status: "pending", by: saved.createdBy, byName: "Saved tenant actor", at: new Date() }],
    amount: 99999, status: "pending", refundType: "upi", upiId: "secret@bank",
    proofImageUrl: "https://res.cloudinary.com/test-cloud/image/upload/private-legacy.png",
  });
  const id = inserted.insertedId;
  const list = await api("GET", "/refund-requests?q=Unattributed");
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.summary.toBePaid.amount, baseline.json.summary.toBePaid.amount + 99999);
  assert.equal((await api("GET", `/refund-requests/${id}`)).status, 200);
  const foreignView = await otherApi("GET", `/refund-requests/${id}`);
  assert.equal(foreignView.status, 200);
  assert.equal(foreignView.json.data.canManage, false);
  for (const action of ["approve", "reject"]) {
    const result = await otherApi("PATCH", `/refund-requests/${id}/${action}`, {
      reason: "Not allowed", completionProofImageUrl: "https://images.example.test/proof.png",
    });
    assert.equal(result.status, 404, result.json.message);
  }
  const pendingRefund = await otherApi("PATCH", `/refund-requests/${id}/refunded`, {
    completionProofImageUrl: "https://images.example.test/proof.png",
  });
  assert.equal(pendingRefund.status, 409, pendingRefund.json.message);
  const otherUser = await ctx.mongoose.model("User").findOne({ email: other.email });
  const foreign = await models.RefundRequest.collection.insertOne({
    company: otherUser._id, bookingId: saved._id,
    amount: 10, status: "pending", refundType: "upi",
  });
  const detail = await otherApi("GET", `/refund-requests/${foreign.insertedId}`);
  assert.equal(detail.status, 200, detail.json.message);
  assert.equal(detail.json.data.booking._id, booking._id);
  assert.equal(detail.json.data.customerName, booking.customerName);
  assert.equal((await api("GET", `/refund-requests/${foreign.insertedId}`)).status, 200);
  const otherList = await otherApi("GET", "/refund-requests?q=Unattributed");
  assert.equal(otherList.json.data.length, 1);
  assert.equal((await api("PATCH", `/refund-requests/${id}/approve`)).status, 200);
  assert.equal((await models.RefundRequest.findById(id)).company, null, "protected admin approval preserves legacy ownership");
  const crossCompanyRefund = await otherApi("PATCH", `/refund-requests/${id}/refunded`, {
    completionProofImageUrl: "https://images.example.test/cross-company-proof.png",
  });
  assert.equal(crossCompanyRefund.status, 200, crossCompanyRefund.json.message);
  const ledger = await models.PaymentHistory.findOne({ refundRequestId: id }).lean();
  assert.equal(String(ledger.company), String(saved.company), "refund accounting uses the refund or booking company");
  assert.equal(String(ledger.bookingId), String(saved._id));
});

test("protected admin grants expose the same actions in list, details, and cross-company endpoints", async () => {
  const booking = await createBooking();
  const cancelled = await api("PUT", `/leads/${booking._id}/cancel`, { refund: { amount: 25, method: "cash" } });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  const id = cancelled.json.refundRequest._id;
  const original = await models.RefundRequest.findById(id).lean();
  const admin = await createUserAndLogin(ctx.base, { businessName: "Refund Global Admin" });
  const global = client(ctx.base, admin.token);
  const expected = { approve: true, reject: true, refund: false };
  const list = await global("GET", "/refund-requests?status=Pending");
  const detail = await global("GET", `/refund-requests/${id}`);
  assert.equal(list.status, 200, list.json.message);
  assert.equal(detail.status, 200, detail.json.message);
  assert.equal(list.json.data[0].canManage, true);
  assert.deepEqual(list.json.data[0].allowedActions, expected);
  assert.deepEqual(detail.json.data.allowedActions, expected);
  const approved = await global("PATCH", `/refund-requests/${id}/approve`);
  assert.equal(approved.status, 200, approved.json.message);
  const approvedDetail = await global("GET", `/refund-requests/${id}`);
  assert.deepEqual(approvedDetail.json.data.allowedActions, { approve: false, reject: true, refund: true });
  const paid = await global("PATCH", `/refund-requests/${id}/refunded`, { completionProofImageUrl: "https://images.example.test/admin-refund.png" });
  assert.equal(paid.status, 200, paid.json.message);
  const ledger = await models.PaymentHistory.findOne({ refundRequestId: id }).lean();
  assert.equal(String(ledger.company), String(original.company), "payout accounting retains the refund's company");
  assert.equal(String(ledger.createdBy), String((await ctx.mongoose.model("User").findOne({ email: admin.email }))._id));
  const terminal = await global("GET", `/refund-requests/${id}`);
  assert.deepEqual(terminal.json.data.allowedActions, { approve: false, reject: false, refund: false });

  const legacy = await models.RefundRequest.collection.insertOne({ company: null, amount: 5, status: "pending",
    bookingId: new ctx.mongoose.Types.ObjectId(), refundSource: "manual", statusHistory: [] });
  const legacyDetail = await global("GET", `/refund-requests/${legacy.insertedId}`);
  assert.deepEqual(legacyDetail.json.data.allowedActions, expected, "absent booking does not hide approval/rejection");
  const legacyApprove = await global("PATCH", `/refund-requests/${legacy.insertedId}/approve`);
  assert.equal(legacyApprove.status, 200, legacyApprove.json.message);
  const rejected = await global("PATCH", `/refund-requests/${legacy.insertedId}/reject`, { reason: "Test withdrawal" });
  assert.equal(rejected.status, 200, rejected.json.message);
  assert.equal((await models.RefundRequest.findById(legacy.insertedId)).company, null, "do not invent legacy ownership");
});

test("company-independent refund pagination includes every row, including null company and absent bookings", async () => {
  const ownerLogin = await createUserAndLogin(ctx.base, { businessName: "Refund Ownership Matrix" });
  const otherLogin = await createUserAndLogin(ctx.base, { businessName: "Foreign Ownership Matrix" });
  const User = ctx.mongoose.model("User");
  const owner = await User.findOne({ email: ownerLogin.email });
  const other = await User.findOne({ email: otherLogin.email });
  const scoped = client(ctx.base, ownerLogin.token);
  const archived = new ctx.mongoose.Types.ObjectId();
  const foreign = new ctx.mongoose.Types.ObjectId();
  await models.Booking.collection.insertMany([
    { _id: archived, company: owner._id, isDeleted: true, status: "cancelled", customerName: "Archived enrichment" },
    { _id: foreign, company: other._id, isDeleted: true, status: "cancelled" },
  ]);
  const createdAt = new Date("2026-11-24T18:30:00.000Z");
  const base = { amount: 5, status: "pending", createdAt, refundSource: "manual", customerName: "Ownership match" };
  const owned = Array.from({ length: 24 }, (_, i) => ({ ...base, company: owner._id,
    bookingId: i % 2 ? archived : new ctx.mongoose.Types.ObjectId() }));
  owned.push({ ...base, company: null, bookingId: archived },
    { ...base, company: null, bookingId: new ctx.mongoose.Types.ObjectId(), createdBy: owner._id });
  const inserted = await models.RefundRequest.collection.insertMany(owned);
  await models.RefundRequest.collection.insertMany([
    { ...base, company: null, bookingId: foreign, createdBy: owner._id }, // conflicting booking wins
    { ...base, company: other._id, bookingId: archived, createdBy: owner._id }, // explicit company wins
    { ...base, company: null, bookingId: new ctx.mongoose.Types.ObjectId(), createdBy: other._id },
    { ...base, company: null, requestedBy: owner._id, statusHistory: [{ status: "pending", by: owner._id, byName: owner.fullName }] },
  ]);
  const expectedIds = (await models.RefundRequest.find().sort({ createdAt: -1, _id: -1 }).select("_id").lean()).map(row => String(row._id));
  const databaseCount = await models.RefundRequest.countDocuments({});
  assert.equal(databaseCount, 30);
  const first = await scoped("GET", "/refund-requests?status=All&period=all&q=&page=1&limit=20");
  const second = await scoped("GET", "/refund-requests?status=All&period=all&q=&page=2&limit=20");
  assert.equal(first.status, 200, first.json.message);
  assert.equal(second.status, 200, second.json.message);
  assert.equal(first.json.pagination.total, databaseCount);
  assert.equal(second.json.pagination.total, databaseCount);
  assert.deepEqual([...first.json.data, ...second.json.data].map(row => row._id), expectedIds);
  assert.deepEqual(first.json.summary, second.json.summary);
  assert.equal(first.json.summary.toBePaid.amount, 150);
  const search = await scoped("GET", "/refund-requests?status=Pending&period=custom&startDate=2026-11-25&endDate=2026-11-25&q=Ownership%20match&limit=7&page=2");
  assert.equal(search.json.pagination.total, databaseCount);
  assert.deepEqual(search.json.data.map(row => row._id), expectedIds.slice(7, 14));
  const enriched = await scoped("GET", "/refund-requests?q=Archived%20enrichment");
  // Snapshot names take precedence; booking enrichment is also available when snapshots are absent.
  assert.equal(enriched.json.pagination.total, 0);
  const archivedDetail = await scoped("GET", `/refund-requests/${inserted.insertedIds[1]}`);
  assert.equal(archivedDetail.json.data.booking.status, "cancelled");
  assert.equal(archivedDetail.json.data.bookingId, String(archived));
  const savedLegacy = await models.RefundRequest.collection.findOne({ _id: inserted.insertedIds[24] });
  assert.equal(savedLegacy.company, null, "listing must not rewrite legacy records");
});

test("authorized older rows retain booking fields, initial history, and manual requests without rewrites", async () => {
  const booking = await createBooking();
  const saved = await models.Booking.findById(booking._id).lean();
  await models.Booking.collection.updateOne({ _id: saved._id }, { $unset: { bookingAmount: "" } });
  const at = new Date("2026-11-20T09:00:00Z");
  const rows = [
    {
      company: saved.company, bookingId: saved._id, amount: 21, status: "pending", refundSource: "cancellation", refundType: "upi",
      statusHistory: [null, { status: "pending", by: null, byName: "Original saved requester", note: "Saved cancellation reason", at },
        { status: "approved", by: null, byName: "Later operator", at: new Date("2026-11-21T09:00:00Z") }],
      createdAt: at, updatedAt: at,
    },
    {
      company: saved.company, bookingId: saved._id, amount: 22, status: "Pending", source: "Manual", refundType: "upi",
      requestedBy: saved.createdBy, statusHistory: "legacy non-array history", reason: "Saved manual reason", createdAt: at, updatedAt: at,
    },
  ];
  const inserted = await models.RefundRequest.collection.insertMany(rows);
  const ids = Object.values(inserted.insertedIds);
  const before = await models.RefundRequest.collection.find({ _id: { $in: ids } }).sort({ _id: 1 }).toArray();
  for (const status of ["All", "Pending"]) {
    const response = await api("GET", `/refund-requests?status=${status}`);
    assert.equal(response.status, 200, response.json.message);
    for (const id of ids) {
      const matches = response.json.data.filter(row => row._id === String(id));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].customerName, booking.customerName);
      assert.equal(matches[0].customerMobile, booking.mobileNumber);
      assert.equal(matches[0].vehicleName, booking.vehicleName);
      assert.equal(matches[0].bookingAmount, 500);
      assert.equal(matches[0].method, "upi");
      assert.equal(matches[0].requestedAt, at.toISOString());
    }
    const cancellation = response.json.data.find(row => row._id === String(ids[0]));
    assert.equal(cancellation.requestedBy._id, null);
    assert.equal(cancellation.requestedBy.fullName, "Original saved requester");
    assert.equal(cancellation.reason, "Saved cancellation reason");
    assert.equal(cancellation.source, "Booking Cancellation");
    const manual = response.json.data.find(row => row._id === String(ids[1]));
    assert.equal(manual.source, "Manual");
    assert.equal(manual.reason, "Saved manual reason");
    assert.match(manual.requestedBy.fullName, /^Test User/);
  }
  const search = await api("GET", "/refund-requests?q=Original%20saved%20requester&status=Pending");
  assert.equal(search.status, 200);
  assert.deepEqual(search.json.data.map(row => row._id), [String(ids[0])]);
  assert.deepEqual(await models.RefundRequest.collection.find({ _id: { $in: ids } }).sort({ _id: 1 }).toArray(), before);
});

test("proof downloads and uploads enforce view, action, and tenant permissions", async () => {
  const booking = await createBooking();
  const saved = await models.Booking.findById(booking._id).lean();
  const request = await models.RefundRequest.create({
    company: saved.company, bookingId: saved._id, amount: 10, method: "cash",
    proofImageUrl: "https://res.cloudinary.com/test-cloud/image/upload/legacy-proof.png",
    requestedBy: saved.createdBy,
  });
  const employee = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE", businessName: "Refund Access Tests" });
  const User = (await import("../src/models/user.model.js")).default;
  const RolePermission = (await import("../src/models/rolePermission.model.js")).default;
  await User.updateOne({ email: employee.email }, { $set: { createdBy: saved.company } });
  const policy = await RolePermission.create({
    businessName: "Refund Access Tests", role: "BOOKING_EXECUTIVE", updatedBy: saved.createdBy,
    permissions: { "page.paymentsHistory.view": false, "page.bookings.edit": true, "page.dashboard.edit": true },
  });
  const restricted = client(ctx.base, employee.token);
  const path = `/refund-requests/${request._id}`;
  for (const endpoint of ["/refund-requests", "/refund-requests?q=legacy", path, `${path}/attachments/customer`]) {
    assert.equal((await restricted("GET", endpoint)).status, 403);
    assert.equal((await client(ctx.base)("GET", endpoint)).status, 401);
  }
  assert.equal((await restricted("PATCH", `${path}/approve`)).status, 403);
  assert.equal((await restricted("POST", "/refund-requests/attachments", new FormData())).status, 403);
  const axios = (await import("axios")).default;
  const originalGet = axios.get;
  let downloads = 0;
  let downloadUrl;
  axios.get = async (url) => { downloads += 1; downloadUrl = url; return { data: Buffer.from([137, 80, 78, 71]), headers: { "content-type": "image/png" } }; };
  try {
    const proof = await api("GET", `${path}/attachments/customer`);
    assert.equal(proof.status, 200);
    assert.match(proof.headers.get("cache-control"), /no-store/);
    assert.equal(proof.headers.get("content-type"), "image/png");
    assert.equal(downloads, 1);
    const other = await createUserAndLogin(ctx.base, { businessName: "Other Proof Tenant" });
    assert.equal((await client(ctx.base, other.token)("GET", `${path}/attachments/customer`)).status, 200);
    assert.equal(downloads, 2);
    await models.RefundRequest.updateOne({ _id: request._id }, { $set: {
      proofImageUrl: `https://res.cloudinary.com/test-cloud/image/authenticated/v1/my-sawari/refunds/${saved.company}/proof.jpg`,
    } });
    assert.equal((await api("GET", `${path}/attachments/customer`)).status, 200);
    assert.match(downloadUrl, /\/image\/authenticated\/s--/);
    assert.equal(downloads, 3);
    for (const url of ["https://127.0.0.1/private.png", "https://res.cloudinary.com/test-cloud/image/authenticated/v1/my-sawari/refunds/another-tenant/proof.jpg", `https://res.cloudinary.com/test-cloud/image/authenticated/v1/my-sawari/refunds/${saved.company}/%2e%2e%2fother.jpg`]) {
      await models.RefundRequest.updateOne({ _id: request._id }, { $set: { proofImageUrl: url } });
      assert.equal((await api("GET", `${path}/attachments/customer`)).status, 422);
    }
    assert.equal(downloads, 3);
  } finally { axios.get = originalGet; }
  const view = await api("GET", path);
  assert.equal(view.json.data.proofImageUrl, `${path}/attachments/customer`);
  assert.equal(JSON.stringify(view.json).includes("res.cloudinary.com"), false);
  await RolePermission.updateOne({ _id: policy._id }, { $set: { permissions: {
    "page.paymentsHistory.view": true, "page.bookings.edit": false, "page.dashboard.edit": false,
  } } });
  const readOnly = await restricted("GET", path);
  assert.equal(readOnly.status, 200);
  assert.deepEqual(readOnly.json.data.allowedActions, { approve: false, reject: false, refund: false });
  assert.equal((await restricted("PATCH", `${path}/approve`)).status, 403);
  assert.equal((await restricted("POST", "/refund-requests/attachments", new FormData())).status, 403);
  const body = new FormData();
  body.append("image", new Blob([Buffer.from([255, 216, 255])], { type: "image/jpeg" }), "proof.jpg");
  const uploaded = await api("POST", "/refund-requests/attachments", body);
  assert.equal(uploaded.status, 201, uploaded.json.message);
  const options = ctx.cloudinary.uploadOptions.at(-1);
  assert.equal(options.type, "authenticated");
  assert.equal(options.folder, `my-sawari/refunds/${saved.company}`);
  await RolePermission.updateOne({ _id: policy._id }, { $set: { permissions: {
    "page.paymentsHistory.view": true, "page.bookings.edit": true, "page.dashboard.edit": false,
  } } });
  const editable = await restricted("GET", path);
  assert.deepEqual(editable.json.data.allowedActions, { approve: true, reject: true, refund: false });
  assert.equal((await restricted("PATCH", `${path}/approve`)).status, 200);
  const noUpload = await restricted("GET", path);
  assert.deepEqual(noUpload.json.data.allowedActions, { approve: false, reject: true, refund: false });
  assert.equal((await restricted("PATCH", `${path}/refunded`, { completionProofImageUrl: "https://images.example.test/proof.png" })).status, 403);
});
