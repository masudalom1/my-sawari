import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js";
import ApiError from "../utils/ApiError.js";
import { classifyPayment, normalizePaymentMethod, PAYMENT_RECEIPT_TYPES } from "../../shared/paymentReporting.mjs";
import { toDayKey, addDayKeys, isValidDayKey } from "../utils/revenue.utils.js";

export const UPI_CHANNELS = ["phonepe", "gpay", "razorpay"];
const TABS = ["today", "yesterday", "pending", "completed", "all"];
const fields = "company bookingId customer vehicle amount paymentMethod paymentBreakdown type transactionId upiLast4 createdBy createdAt paymentDate customPaymentDate paymentTime collectedAmount collectedPhonePe isCollected isPhonePeCollected collectionHistory lastCollectedAt lastCollectedByName __v";
// Use the same deployment-owned access boundary as Cash Verification. A client
// cannot choose the company, collector or verification time.
export const upiScope = (user) => process.env.PAYMENTS_SCOPE_BY_COMPANY === "true"
  ? { company: user.company || user.createdBy || user._id } : {};
const paise = (value) => {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) && Math.abs(value * 100 - result) < 0.001 ? result : null;
};

export function parseUpiQuery(query = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new ApiError(400, "Invalid UPI filters");
  const allowed = ["tab", "method", "month", "date", "search", "page", "limit"];
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new ApiError(400, "Unknown UPI filter");
  const result = { tab: "pending", method: "all", month: "", date: "", search: "", page: "1", limit: "25", ...query };
  // Keep earlier clients compatible while the UI exposes exactly five tabs.
  if (result.tab === "verified") result.tab = "completed";
  if (Object.values(result).some((value) => typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) ||
    !TABS.includes(result.tab) || !["all", "mixed", ...UPI_CHANNELS].includes(result.method) || result.search.length > 120 ||
    (result.month && !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(result.month)) ||
    (result.date && !isValidDayKey(result.date)) || (result.month && result.date && !result.date.startsWith(`${result.month}-`)) ||
    !/^[1-9]\d{0,5}$/.test(result.page) || !["25", "50", "100", "all"].includes(result.limit)) {
    throw new ApiError(400, "Invalid UPI filters or page size");
  }
  return { ...result, search: result.search.trim(), page: Number(result.page) };
}

