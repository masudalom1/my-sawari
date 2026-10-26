// Shared backend entry point for Revenue and All Payments. Keep database scope
// and date filtering in their callers, outside channel allocation.
export {
  allocatePaymentChannels,
  allocateRevenuePayment,
  normalizeRevenueChannelSplit,
  revenuePaymentAmount,
  revenuePaymentBreakdown,
} from "../../../shared/paymentAllocation.mjs";

export const mongoAllocationMath = Object.freeze({
  sum: (values) => ({ $add: values.map((value) => ({ $ifNull: [value, 0] })) }),
  positive: (value) => ({ $gt: [value, 0] }),
  equal: (left, right) => ({ $eq: [left, right] }),
  both: (left, right) => ({ $and: [left, right] }),
  choose: (condition, yes, no) => ({ $cond: [condition, yes, no] }),
});
