// Pure reporting contract shared by the API and UI. No database or browser IO.
import { allocateRevenuePayment, revenuePaymentAmount as paymentAmount } from "./paymentAllocation.mjs";
export const PAYMENT_RECEIPT_TYPES = Object.freeze(["booking", "handover", "rental", "extension", "additional_charge", "receive"]);
const RECEIPT_TYPES = new Set(PAYMENT_RECEIPT_TYPES);
export const PAYMENTS_TIME_ZONE = "Asia/Kolkata";
export const PAYMENT_PERIOD_OPTIONS = Object.freeze([
  Object.freeze(["all", "All"]), Object.freeze(["today", "Today"]),
  Object.freeze(["month", "This Month"]), Object.freeze(["custom", "Custom"]),
]);
export const PAYMENT_CHANNELS = Object.freeze(["cash", "phonepe", "gpay", "razorpay"]);
const METHODS = PAYMENT_CHANNELS;
export const PAYMENT_METHOD_ALIASES = Object.freeze({ cash: "cash", phonepe: "phonepe", razorpay: "razorpay", mixed: "mixed", mix: "mixed", gpay: "gpay", googlepay: "gpay" });
export const PAYMENT_MAX_PAISE = Number.MAX_SAFE_INTEGER;
export const PAYMENT_PAISE_EPSILON = 0.001;
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PAYMENTS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const formatINR = (value) => value == null ? "—" : money.format(value);
export const formatPaymentDate = (value) => value && Number.isFinite(new Date(value).getTime()) ? dateFormat.format(new Date(value)) : "Date unavailable";
export function paymentDay(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  const parts = Object.fromEntries(dayFormat.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// No company timezone configuration exists in the supplied schema/API. Keep
// report periods on the established IST policy, independent of browser TZ.
export function paymentPeriodRange(period, now = new Date()) {
  const today = paymentDay(now);
  if (!today) throw new Error("Invalid report date");
  const [year, month, day] = today.split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const key = (date) => date.toISOString().slice(0, 10);
  if (period === "today") return { from: today, to: today };
  if (period === "yesterday") {
    calendar.setUTCDate(calendar.getUTCDate() - 1);
    return { from: key(calendar), to: key(calendar) };
  }
  if (period === "week") {
    // Monday through Sunday, explicitly shown in the UI.
    calendar.setUTCDate(calendar.getUTCDate() - ((calendar.getUTCDay() + 6) % 7));
    const from = key(calendar);
    calendar.setUTCDate(calendar.getUTCDate() + 6);
    return { from, to: key(calendar) };
  }
  if (period === "previous-month") return { from: key(new Date(Date.UTC(year, month - 2, 1))), to: key(new Date(Date.UTC(year, month - 1, 0))) };
  if (period === "month") return { from: `${today.slice(0, 7)}-01`, to: key(new Date(Date.UTC(year, month, 0))) };
  return { from: "", to: "" };
}
// Calendar validation shared by the date inputs and report query construction.
export function validPaymentDateRange(from, to) {
  const valid = (day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(new Date(`${day}T00:00:00Z`).getTime()) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  return valid(from) && valid(to) && from <= to;
}
// All Payments date contract, independent of Revenue's date/preset policy.
// Inclusive IST calendar dates become an exclusive UTC upper bound. IST has
// a fixed +05:30 offset; neither server nor browser local midnight is used.
export function paymentCreatedAtRange(from, to) {
  if ((from && !validPaymentDateRange(from, from)) || (to && !validPaymentDateRange(to, to)) || (from && to && from > to)) throw new Error("Invalid report date range");
  if (!from && !to) return undefined;
  return {
    ...(from ? { $gte: new Date(`${from}T00:00:00.000+05:30`) } : {}),
    ...(to ? { $lt: new Date(new Date(`${to}T00:00:00.000+05:30`).getTime() + 86400000) } : {}),
  };
}
export function paymentDateQuery(filters) {
  if (!PAYMENT_PERIOD_OPTIONS.some(([period]) => period === filters.period)) return null;
  if (filters.period === "all") return { period: "all", dateBasis: "createdAt" };
  if (!validPaymentDateRange(filters.from, filters.to)) return null;
  return { period: "custom", dateBasis: "createdAt", startDate: filters.from, endDate: filters.to };
}
export function initialPaymentFilters(now = new Date()) {
  return { search: "", period: "month", basis: "created", ...paymentPeriodRange("month", now), method: "all", collection: "all" };
}
export function paymentBasisDay(row, basis = "payment") {
  // Reporting always follows creation time; display dates have separate precedence.
  if (basis === "payment" || basis === "created") return paymentDay(row.createdAt);
  return null; // Historical collection basis is deliberately unavailable.
}
export const paymentTypeLabel = (type) => typeof type === "string" && type.trim() ? type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unknown";
export function methodLabel(method) {
  const labels = { cash: "Cash", phonepe: "PhonePe", razorpay: "Razorpay", mixed: "Mixed", gpay: "GPay" };
  return Object.hasOwn(labels, method) ? labels[method] : method || "Unknown";
}
export function normalizePaymentMethod(value) {
  if (typeof value !== "string") return "";
  const token = value.trim().toLowerCase();
  const compact = token.replace(/[\s_-]/g, "");
  return Object.hasOwn(PAYMENT_METHOD_ALIASES, compact) ? PAYMENT_METHOD_ALIASES[compact] : token;
}
export function availablePaymentMethods(rows) {
  const defaults = ["all", "cash", "phonepe", "razorpay", "mixed"];
  const observed = rows.flatMap((row) => [row.method, ...Object.entries(row.channels || {}).filter(([, value]) => value > 0).map(([key]) => key)]);
  return [...defaults, ...[...new Set(observed)].filter((method) => method && !defaults.includes(method)).sort()];
}
const paise = (value) => {
  // Accept plain historical decimal strings, but never coerce blanks, booleans,
  // currency text or non-finite values to zero. Preserve the original record.
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < PAYMENT_PAISE_EPSILON ? rounded : null;
};

export function classifyPayment(payment) {
  const amountPaise = paymentAmount(payment, { parseAmount: paise, fallbackToBreakdown: false });
  const sourceMethod = normalizePaymentMethod(payment.paymentMethod);
  let channels = { cash: 0, phonepe: 0, gpay: 0, razorpay: 0 };
  const reviewReasons = [];
  const breakdown = payment.paymentBreakdown;
  const validShape = breakdown == null || (typeof breakdown === "object" && (Object.getPrototypeOf(breakdown) === Object.prototype || Object.getPrototypeOf(breakdown) === null));
  if (!validShape) reviewReasons.push("Payment breakdown has an invalid format.");
  const seen = new Set();
  for (const [rawKey, rawValue] of Object.entries(validShape ? breakdown || {} : {})) {
    const key = normalizePaymentMethod(rawKey);
    const value = paise(rawValue ?? 0);
    if (!METHODS.includes(key)) {
      if (rawValue != null && value !== 0) reviewReasons.push(`Unsupported breakdown channel: ${rawKey}.`);
      continue;
    }
    if (value === null) {
      channels[key] = null;
      reviewReasons.push(`Invalid ${methodLabel(key)} amount.`);
    } else if (value > 0) {
      if (seen.has(key)) reviewReasons.push(`Duplicate ${methodLabel(key)} breakdown fields.`);
      else if (channels[key] !== null) channels[key] = value;
      seen.add(key);
    }
  }
  const positive = METHODS.filter((key) => channels[key] > 0);
  const method = sourceMethod === "mixed" || positive.length > 1 ? "mixed" : sourceMethod || positive[0] || "";
  if (amountPaise === null) reviewReasons.push("Payment amount is invalid or has fractional paise.");
  if (!sourceMethod) reviewReasons.push("Stored payment method is missing.");
  if (positive.length > 1 && sourceMethod !== "mixed") reviewReasons.push("Stored method differs from the multiple channels recorded.");
  // Established dashboard fallback: empty breakdown on a single known method
  // assigns its amount to that channel, only when no malformed fields exist.
  channels = allocateRevenuePayment({ paymentMethod: sourceMethod }, amountPaise, {
    channels, clearEmpty: false, includeUnspecified: false,
    canFallback: METHODS.includes(sourceMethod) && !reviewReasons.length && amountPaise !== null });
  const assigned = Object.values(channels).reduce((sum, value) => sum + (value || 0), 0);
  const channelFieldsValid = validShape && !reviewReasons.some((reason) => /^(Unsupported|Invalid|Duplicate)/.test(reason));
  let allocationValid = channelFieldsValid && amountPaise !== null && Object.values(channels).every((value) => value !== null) && Number.isSafeInteger(assigned) && assigned === amountPaise;
  if (method === "mixed" && positive.length < 2) {
    reviewReasons.push("Mixed payment does not identify multiple channel amounts.");
    allocationValid = false;
  }
  if (positive.length === 1 && method !== "mixed" && method !== positive[0]) {
    reviewReasons.push("Stored payment method conflicts with its breakdown.");
    allocationValid = false;
  }
  if (!METHODS.includes(method) && method !== "mixed") {
    reviewReasons.push("Payment method has no supported channel mapping.");
    allocationValid = false;
  }
  if (amountPaise !== null && assigned !== amountPaise) reviewReasons.push("Channel amounts do not equal the payment amount.");
  const allocatedPaise = Object.values(channels).every((value) => value !== null) && Number.isSafeInteger(assigned) ? assigned : null;
  const differencePaise = amountPaise !== null && allocatedPaise !== null ? amountPaise - allocatedPaise : null;
  return { sourceMethod, method, channels, amountPaise, allocatedPaise, differencePaise, allocationValid, reviewReasons: [...new Set(reviewReasons)] };
}

export function paymentReportRow(payment) {
  const classification = classifyPayment(payment);
  const { amountPaise: amount, method, channels, allocationValid, sourceMethod } = classification;
  const refund = payment.type === "refund";
  const receipt = RECEIPT_TYPES.has(payment.type);
  let pending = null;
  let collection = "unavailable";
  if (refund) collection = "refund";
  else if (receipt && allocationValid && sourceMethod === method && String(payment.paymentMethod || "").trim().toLowerCase() === method) {
    const cashCollected = paise(payment.collectedAmount ?? 0);
    const phonePeCollected = paise(payment.collectedPhonePe ?? 0);
    // Pure PhonePe mirrors its verification amount into collectedAmount.
    // Never add those two fields. Mixed isCollected refers to cash only.
    const validCash = cashCollected !== null && cashCollected <= channels.cash;
    const validPhonePe = phonePeCollected !== null && phonePeCollected <= channels.phonepe;
    const legacyConsistent = method === "phonepe"
      ? cashCollected === phonePeCollected && (!payment.isCollected || phonePeCollected === amount)
      : !payment.isCollected || cashCollected === channels.cash;
    if (channels.razorpay === 0 && channels.gpay === 0 && validPhonePe && (method === "phonepe" || validCash) && legacyConsistent) {
      pending = Math.max(0, channels.cash - (method === "phonepe" ? 0 : cashCollected)) + Math.max(0, channels.phonepe - phonePeCollected);
      collection = pending === 0 ? "settled" : (method !== "phonepe" && cashCollected > 0) || phonePeCollected > 0 ? "partial" : "pending";
    }
  }
  return { ...payment, ...classification, receipt, refund, pendingPaise: pending, collection, day: paymentDay(payment.createdAt) };
}

export function filterPaymentRows(rows, filters) {
  const query = filters.search.trim().toLowerCase();
  const digits = query.replace(/\D/g, "");
  const phoneQuery = /^[+\d\s().-]+$/.test(query) && digits.length >= 3;
  return rows.filter((row) => {
    if (filters.basis && !["payment", "created"].includes(filters.basis)) return false;
    const day = paymentBasisDay(row, filters.basis);
    if (filters.from && (!day || day < filters.from)) return false;
    if (filters.to && (!day || day > filters.to)) return false;
    if (filters.method !== "all" && row.method !== filters.method) return false;
    if (filters.collection !== "all" && row.collection !== filters.collection) return false;
    const bookingId = row.bookingId?._id || row.bookingId;
    const matchesText = [row.customer?.fullName, row.customer?.mobileNumber, row.vehicle?.vehicleName, row.vehicle?.vehicleNumber, row.note, row._id, bookingId, row.transactionId].filter(Boolean).join(" ").toLowerCase().includes(query);
    const matchesPhone = phoneQuery && String(row.customer?.mobileNumber || "").replace(/\D/g, "").includes(digits);
    if (query && !matchesText && !matchesPhone) return false;
    return true;
  });
}

export function summarizePayments(rows, { includeChannelSummary = true } = {}) {
  const receipts = rows.filter((row) => row.receipt);
  const refunds = rows.filter((row) => row.refund);
  const sumPaise = (items, getValue) => {
    let sum = 0;
    for (const row of items) {
      const value = getValue(row);
      if (value === null || !Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) return null;
      sum += value;
    }
    return sum / 100;
  };
  const total = (items) => sumPaise(items, (row) => row.amountPaise);
  const channelTotal = (key) => sumPaise(rows, (row) => row.channels[key]);
  const mixed = receipts.filter((row) => row.method === "mixed");
  return {
    count: rows.length, total: total(rows), refunds: total(refunds), refundCount: refunds.length,
    cash: channelTotal("cash"), phonepe: channelTotal("phonepe"), razorpay: channelTotal("razorpay"), gpay: channelTotal("gpay"),
    mixedCount: mixed.length, mixedValue: total(mixed),
    allocatedTotal: sumPaise(rows, (row) => row.allocatedPaise),
    // Keep shortfalls and excesses separate: opposite errors must not cancel.
    unallocatedTotal: sumPaise(rows, (row) => row.differencePaise === null ? null : Math.max(row.differencePaise, 0)),
    overallocatedTotal: sumPaise(rows, (row) => row.differencePaise === null ? null : Math.max(-row.differencePaise, 0)),
    unreconciledCount: rows.filter((row) => row.differencePaise === null || row.differencePaise !== 0).length,
    pending: sumPaise(receipts, (row) => row.pendingPaise),
    pendingCount: receipts.filter((row) => row.pendingPaise > 0).length,
    unavailableCount: receipts.filter((row) => row.pendingPaise === null).length,
    anomalyCount: rows.filter((row) => row.reviewReasons.length > 0 || !row.allocationValid || (!row.receipt && !row.refund)).length,
    ...(includeChannelSummary ? { channelSummary: summarizePayments(rows.filter((row) => !row.refund), { includeChannelSummary: false }) } : {}),
  };
}

const csvCell = (value) => {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export const paymentExportFilename = (now = new Date()) => `SAWARI_Payments_${paymentDay(now)}.csv`;

export function paymentCollectionDates(payment) {
  const dates = new Set();
  for (const event of Array.isArray(payment.collectionHistory) ? payment.collectionHistory : []) {
    if (!event || typeof event !== "object") continue;
    const date = event.collectedAt ? new Date(event.collectedAt) : null;
    if (date && Number.isFinite(date.getTime()) && typeof event.amount === "number" && Number.isFinite(event.amount) && event.amount > 0 && ["cash", "phonepe", "razorpay"].includes(event.channel || "cash")) dates.add(date.toISOString());
  }
  return [...dates].sort();
}

export function paymentTableRow(payment) {
  const row = paymentReportRow(payment);
  return { ...row, collectedPaise: row.pendingPaise === null || row.amountPaise === null ? null : row.amountPaise - row.pendingPaise, effectivePaymentDate: [row.customPaymentDate, row.paymentDate, row.createdAt].find((value) => value && Number.isFinite(new Date(value).getTime())) || null, collectionDates: paymentCollectionDates(row) };
}

export function paymentsCsv(rows) {
  const header = ["Payment ID", "Customer", "Mobile", "Vehicle", "Vehicle number", "Booking ID", "Payment Method", "Amount (INR)", "Payment Date (IST)", "Created Date (IST)", "Collected Amount (INR)", "Collection Status", "Collected Dates (IST)", "Recorded By", "Payment Breakdown (INR)", "Cash (INR)", "PhonePe (INR)", "GPay (INR)", "Razorpay (INR)", "Pending Collection (INR)", "Transaction ID", "Type", "Note", "Original method", "Review reasons"];
  const amount = (value) => Number.isSafeInteger(value) && value >= 0 ? (value / 100).toFixed(2) : "Unavailable";
  const statuses = { settled: "Collected", partial: "Partially Collected", pending: "Pending", unavailable: "Unknown", refund: "Refund" };
  const body = rows.map((source) => {
    const row = paymentTableRow(source);
    const breakdown = row.allocationValid ? PAYMENT_CHANNELS.filter((key) => row.channels[key] > 0).map((key) => `${methodLabel(key)} ${amount(row.channels[key])}`).join(" + ") : "Unverified";
    // Unsupported field names originate in external documents too. Keep their
    // values and names out of the export, including diagnostic text.
    const review = row.reviewReasons.map((reason) => reason.startsWith("Unsupported breakdown channel:") ? "Unsupported breakdown channel." : reason).join(" ");
    return [row._id, row.customer?.fullName, row.customer?.mobileNumber, row.vehicle?.vehicleName, row.vehicle?.vehicleNumber, row.bookingId, methodLabel(row.method), amount(row.amountPaise), formatPaymentDate(row.effectivePaymentDate), formatPaymentDate(row.createdAt), amount(row.collectedPaise), statuses[row.collection] || "Unverified", row.collectionDates.length ? row.collectionDates.map(formatPaymentDate).join("; ") : "No dated events", row.createdBy?.fullName || row.createdBy?.name, breakdown, ...PAYMENT_CHANNELS.map((key) => row.allocationValid ? amount(row.channels[key]) : "Unavailable"), amount(row.pendingPaise), row.transactionId, row.type, row.note, row.paymentMethod, review];
  });
  return "\uFEFF" + [header, ...body].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