export function upiPaymentRow(payment) {
  const allocation = classifyPayment(payment);
  const method = normalizePaymentMethod(payment.paymentMethod);
  const reasons = [...allocation.reviewReasons];
  const audit = Array.isArray(payment.collectionHistory) ? payment.collectionHistory : [];
  const sums = { cash: 0, phonepe: 0, gpay: 0, razorpay: 0 };
  const verifiedAudit = [];
  const verifiedSums = { phonepe: 0, gpay: 0, razorpay: 0 };
  for (const entry of audit) {
    const channel = entry?.channel || "cash", amount = paise(entry?.amount);
    if (!Object.hasOwn(sums, channel) || amount === null || !Number.isSafeInteger(sums[channel] + amount)) reasons.push("Collection audit contains an invalid entry.");
    else {
      sums[channel] += amount;
      if (UPI_CHANNELS.includes(channel)) {
        // Only explicit digital verification actions with an actor and date
        // prove staff verification. Collection flags/counters alone do not.
        if (mongoose.isObjectIdOrHexString(entry.collectedBy) && entry.collectedAt && Number.isFinite(new Date(entry.collectedAt).getTime())) {
          verifiedSums[channel] += amount;
          verifiedAudit.push(entry);
        } else reasons.push("UPI verification audit is missing its staff member or timestamp; reconciliation is required.");
      }
    }
  }
  const cashRecorded = paise(payment.collectedAmount ?? 0);
  const phoneRecorded = paise(payment.collectedPhonePe ?? 0);
  if (cashRecorded === null || phoneRecorded === null) reasons.push("Recorded verification amounts are invalid.");
  if (UPI_CHANNELS.includes(method) && sums.cash > 0) reasons.push("Digital receipt contains a cash collection audit; reconciliation is required.");
  // Existing Revenue treats a nonempty audit as authoritative. Do not add an
  // event that would hide an older counter-only collection from its totals.
  if (method === "mixed" && (cashRecorded !== sums.cash || phoneRecorded !== sums.phonepe ||
    (payment.isCollected && cashRecorded !== allocation.channels.cash))) reasons.push("Legacy cash or PhonePe totals need reconciliation before UPI verification.");
  const verification = {};
  for (const channel of UPI_CHANNELS) {
    const amount = allocation.channels[channel] ?? 0;
    const stored = channel === "phonepe" ? phoneRecorded : method === channel ? cashRecorded : sums[channel];
    const recorded = Math.max(sums[channel], stored ?? 0);
    const collectedFlag = channel === "phonepe" ? payment.isPhonePeCollected || (method === channel && payment.isCollected)
      : method === channel && payment.isCollected;
    if (recorded > amount) reasons.push("Verified amount exceeds its recorded channel portion.");
    if (method === channel && (recorded !== sums[channel] || (channel === "phonepe" && cashRecorded !== phoneRecorded))) {
      reasons.push("Legacy verification totals lack a matching audit trail; reconciliation is required.");
    }
    const verifiedAmount = verifiedSums[channel];
    if (amount > 0 && collectedFlag && verifiedAmount < amount) reasons.push("Recorded collection is not proof of staff verification; the UPI audit needs reconciliation.");
    const history = verifiedAudit.filter((entry) => entry.channel === channel);
    verification[channel] = { amount: amount / 100, verifiedAmount: verifiedAmount / 100,
      remainingAmount: Math.max(0, amount - verifiedAmount) / 100,
      verified: allocation.allocationValid && amount > 0 && verifiedAmount === amount,
      history: history.map((entry) => ({ _id: entry._id, amount: entry.amount, note: entry.note,
        collectedByName: entry.collectedByName, collectedAt: entry.collectedAt })),
    };
  }
  const portions = Object.values(verification).filter((part) => part.amount > 0);
  const effectivePaymentDate = [payment.customPaymentDate, payment.paymentDate]
    .find((value) => value && Number.isFinite(new Date(value).getTime())) || null;
  const reviewReasons = [...new Set(reasons.map((reason) => reason.startsWith("Unsupported breakdown channel:") ? "Unsupported payment breakdown channel." : reason))];
  return { _id: payment._id, bookingId: payment.bookingId, customer: payment.customer, vehicle: payment.vehicle,
    type: payment.type, paymentMethod: method, amount: payment.amount,
    transactionId: payment.transactionId || "", upiLast4: payment.upiLast4 || [],
    createdBy: payment.createdBy, createdAt: payment.createdAt, effectivePaymentDate,
    paymentDay: effectivePaymentDate ? toDayKey(effectivePaymentDate) : null,
    verification, upiAmount: portions.reduce((sum, part) => sum + Math.round(part.amount * 100), 0) / 100,
    verifiedAmount: portions.reduce((sum, part) => sum + Math.round(part.verifiedAmount * 100), 0) / 100,
    remainingAmount: portions.reduce((sum, part) => sum + Math.round(part.remainingAmount * 100), 0) / 100,
    verified: portions.length > 0 && portions.every((part) => part.verified),
    canVerify: allocation.allocationValid && reviewReasons.length === 0 && portions.some((part) => part.remainingAmount > 0),
    reviewReasons,
  };
}

const summaryOf = (rows) => ({ count: rows.length,
  amount: rows.reduce((sum, row) => sum + Math.round(row.upiAmount * 100), 0) / 100,
  // A mixed receipt can contain both pending and completed components. Count
  // it in each applicable status, as the tabs do, but only once in the total.
  verified: { count: rows.filter((row) => row.visibleChannels.some((channel) => row.verification[channel].verified)).length, amount: rows.reduce((sum, row) => sum + Math.round(row.verifiedAmount * 100), 0) / 100 },
  pending: { count: rows.filter((row) => !row.verified).length, amount: rows.reduce((sum, row) => sum + Math.round(row.remainingAmount * 100), 0) / 100 },
  reviewCount: rows.filter((row) => row.reviewReasons.length > 0).length,
});

