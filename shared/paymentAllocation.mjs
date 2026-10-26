// Browser-safe allocation core, also compiled to native MongoDB expressions.
// Adapters own parsing, currency units, validation and supported channels.
const numeric = Object.freeze({
  sum: (values) => values.reduce((total, value) => total + (value || 0), 0),
  positive: (value) => value > 0,
  equal: (left, right) => left === right,
  both: (left, right) => left && right,
  choose: (condition, yes, no) => condition ? yes : no,
});

export function allocatePaymentChannels({ channels, amount, method, canFallback = true, clearEmpty = false }, math = numeric) {
  const covered = math.sum(Object.values(channels));
  const hasBreakdown = math.positive(covered);
  return Object.fromEntries(Object.entries(channels).map(([key, value]) => [key,
    math.choose(hasBreakdown, value,
      math.choose(math.both(canFallback, math.equal(method, key)), amount, clearEmpty ? 0 : value)),
  ]));
}

const REVENUE_FIELDS = Object.freeze({ cash: "cash", phonepe: "phonePe", razorpay: "razorpay" });

// Compatibility boundary for precomputed splits from independently deployed
// APIs. Revenue keeps its historical four keys; All Payments keeps GPay separate.
// Invalid/unknown split fields trigger recomputation from the payment document.
export function normalizeRevenueChannelSplit(split) {
  if (!split || typeof split !== "object" || Array.isArray(split)) return null;
  const keys = [...Object.keys(REVENUE_FIELDS), "unspecified"];
  if (!Object.keys(split).length || Object.entries(split).some(([key, value]) =>
    ![...keys, "gpay"].includes(key) || typeof value !== "number" || !Number.isFinite(value))) return null;
  const normalized = Object.fromEntries(keys.map((key) => [key, split[key] ?? 0]));
  normalized.unspecified += split.gpay ?? 0;
  return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

export function revenuePaymentBreakdown(payment) {
  const breakdown = payment.paymentBreakdown || {};
  return Object.fromEntries(Object.values(REVENUE_FIELDS).map((key) => [key, Number(breakdown[key]) || 0]));
}

// Compatibility adapter: retain Revenue's exact historical amount coercion,
// three-channel coverage, case-sensitive method and unspecified remainder.
// Changing this policy changes displayed Revenue and requires separate approval.
export function revenuePaymentAmount(payment, { parseAmount = (value) => Number(value) || 0, fallbackToBreakdown = true } = {}) {
  const amount = parseAmount(payment.amount);
  // All Payments retains invalid/missing amounts for review instead of replacing
  // them. This also lets its native MongoDB pipeline supply a parsing expression.
  if (!fallbackToBreakdown) return amount;
  if (amount > 0) return amount;
  return numeric.sum(Object.values(revenuePaymentBreakdown(payment)));
}

export function allocateRevenuePayment(payment, amount = revenuePaymentAmount(payment), options = {}) {
  // Prepared channels have already been normalized/validated by the report.
  // Values and amount must use the same units (Revenue INR or report paise).
  const channels = options.channels ?? (() => {
    const breakdown = revenuePaymentBreakdown(payment);
    return Object.fromEntries(Object.entries(REVENUE_FIELDS).map(([key, field]) => [key, breakdown[field]]));
  })();
  const split = allocatePaymentChannels({ channels, amount, method: payment.paymentMethod,
    canFallback: options.canFallback ?? true, clearEmpty: options.clearEmpty ?? true }, options.math ?? numeric);
  // All Payments exposes signed reconciliation separately instead of another
  // donut category. Default calls preserve Revenue's exact historical shape.
  if (options.includeUnspecified === false) return split;
  const covered = numeric.sum(Object.values(channels));
  split.unspecified = covered > 0 ? Math.max(amount - covered, 0)
    : Object.keys(REVENUE_FIELDS).includes(payment.paymentMethod) ? 0 : amount;
  return split;
}
