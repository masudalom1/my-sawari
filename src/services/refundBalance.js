import PaymentHistory from "../models/paymentHistory.model.js";
import RefundRequest from "../models/refundRequest.model.js";
import { collectedOf } from "../utils/revenue.utils.js";

const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function refundableBalanceFromPayments(payments, refundRequests = []) {
  const received = payments.reduce((sum, payment) => {
    if (payment.type === "refund") return sum;
    const amount = Number(payment.amount);
    const hasCollectionRecord =
      payment.isCollected ||
      Number(payment.collectedAmount) > 0 ||
      Number(payment.collectedPhonePe) > 0 ||
      payment.collectionHistory?.length > 0;
    const isRecordedBookingAdvance =
      payment.type === "booking" &&
      payment.note === "Booking advance payment";
    return (
      sum +
      (Number.isFinite(amount) && amount > 0
        ? isRecordedBookingAdvance && !hasCollectionRecord
          ? amount
          : collectedOf(payment, amount)
        : 0)
    );
  }, 0);
  const refunded = payments.reduce((sum, payment) => {
    if (payment.type !== "refund") return sum;
    const amount = Number(payment.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);
  const reserved = refundRequests.reduce((sum, request) => {
    if (!["pending", "approved"].includes(String(request.status).toLowerCase())) return sum;
    const amount = Number(request.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);
  const collectedAmount = roundMoney(received);
  const completedRefundAmount = roundMoney(refunded);
  const reservedAmount = roundMoney(reserved);
  const refundDueAmount = roundMoney(
    Math.max(0, collectedAmount - completedRefundAmount),
  );
  return {
    collectedAmount,
    completedRefundAmount,
    reservedAmount,
    refundDueAmount,
    refundableAmount: roundMoney(
      Math.max(0, refundDueAmount - reservedAmount),
    ),
  };
}

export async function getCurrentRefundableBalance(booking, companyId, session) {
  let paymentQuery = PaymentHistory.find({
    bookingId: booking._id,
    company: companyId,
  }).select(
    "type amount note isCollected collectedAmount collectedPhonePe collectionHistory.amount",
  );
  let requestQuery = RefundRequest.find({
    bookingId: booking._id,
    company: companyId,
  }).select("amount status");
  if (session) {
    paymentQuery = paymentQuery.session(session);
    requestQuery = requestQuery.session(session);
  }
  const payments = await paymentQuery.lean();
  const refundRequests = await requestQuery.lean();
  return refundableBalanceFromPayments(payments, refundRequests);
}