function scopeToChannels(row, channels) {
  const visibleChannels = channels.filter((channel) => row.verification[channel].amount > 0);
  const parts = visibleChannels.map((channel) => row.verification[channel]);
  const total = (key) => parts.reduce((sum, part) => sum + Math.round(part[key] * 100), 0) / 100;
  return { ...row, visibleChannels, upiAmount: total("amount"), verifiedAmount: total("verifiedAmount"),
    remainingAmount: total("remainingAmount"), verified: parts.length > 0 && parts.every((part) => part.verified),
    canVerify: row.canVerify && parts.some((part) => !part.verified && part.remainingAmount > 0) };
}

export async function readUpiView(user, query) {
  const filter = parseUpiQuery(query);
  const payments = await PaymentHistory.find({ ...upiScope(user), type: { $in: PAYMENT_RECEIPT_TYPES },
    paymentMethod: { $in: [...UPI_CHANNELS, "mixed"] } }).select(fields).populate("createdBy", "fullName username").lean();
  const today = toDayKey(new Date()), yesterday = addDayKeys(today, -1);
  const search = filter.search.toLowerCase();
  const paymentRows = payments.map(upiPaymentRow);
  // Each method is a facet of the same date/search/status selection. Scope
  // mixed receipts to their digital portion before applying channel status.
  const matchesForMethod = (method) => paymentRows.map((row) => {
    return scopeToChannels(row, UPI_CHANNELS.includes(method) ? [method] : UPI_CHANNELS);
  }).filter((row) => row.upiAmount > 0 &&
    (method === "all" || (method === "mixed" ? row.paymentMethod === "mixed" : row.verification[method].amount > 0)) &&
    (!filter.month || row.paymentDay?.startsWith(`${filter.month}-`)) && (!filter.date || row.paymentDay === filter.date) &&
    (!search || [row.customer?.fullName, row.customer?.mobileNumber, row.vehicle?.vehicleName, row.vehicle?.vehicleNumber,
      row._id, row.bookingId, row.transactionId, ...row.upiLast4, row.upiAmount, row.remainingAmount]
      .some((value) => String(value ?? "").toLowerCase().includes(search))));
  const forTab = (matches, tab) => {
    if (tab === "today" || tab === "yesterday") return matches.filter((row) => row.paymentDay === (tab === "today" ? today : yesterday));
    if (tab !== "pending" && tab !== "completed") return matches;
    return matches.map((row) => scopeToChannels(row, row.visibleChannels.filter((channel) =>
      row.verification[channel].verified === (tab === "completed")))).filter((row) => row.upiAmount > 0);
  };
  const methods = Object.fromEntries(["all", ...UPI_CHANNELS].map((method) => [method, matchesForMethod(method)]));
  const matches = methods[filter.method] || matchesForMethod(filter.method);
  const rows = forTab(matches, filter.tab).sort((a, b) => new Date(b.effectivePaymentDate || 0) - new Date(a.effectivePaymentDate || 0) || String(b._id).localeCompare(String(a._id)));
  const methodTotals = Object.fromEntries(Object.entries(methods).map(([method, matches]) => {
    const { amount, count } = summaryOf(forTab(matches, filter.tab));
    return [method, { amount, count }];
  }));
  const totalPages = filter.limit === "all" ? 1 : Math.max(1, Math.ceil(rows.length / Number(filter.limit)));
  const page = filter.limit === "all" ? 1 : Math.min(filter.page, totalPages), skip = filter.limit === "all" ? 0 : (page - 1) * Number(filter.limit);
  const data = filter.limit === "all" ? rows : rows.slice(skip, skip + Number(filter.limit));
  const dates = new Map();
  for (const row of data) {
    if (!dates.has(row.paymentDay)) dates.set(row.paymentDay, { date: row.paymentDay, payments: [] });
    dates.get(row.paymentDay).payments.push(row);
  }
  const stats = Object.fromEntries(TABS.map((tab) => [tab, summaryOf(forTab(matches, tab))]));
  return { success: true, data, groups: [...dates.values()], total: rows.length, summary: summaryOf(rows), methodTotals,
    stats: { ...stats, verified: stats.completed },
    pagination: { page, pageSize: filter.limit === "all" ? "all" : Number(filter.limit), total: rows.length, totalPages,
      from: rows.length ? skip + 1 : 0, to: skip + data.length }, today, yesterday };
}

