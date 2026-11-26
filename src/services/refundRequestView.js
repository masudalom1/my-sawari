import mongoose from "mongoose";

const statusLabel = (value) => {
  const status = String(value || "pending").toLowerCase();
  return status.charAt(0).toUpperCase() + status.slice(1);
};
const actorView = (entry, fallback) => ({
  _id: entry ? entry.by?._id || entry.by || null : fallback?._id || null,
  fullName: entry?.byName || entry?.by?.fullName || fallback?.fullName || "Unknown user",
});

// Adapt historical rows for the dashboard without rewriting the shared document.
export function refundRequestView(request) {
  const booking = request.bookingId && typeof request.bookingId === "object" &&
    !mongoose.isObjectIdOrHexString(request.bookingId) ? request.bookingId : null;
  const savedHistory = Array.isArray(request.statusHistory)
    ? request.statusHistory.filter((entry) => entry && typeof entry === "object")
    : [];
  const history = savedHistory.length ? savedHistory : [
    { status: "pending", by: request.requestedBy?._id || null, byName: request.requestedBy?.fullName || "", at: request.requestedAt || request.createdAt, note: request.reason || "" },
    ...["approved", "rejected", "refunded"].filter((status) => request[`${status}At`]).map((status) => ({
      status, by: request[`${status}By`]?._id || null,
      byName: request[`${status}By`]?.fullName || "", at: request[`${status}At`],
      note: status === "rejected" ? request.rejectionReason || "" : "",
    })),
  ];
  const eventFor = (status) => history.findLast((entry) => String(entry.status).toLowerCase() === status);
  const requested = history.find((entry) => ["pending", "requested"].includes(String(entry.status).toLowerCase()));
  const source = request.refundSource === "cancellation" ? "Booking Cancellation" :
    request.refundSource === "manual" ? "Manual" : request.source || request.refundSource || "";
  const method = String(request.method || request.refundType || "").toLowerCase();
  const upiId = request.upiId || request.customerUpiId || "";
  const reference = request.transactionReference || request.utr || "";
  const output = {
    ...request,
    status: statusLabel(request.status),
    source,
    refundSource: request.refundSource || (source === "Booking Cancellation" ? "cancellation" : source === "Manual" ? "manual" : ""),
    refundType: request.refundType || (["gpay", "phonepe"].includes(method) ? "upi" : method),
    method,
    upiId,
    customerUpiId: upiId,
    transactionReference: reference,
    utr: reference,
    accountDetails: { accountNumber: "", ifscCode: "", accountHolderName: "", bankName: "", ...request.accountDetails },
    customerId: request.customerId || null,
    bookingId: booking?._id || request.bookingId || null,
    booking: booking ? {
      _id: booking._id, bookingCode: booking.bookingCode || "", status: booking.status || "",
      fromDate: booking.fromDate || null, toDate: booking.toDate || null,
    } : null,
    customerName: request.customerName || booking?.customerName || "",
    customerMobile: request.customerMobile || booking?.mobileNumber || "",
    vehicleName: request.vehicleName || booking?.vehicleName || "",
    vehicleNumber: request.vehicleNumber || booking?.vehicleNumber || "",
    bookingAmount: request.bookingAmount ?? booking?.bookingAmount ?? booking?.payment?.bookingAmountPaid ?? 0,
    reason: request.reason ?? requested?.note ?? "",
    requestedBy: actorView(requested, request.requestedBy),
    requestedAt: requested?.at || request.requestedAt || request.createdAt,
    statusHistory: history,
  };
  for (const status of ["approved", "rejected", "refunded"]) {
    const event = eventFor(status);
    output[`${status}By`] = actorView(event, request[`${status}By`]);
    output[`${status}At`] = event?.at || request[`${status}At`] || null;
  }
  if (request._id) {
    output.proofImageUrl = request.proofImageUrl ? `/refund-requests/${request._id}/attachments/customer` : "";
    output.completionProofImageUrl = request.completionProofImageUrl ? `/refund-requests/${request._id}/attachments/completion` : "";
  }
  return output;
}
