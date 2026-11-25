import { test, before, after } from "node:test";
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

async function createBooking() {
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
    bookingAmount: 500,
    paymentMethod: "cash",
    paymentDate: dayFromToday(-1),
    paymentTime: "14:35",
  });
  assert.equal(response.status, 201, response.json.message);
  return response.json.booking;
}

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
  assert.equal(overBalance.status, 400);
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
    [201, 400],
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
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: request.json.data._id,
    }),
    0,
  );
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