export async function verifyUpi(user, id, body = {}) {
  if (!mongoose.isObjectIdOrHexString(id)) throw new ApiError(400, "Invalid payment ID");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Invalid verification request");
  const { channel, amount, expectedVerifiedAmount, confirmed, note = "", view } = body;
  if (view !== undefined) parseUpiQuery(view);
  if (Object.keys(body).some((key) => !["channel", "amount", "expectedVerifiedAmount", "confirmed", "note", "view"].includes(key)) ||
    !UPI_CHANNELS.includes(channel) || confirmed !== true || typeof amount !== "number" || paise(amount) === null || amount <= 0 ||
    typeof expectedVerifiedAmount !== "number" || paise(expectedVerifiedAmount) === null || typeof note !== "string" || note.length > 500) {
    throw new ApiError(400, "Confirm a valid UPI channel and amount with the current verified balance");
  }
  const payment = await PaymentHistory.findOne({ _id: id, ...upiScope(user), type: { $in: PAYMENT_RECEIPT_TYPES } }).select(fields).lean();
  if (!payment) throw new ApiError(404, "Payment not found");
  const row = upiPaymentRow(payment), portion = row.verification[channel];
  if (!portion.amount) throw new ApiError(400, "This payment has no amount for that UPI channel");
  if (portion.verified || portion.verifiedAmount !== expectedVerifiedAmount) throw new ApiError(409, "Verification changed. Refresh before verifying again.");
  if (!row.canVerify) throw new ApiError(409, "This payment needs reconciliation before verification");
  if (paise(amount) > paise(portion.remainingAmount)) throw new ApiError(400, "Amount exceeds the unverified UPI portion");
  const now = new Date(), name = user.fullName || user.name || user.username || "Staff";
  const total = (paise(portion.verifiedAmount) + paise(amount)) / 100;
  const set = {};
  if (channel === "phonepe") { set.collectedPhonePe = total; set.isPhonePeCollected = total === portion.amount; }
  if (row.paymentMethod === channel) Object.assign(set, { collectedAmount: total, isCollected: total === portion.amount,
    lastCollectedAt: now, lastCollectedBy: user._id, lastCollectedByName: name });
  const stored = (value) => value === undefined ? { $exists: false } : value;
  // Compare the complete snapshot that determined eligibility. Cash and UPI
  // audit appends bump __v, so concurrent actions cannot overwrite each other.
  const guard = Object.fromEntries(["__v", "collectedAmount", "collectedPhonePe", "isCollected", "isPhonePeCollected", "amount", "paymentMethod", "paymentBreakdown"]
    .map((key) => [key, stored(payment[key])]));
  const saved = await PaymentHistory.findOneAndUpdate({ _id: id, ...upiScope(user), ...guard,
    $expr: { $eq: [{ $size: { $ifNull: ["$collectionHistory", []] } }, (payment.collectionHistory || []).length] } },
  { ...(Object.keys(set).length ? { $set: set } : {}), $inc: { __v: 1 }, $push: { collectionHistory: {
    channel, amount, collectedBy: user._id, collectedByName: name, collectedAt: now, note: note.trim(),
  } } }, { new: true, runValidators: true }).select(fields).lean();
  if (!saved) throw new ApiError(409, "Payment changed during verification. Refresh and try again.");
  let updatedView = null;
  if (view !== undefined) {
    try { updatedView = await readUpiView(user, view); }
    catch { console.error("UPI verification saved; updated view unavailable", { paymentId: id }); }
  }
  return { success: true, data: { paymentId: id, channel, transactionAmount: amount,
    verifiedAmount: total, remainingAmount: (paise(portion.amount) - paise(total)) / 100, verifiedBy: name, verifiedAt: now }, view: updatedView };
}
