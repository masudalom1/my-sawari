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

  const created = await api("POST", "/vehicles/create", {
    vehicleName: "Cancellation Test Car",
    vehicleNumber: "KA01CA1001",
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

async function createBooking(options = {}) {
  bookingSequence += 1;
  const startOffset = options.startOffset ?? bookingSequence * 4;
  const bookingAmount = options.bookingAmount ?? 500;
  const response = await api("POST", "/leads/create", {
    customerName: `Cancellation Customer ${bookingSequence}`,
    mobileNumber: `9876501${String(bookingSequence).padStart(3, "0")}`,
    vehicleId,
    vehicleType: "car",
    fromDate: dayFromToday(startOffset),
    toDate: dayFromToday(startOffset + 2),
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

test("refundable balance includes recorded booking advances and reserves active requests", async () => {
  const booking = await createBooking({ bookingAmount: 10, startOffset: 40 });
  const advance = await models.PaymentHistory.findOne({
    bookingId: booking._id,
    company: booking.company,
    type: "booking",
  }).lean();
  assert.ok(advance);
  assert.equal(advance.note, "Booking advance payment");
  assert.equal(advance.isCollected, false);
  assert.equal(advance.collectedAmount, 0);

  const getDetails = () =>
    api("GET", `/leads/${booking._id}/cancellation-details`);
  const initial = await getDetails();
  assert.equal(initial.status, 200);
  assert.equal(initial.json.refundableAmount, 10);
  assert.equal(initial.json.collectedAmount, 10);

  const request = await models.RefundRequest.create({
    company: booking.company,
    bookingId: booking._id,
    amount: 4,
    method: "cash",
    status: "Pending",
    requestedBy: booking.createdBy,
  });
  const pending = await getDetails();
  assert.equal(pending.json.reservedAmount, 4);
  assert.equal(pending.json.refundableAmount, 6);
  assert.equal(pending.json.hasActiveRefundRequest, true);

  await models.RefundRequest.updateOne(
    { _id: request._id },
    { $set: { status: "Approved" } },
  );
  const approved = await getDetails();
  assert.equal(approved.json.reservedAmount, 4);
  assert.equal(approved.json.refundableAmount, 6);

  await models.RefundRequest.updateOne(
    { _id: request._id },
    { $set: { status: "Rejected" } },
  );
  const rejected = await getDetails();
  assert.equal(rejected.json.reservedAmount, 0);
  assert.equal(rejected.json.refundableAmount, 10);
  assert.equal(rejected.json.hasActiveRefundRequest, false);
});

test("booking amount alone does not create refundable balance without a receipt record", async () => {
  const booking = await createBooking({ bookingAmount: 10 });
  await models.PaymentHistory.deleteMany({ bookingId: booking._id });

  const response = await api(
    "GET",
    `/leads/${booking._id}/cancellation-details`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.json.collectedAmount, 0);
  assert.equal(response.json.refundableAmount, 0);
});

test("Not Applicable cancels the booking, stores its reason, and creates no refund request", async () => {
  const booking = await createBooking();
  const payload = { reason: "Customer changed plans" };
  const [response, retry] = await Promise.all([
    api("PUT", `/leads/${booking._id}/cancel`, payload),
    api("PUT", `/leads/${booking._id}/cancel`, payload),
  ]);

  assert.equal(response.status, 200, response.json.message);
  assert.equal(retry.status, 200, retry.json.message);
  assert.equal([response, retry].filter((result) => result.json.replayed).length, 1);
  assert.equal(retry.json.refundRequest, null);
  assert.equal(response.json.booking.status, "cancelled");
  assert.equal(response.json.booking.cancellationReason, "Customer changed plans");
  assert.equal(response.json.refundRequest, null);

  const savedBooking = await models.Booking.findById(booking._id).lean();
  assert.equal(savedBooking.isDeleted, false);
  assert.equal(savedBooking.cancellationReason, "Customer changed plans");
  assert.equal(
    await models.RefundRequest.countDocuments({ bookingId: booking._id }),
    0,
  );
  assert.equal(
    await models.PaymentHistory.countDocuments({
      bookingId: booking._id,
      type: "refund",
    }),
    0,
  );

  const replacement = await createBooking({ startOffset: 4 });
  assert.equal(replacement.status, "confirmed");
});

test("Give Refund checks prior refunds, writes one pending request, and replays retries", async () => {
  const booking = await createBooking();
  const Customer = (await import("../src/models/customer.model.js")).default;
  const Lead = (await import("../src/models/lead.model.js")).default;
  const customer = await Customer.create({
    customerName: booking.customerName,
    mobileNumber: booking.mobileNumber,
  });
  await Lead.updateOne({ _id: booking.lead }, { $set: { customerId: customer._id } });
  const advance = await models.PaymentHistory.findOne({
    bookingId: booking._id,
    type: "booking",
  }).lean();
  assert.ok(advance);

  await models.PaymentHistory.updateOne(
    { _id: advance._id },
    {
      $set: {
        isCollected: false,
        collectedAmount: 200,
        collectedPhonePe: 0,
        collectionHistory: [],
      },
    },
  );

  await models.PaymentHistory.create({
    company: booking.company,
    bookingId: booking._id,
    customer: advance.customer,
    vehicle: advance.vehicle,
    booking: advance.booking,
    amount: 125,
    paymentMethod: "cash",
    paymentBreakdown: { cash: 125 },
    type: "refund",
    createdBy: booking.createdBy,
  });

  const payload = {
    reason: "Customer changed plans",
    refund: {
      amount: 75,
      method: "gpay",
      customerUpiId: "name@okbank",
      proofImageUrl: "https://images.example.test/payment.png",
    },
  };
  const overBalance = await api("PUT", `/leads/${booking._id}/cancel`, {
    ...payload,
    refund: { ...payload.refund, amount: 76 },
  });
  const cancellationDetails = await api(
    "GET",
    `/leads/${booking._id}/cancellation-details`,
  );
  assert.equal(cancellationDetails.status, 200);
  assert.equal(cancellationDetails.json.refundableAmount, 75);
  assert.equal(overBalance.status, 400);
  assert.match(overBalance.json.message, /current refundable balance of ₹75/);
  assert.equal((await models.Booking.findById(booking._id).lean()).status, "confirmed");
  assert.equal(
    await models.RefundRequest.countDocuments({ bookingId: booking._id }),
    0,
  );

  const [first, retry] = await Promise.all([
    api("PUT", `/leads/${booking._id}/cancel`, payload),
    api("PUT", `/leads/${booking._id}/cancel`, payload),
  ]);
  assert.equal(first.status, 200, first.json.message);
  assert.equal(retry.status, 200, retry.json.message);
  assert.equal(first.json.booking.status, "cancelled");
  assert.equal(first.json.refundRequest.status, "pending");
  assert.equal(first.json.refundRequest.amount, 75);
  assert.equal(first.json.refundRequest.method, "gpay");
  assert.equal(first.json.refundRequest.source, "Booking Cancellation");
  assert.equal(first.json.refundRequest.customerUpiId, "name@okbank");
  assert.equal(first.json.refundRequest.proofImageUrl, payload.refund.proofImageUrl);
  assert.equal(first.json.refundRequest.reason, payload.reason);
  assert.equal(String(first.json.refundRequest._id), String(retry.json.refundRequest._id));
  assert.equal([first, retry].filter((result) => result.json.replayed).length, 1);
  assert.equal(
    await models.PaymentHistory.countDocuments({
      bookingId: booking._id,
      type: "refund",
    }),
    1,
  );

  const requests = await models.RefundRequest.find({
    bookingId: booking._id,
  }).lean();
  assert.equal(requests.length, 1);
  assert.equal(String(requests[0].bookingId), String(booking._id));
  assert.equal(String(requests[0].customerId), String(customer._id));
  assert.equal(String(requests[0].company), String(booking.company));
  assert.equal(requests[0].customerName, booking.customerName);
  assert.equal(requests[0].customerMobile, booking.mobileNumber);
  assert.equal(requests[0].vehicleName, booking.vehicleName);
  assert.equal(requests[0].bookingAmount, booking.bookingAmount);
  assert.equal(requests[0].refundSource, "cancellation");
  assert.equal(requests[0].refundType, "upi");
  assert.equal(requests[0].upiId, payload.refund.customerUpiId);
  assert.deepEqual(requests[0].accountDetails, {
    accountNumber: "", ifscCode: "", accountHolderName: "", bankName: "",
  });
  assert.equal(requests[0].rejectionReason, "");
  assert.equal(requests[0].transactionReference, "");
  assert.equal(requests[0].completionProofImageUrl, "");
  assert.equal(requests[0].statusHistory.length, 1);
  assert.equal(requests[0].statusHistory[0].status, "pending");
  assert.equal(String(requests[0].statusHistory[0].by), String(booking.createdBy));
  assert.match(requests[0].statusHistory[0].byName, /^Test User/);
  assert.equal(requests[0].statusHistory[0].note, payload.reason);
  assert.ok(requests[0].statusHistory[0].at instanceof Date);
  assert.equal(String(requests[0].requestedBy), String(booking.createdBy));
  assert.ok(requests[0].createdAt instanceof Date);
  assert.equal(requests[0].source, "Booking Cancellation");

  const pendingList = await api("GET", "/refund-requests");
  assert.equal(pendingList.status, 200);
  assert.equal(pendingList.json.data.filter(
    (item) => item.status === "Pending" && String(item._id) === String(requests[0]._id),
  ).length, 1);
  const pendingItem = pendingList.json.data.find(
    (item) => String(item._id) === String(requests[0]._id),
  );
  assert.equal(pendingItem.status, "Pending");
  assert.equal(pendingItem.amount, 75);
  assert.equal(pendingItem.method, "gpay");
  assert.equal(pendingItem.source, "Booking Cancellation");
  assert.equal(String(pendingItem.bookingId), String(booking._id));
  assert.equal(pendingItem.booking.status, "cancelled");

  const approved = await api(
    "PATCH",
    `/refund-requests/${requests[0]._id}/approve`,
  );
  assert.equal(approved.status, 200, approved.json.message);
  const approvedList = await api("GET", "/refund-requests");
  const approvedItem = approvedList.json.data.find(
    (item) => String(item._id) === String(requests[0]._id),
  );
  assert.equal(approvedItem.status, "Approved");
  assert.match(approvedItem.approvedBy.fullName, /^Test User/);
  assert.ok(approvedItem.approvedAt);

  const missingProof = await api(
    "PATCH",
    `/refund-requests/${requests[0]._id}/refunded`,
    {},
  );
  assert.equal(missingProof.status, 400);
  assert.equal(
    (await models.RefundRequest.findById(requests[0]._id).lean()).status,
    "Approved",
  );

  const completionPayload = {
    completionProofImageUrl: "https://images.example.test/gpay-refund-proof.png",
  };
  const [completed, completionRetry] = await Promise.all([
    api(
      "PATCH",
      `/refund-requests/${requests[0]._id}/refunded`,
      completionPayload,
    ),
    api(
      "PATCH",
      `/refund-requests/${requests[0]._id}/refunded`,
      completionPayload,
    ),
  ]);
  assert.equal(completed.status, 200, completed.json.message);
  assert.equal(completed.json.data.status, "Refunded");
  assert.equal(completed.json.data.utr, "");
  assert.equal(completionRetry.status, 200);
  assert.equal(
    [completed, completionRetry].filter((response) => response.json.replayed).length,
    1,
  );
  assert.equal(
    await models.PaymentHistory.countDocuments({
      refundRequestId: requests[0]._id,
      type: "refund",
    }),
    1,
  );

  const completedList = await api("GET", "/refund-requests");
  const completedItem = completedList.json.data.find(
    (item) => String(item._id) === String(requests[0]._id),
  );
  assert.equal(completedItem.status, "Refunded");
  assert.match(completedItem.refundedBy.fullName, /^Test User/);
  assert.ok(completedItem.refundedAt);
  assert.equal(
    completedList.json.summary.refundedToday.amount,
    75,
  );
  assert.equal(completedList.json.summary.refundedToday.count, 1);
  assert.equal(completedList.json.summary.thisMonth.amount, 75);
  assert.equal(completedList.json.summary.toBePaid.amount, 0);
  const lateRetry = await api("PUT", `/leads/${booking._id}/cancel`, payload);
  assert.equal(lateRetry.status, 200, lateRetry.json.message);
  assert.equal(lateRetry.json.replayed, true);
  assert.equal(lateRetry.json.refundRequest.status, "Refunded");
  assert.equal(String(lateRetry.json.refundRequest._id), String(requests[0]._id));
});

test("failed refund-request writes roll back the booking cancellation", async () => {
  const booking = await createBooking();
  await models.PaymentHistory.updateOne(
    { bookingId: booking._id, type: "booking" },
    {
      $set: {
        isCollected: true,
        collectedAmount: 500,
        collectedPhonePe: 0,
        collectionHistory: [],
      },
    },
  );
  const originalCreate = models.RefundRequest.create;
  const beforeFailure = await models.Booking.findById(booking._id).lean();
  models.RefundRequest.create = async () => {
    throw new Error("Refund request write failed");
  };

  let response;
  try {
    response = await api("PUT", `/leads/${booking._id}/cancel`, {
      refund: { amount: 500, method: "phonepe" },
    });
  } finally {
    models.RefundRequest.create = originalCreate;
  }

  assert.equal(response.status, 500);
  assert.deepEqual(await models.Booking.findById(booking._id).lean(), beforeFailure);
  assert.equal(
    await models.RefundRequest.countDocuments({ bookingId: booking._id }),
    0,
  );
});

test("ineligible bookings cannot be cancelled", async () => {
  const booking = await createBooking();
  await models.Booking.updateOne(
    { _id: booking._id },
    { $set: { status: "active" } },
  );

  const response = await api("PUT", `/leads/${booking._id}/cancel`, {
    reason: "Should not be accepted",
  });
  assert.equal(response.status, 400);
  assert.equal((await models.Booking.findById(booking._id).lean()).status, "active");
});

test("cancellation maps each payout method, defaults, and authenticated actor", async () => {
  for (const [method, refundType] of [["cash", "cash"], ["phonepe", "upi"], ["gpay", "upi"], ["razorpay", "razorpay"]]) {
    const booking = await createBooking({ startOffset: 100 + bookingSequence * 4 });
    const response = await api("PUT", `/leads/${booking._id}/cancel`, {
      reason: "   ",
      refund: {
        amount: 0.5,
        method,
        customerId: vehicleId,
        statusHistory: [{ by: vehicleId, byName: "Forged customer" }],
      },
    });
    assert.equal(response.status, 200, response.json.message);
    const saved = await models.RefundRequest.findById(response.json.refundRequest._id).lean();
    assert.equal(saved.status, "pending");
    assert.equal(saved.method, method);
    assert.equal(saved.refundType, refundType);
    assert.equal(saved.amount, 0.5);
    assert.equal(saved.reason, "");
    assert.equal(saved.upiId, "");
    assert.equal(saved.proofImageUrl, "");
    assert.equal(saved.completionProofImageUrl, "");
    assert.equal(saved.customerId, null);
    assert.equal(saved.statusHistory.length, 1);
    assert.equal(String(saved.statusHistory[0].by), String(booking.createdBy));
    assert.match(saved.statusHistory[0].byName, /^Test User/);
    assert.equal(saved.statusHistory[0].note, "");
  }
});

const phase2Booking = () => createBooking({ startOffset: 300 + bookingSequence * 4 });

test("cancellation rechecks reserved balance and allows only the available remainder", async () => {
  const booking = await phase2Booking();
  const manual = await api("POST", "/refund-requests", {
    bookingId: booking._id,
    customerMobile: booking.mobileNumber,
    amount: 150,
    method: "cash",
    reason: "Existing reservation",
    idempotencyKey: `reserved-balance-${booking._id}`,
  });
  assert.equal(manual.status, 201, manual.json.message);
  const overBalance = await api("PUT", `/leads/${booking._id}/cancel`, {
    refund: { amount: 351, method: "cash" },
  });
  assert.equal(overBalance.status, 400, overBalance.json.message);
  assert.match(overBalance.json.message, /current refundable balance/);
  assert.equal((await models.Booking.findById(booking._id)).status, "confirmed");
  const cancelled = await api("PUT", `/leads/${booking._id}/cancel`, {
    refund: { amount: 350, method: "cash" },
  });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  assert.equal(cancelled.json.refundRequest.status, "pending");
  assert.equal(await models.RefundRequest.countDocuments({ bookingId: booking._id }), 2);
  assert.equal(await models.RefundRequest.countDocuments({ bookingId: booking._id, refundSource: "cancellation" }), 1);
  assert.equal(await models.PaymentHistory.countDocuments({ bookingId: booking._id, type: "refund" }), 0);
});

test("manual refund and cancellation cannot concurrently reserve more than collections", async () => {
  const booking = await phase2Booking();
  const [manual, cancelled] = await Promise.all([
    api("POST", "/refund-requests", {
      bookingId: booking._id,
      customerMobile: booking.mobileNumber,
      amount: 400,
      method: "cash",
      reason: "Concurrent manual request",
      idempotencyKey: `concurrent-cancel-${booking._id}`,
    }),
    api("PUT", `/leads/${booking._id}/cancel`, { refund: { amount: 400, method: "cash" } }),
  ]);
  assert.ok(
    (manual.status === 201 && cancelled.status === 400) ||
    (manual.status === 400 && cancelled.status === 200),
    JSON.stringify([manual, cancelled]),
  );
  const saved = await models.Booking.findById(booking._id).lean();
  assert.equal(saved.status, cancelled.status === 200 ? "cancelled" : "confirmed");
  const balance = await api("GET", `/refund-requests/balance/${booking._id}`);
  assert.equal(balance.json.reservedAmount, 400);
  assert.equal(balance.json.refundableAmount, 100);
  assert.equal(await models.RefundRequest.countDocuments({ bookingId: booking._id }), 1);
});

test("cancellation rejects changed retry details without modifying the saved result", async () => {
  const booking = await phase2Booking();
  const payload = {
    reason: "Original cancellation",
    refund: { amount: 50, method: "phonepe", proofImageUrl: "https://images.example.test/original.png" },
  };
  const first = await api("PUT", `/leads/${booking._id}/cancel`, payload);
  assert.equal(first.status, 200, first.json.message);
  const saved = await models.Booking.findById(booking._id).lean();
  for (const changed of [
    { reason: payload.reason },
    { ...payload, reason: "Different cancellation" },
    { ...payload, refund: { ...payload.refund, amount: 51 } },
    { ...payload, refund: { ...payload.refund, proofImageUrl: "https://images.example.test/changed.png" } },
  ]) {
    const response = await api("PUT", `/leads/${booking._id}/cancel`, changed);
    assert.equal(response.status, 409, response.json.message);
  }
  assert.deepEqual(await models.Booking.findById(booking._id).lean(), saved);
  assert.equal(await models.RefundRequest.countDocuments({ bookingId: booking._id }), 1);
});

test("cancellation reloads eligibility after the dialog was opened", async () => {
  const booking = await phase2Booking();
  const details = await api("GET", `/leads/${booking._id}/cancellation-details`);
  assert.equal(details.status, 200);
  await models.Booking.updateOne({ _id: booking._id }, { $set: { status: "active" } });
  const response = await api("PUT", `/leads/${booking._id}/cancel`, {
    refund: { amount: 50, method: "cash" },
  });
  assert.equal(response.status, 400);
  assert.equal((await models.Booking.findById(booking._id)).status, "active");
  assert.equal(await models.RefundRequest.countDocuments({ bookingId: booking._id }), 0);
});

test("cancellation rechecks permissions and rejects other tenants", async () => {
  const booking = await phase2Booking();
  const employee = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const User = (await import("../src/models/user.model.js")).default;
  const RolePermission = (await import("../src/models/rolePermission.model.js")).default;
  await RolePermission.create({
    businessName: "Test Rentals",
    role: "BOOKING_EXECUTIVE",
    permissions: { "page.bookings.edit": true },
    updatedBy: booking.createdBy,
  });
  await User.updateOne({ email: employee.email }, { $set: {
    createdBy: booking.company,
    permissionOverrides: { "page.bookings.edit": "allow" },
  } });
  const employeeApi = client(ctx.base, employee.token);
  assert.equal((await employeeApi("GET", `/leads/${booking._id}/cancellation-details`)).status, 200);
  await User.updateOne({ email: employee.email }, { $set: {
    permissionOverrides: { "page.bookings.edit": "deny" },
  } });
  const payload = { refund: { amount: 50, method: "cash" } };
  assert.equal((await employeeApi("PUT", `/leads/${booking._id}/cancel`, payload)).status, 403);
  const otherTenant = await createUserAndLogin(ctx.base, { businessName: "Other Cancellation Tenant" });
  assert.equal((await client(ctx.base, otherTenant.token)("PUT", `/leads/${booking._id}/cancel`, payload)).status, 404);
  assert.equal((await client(ctx.base)("PUT", `/leads/${booking._id}/cancel`, payload)).status, 401);
  assert.equal((await models.Booking.findById(booking._id)).status, "confirmed");
  assert.equal(await models.RefundRequest.countDocuments({ bookingId: booking._id }), 0);
});
