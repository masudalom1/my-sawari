import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js";
import ApiError from "../utils/ApiError.js";
import { normalizePaymentMethod, paymentPeriodRange, paymentCreatedAtRange, validPaymentDateRange, paymentReportRow, paymentTableRow, paymentCollectionDates as collectionEventDates, paymentsCsv, summarizePayments } from "../../shared/paymentReporting.mjs";
export { paymentCollectionDates as collectionEventDates } from "../../shared/paymentReporting.mjs";
import { derivedPaymentMatch, paymentClassificationStages, paymentMethodsStages, paymentSort, paymentSummaryStages } from "./paymentReport.pipeline.js";
import { resolvePaymentReportScope } from "./paymentReportScope.js";

const SORTS = new Set(["newest", "oldest", "highest", "lowest"]);
const QUERY_KEYS = new Set(["period", "dateBasis", "startDate", "endDate", "method", "collectionStatus", "search", "page", "limit", "sort", "basis", "from", "to", "collection"]);
const FIELDS = { company: 1, bookingId: 1, handoverId: 1, "customer.fullName": 1, "customer.mobileNumber": 1, "vehicle.vehicleId": 1, "vehicle.vehicleName": 1, "vehicle.vehicleNumber": 1, "booking.fromDate": 1, "booking.toDate": 1, "booking.bookingAmount": 1, amount: 1, paymentMethod: 1, paymentBreakdown: 1, type: 1, note: 1, transactionId: 1, upiLast4: 1, isCollected: 1, collectedAmount: 1, collectedPhonePe: 1, "collectionHistory._id": 1, "collectionHistory.channel": 1, "collectionHistory.amount": 1, "collectionHistory.note": 1, "collectionHistory.collectedBy": 1, "collectionHistory.collectedByName": 1, "collectionHistory.collectedAt": 1, lastCollectedAt: 1, createdBy: 1, customPaymentDate: 1, paymentDate: 1, createdAt: 1, updatedAt: 1 };
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function textParam(query, key, fallback = "", max = 120) {
  const value = Object.hasOwn(query, key) ? query[key] : fallback;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, `Invalid ${key}`);
  return value;
}

export function parsePaymentReport(query, user, now = new Date()) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new ApiError(400, "Invalid report query");
  const { company, source: scopeSource } = resolvePaymentReportScope(user);
  for (const key of Object.keys(query)) {
    if (["company", "companyId", "tenant", "tenantId"].includes(key)) throw new ApiError(400, "Company scope cannot be selected in this report");
    if (!QUERY_KEYS.has(key)) throw new ApiError(400, `Unknown report parameter: ${key}`);
  }
  const alias = (canonical, legacy, normalize = (value) => value, fallback = "") => {
    const a = Object.hasOwn(query, canonical) ? normalize(textParam(query, canonical)) : undefined;
    const b = Object.hasOwn(query, legacy) ? normalize(textParam(query, legacy)) : undefined;
    if (a !== undefined && b !== undefined && a !== b) throw new ApiError(400, `Conflicting ${canonical} and ${legacy}`);
    return a ?? b ?? fallback;
  };
  if (Object.hasOwn(query, "dateBasis") && !["paymentDate", "createdAt", "collectedDate"].includes(textParam(query, "dateBasis"))) throw new ApiError(400, "Invalid dateBasis");
  if (Object.hasOwn(query, "basis") && !["payment", "created", "collected"].includes(textParam(query, "basis"))) throw new ApiError(400, "Invalid basis");
  const dateBases = { paymentDate: "payment", createdAt: "created", collectedDate: "collected", payment: "payment", created: "created", collected: "collected" };
  const basis = alias("dateBasis", "basis", (value) => Object.hasOwn(dateBases, value) ? dateBases[value] : "invalid", "created");
  if (basis === "invalid") throw new ApiError(400, "Invalid date basis");
  if (basis === "collected") throw new ApiError(400, "Historical collected-date reporting is unavailable: complete dated collection events are required");
  let from = alias("startDate", "from");
  let to = alias("endDate", "to");
  for (const key of ["startDate", "from", "endDate", "to"]) if (Object.hasOwn(query, key) && !textParam(query, key)) throw new ApiError(400, `Invalid ${key}`);
  if ((from && !validPaymentDateRange(from, from)) || (to && !validPaymentDateRange(to, to)) || (from && to && from > to)) throw new ApiError(400, "Invalid report date range");
  const period = Object.hasOwn(query, "period") ? textParam(query, "period") : null;
  if (period && !["all", "today", "yesterday", "week", "month", "custom"].includes(period)) throw new ApiError(400, "Invalid report period");
  if (period === "") throw new ApiError(400, "Invalid report period");
  if (period === "all" && (from || to)) throw new ApiError(400, "All period cannot include date bounds");
  if (period === "custom" && (!from || !to)) throw new ApiError(400, "Custom period requires startDate and endDate");
  if (period && !["custom", "all"].includes(period)) {
    const range = paymentPeriodRange(period, now);
    if ((from && from !== range.from) || (to && to !== range.to)) throw new ApiError(400, "Explicit dates conflict with the selected period");
    ({ from, to } = range);
  }
  const pageText = textParam(query, "page", "1");
  const limitText = textParam(query, "limit", "25");
  const page = Number(pageText);
  const limit = Number(limitText);
  if (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new ApiError(400, "Invalid page");
  if (!/^\d+$/.test(limitText) || ![10, 25, 50, 100].includes(limit)) throw new ApiError(400, "Page size must be 10, 25, 50 or 100");
  const sort = textParam(query, "sort", "newest");
  if (!SORTS.has(sort)) throw new ApiError(400, "Invalid report sort");
  const method = normalizePaymentMethod(textParam(query, "method", "all", 80));
  if (!method) throw new ApiError(400, "Invalid payment method");
  if (Object.hasOwn(query, "collectionStatus") && !["all", "collected", "pending", "partial"].includes(textParam(query, "collectionStatus"))) throw new ApiError(400, "Invalid collectionStatus");
  const collection = alias("collectionStatus", "collection", (value) => value === "collected" ? "settled" : value, "all");
  if (!["all", "settled", "pending", "partial", "unavailable", "refund"].includes(collection)) throw new ApiError(400, "Invalid collection status");
  const search = textParam(query, "search").trim();
  const match = { company: new mongoose.Types.ObjectId(String(company)) };
  if (from || to) match.createdAt = paymentCreatedAtRange(from, to);
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    match.$or = ["customer.fullName", "customer.mobileNumber", "vehicle.vehicleName", "vehicle.vehicleNumber", "transactionId", "note"].map((field) => ({ [field]: regex }));
    for (const field of ["_id", "bookingId"]) match.$or.push({ $expr: { $regexMatch: { input: { $convert: { input: `$${field}`, to: "string", onError: "", onNull: "" } }, regex: escapeRegex(search), options: "i" } } });
    const digits = search.replace(/\D/g, "");
    if (/^[+\d\s().-]+$/.test(search) && digits.length >= 3) match.$or.push({ "customer.mobileNumber": new RegExp(digits.split("").join("[\\s()+.\\-]*")) });
  }
  return { page, limit, sort, basis, from, to, period, search, method, collection, match, scopeSource };
}

function reportCursor(params, signal) {
  const pipeline = reportBase(params);
  pipeline.push(...derivedPaymentMatch(params));
  if (["highest", "lowest"].includes(params.sort)) pipeline.push(paymentSort(params.sort));
  pipeline.push({ $project: FIELDS });
  return PaymentHistory.aggregate(pipeline).allowDiskUse(true).option({ maxTimeMS: 30000, ...(signal ? { signal } : {}) }).cursor({ batchSize: 100 });
}

function reportBase(params) {
  // Payment documents are the reporting source. Never require a Vehicle join or
  // active vehicle ID: missing/deleted vehicle references must not erase money.
  const stages = [{ $match: params.match }];
  // Keep date sorts ahead of expressions so the company/date/ID index can
  // supply ordered reads. Amount ordering uses validated integer paise.
  if (["newest", "oldest"].includes(params.sort)) stages.push(paymentSort(params.sort));
  stages.push({ $project: FIELDS }, ...paymentClassificationStages());
  return stages;
}

export function buildPaymentReportPipeline(params, { summaryOnly = false } = {}) {
  const derived = derivedPaymentMatch(params);
  const facets = { summary: [...derived, ...paymentSummaryStages()], methods: paymentMethodsStages() };
  if (!summaryOnly) facets.data = [...derived, ...(["highest", "lowest"].includes(params.sort) ? [paymentSort(params.sort)] : []), { $skip: (params.page - 1) * params.limit }, { $limit: params.limit }, { $project: FIELDS }];
  return [...reportBase(params), { $facet: facets }];
}

export async function loadPaymentReport(params, signal, options = {}) {
  const { summaryOnly = false } = options;
  signal?.throwIfAborted();
  let result;
  try {
    result = await PaymentHistory.aggregate(buildPaymentReportPipeline(params, options)).allowDiskUse(true).option({ maxTimeMS: 30000, ...(signal ? { signal } : {}) }).exec();
  } catch (error) {
    if (error.code === 50) throw new ApiError(503, "Payment reporting timed out; narrow the date range and retry");
    throw error;
  }
  signal?.throwIfAborted();
  const aggregate = result[0] || {};
  const { totalMatchingRecords: total = 0, ...computed } = aggregate.summary?.[0] || {};
  const summary = { ...summarizePayments([]), ...computed };
  const defaults = ["all", "cash", "phonepe", "razorpay", "mixed"];
  const observed = aggregate.methods?.[0];
  const methods = [...defaults, ...[...new Set([...(observed?.methods || []), ...(observed?.hasGpay ? ["gpay"] : [])])].filter((method) => method && !defaults.includes(method)).sort()];
  const data = (aggregate.data || []).map(paymentTableRow);
  await PaymentHistory.populate(data, { path: "createdBy", select: "fullName name email" });
  const metadata = { summary, methods, totalMatchingRecords: total, scopeSource: params.scopeSource, basis: params.basis, dateBasis: "createdAt", period: params.period, range: { startDate: params.from || null, endDate: params.to || null }, timezone: "Asia/Kolkata", collectionDateReporting: { supported: false, reason: "Historical event coverage is incomplete" } };
  return summaryOnly ? metadata : { ...metadata, data, pagination: { page: params.page, limit: params.limit, total, totalPages: Math.max(1, Math.ceil(total / params.limit)), hasMore: params.page * params.limit < total } };
}

export async function* exportPaymentReport(params, signal) {
  yield paymentsCsv([]) + "\r\n";
  const cursor = reportCursor(params, signal);
  let batch = [];
  const encodeBatch = async (rows) => {
    await PaymentHistory.populate(rows, { path: "createdBy", select: "fullName name" });
    const csv = paymentsCsv(rows);
    return csv.slice(csv.indexOf("\r\n") + 2) + "\r\n";
  };
  try {
    for await (const payment of cursor) {
      signal?.throwIfAborted();
      const row = paymentReportRow(payment);
      batch.push(row);
      if (batch.length === 100) { yield await encodeBatch(batch); batch = []; }
    }
    if (batch.length) yield await encodeBatch(batch);
  } finally { await cursor.close(); }
}

// Deliberately narrower than a raw payment document. Do not populate booking,
// vehicle or customer documents: they may contain identity documents or PII
// outside this report's established name/mobile/vehicle snapshot permissions.
const DETAIL_FIELDS = "_id bookingId handoverId customer.fullName customer.mobileNumber vehicle.vehicleName vehicle.vehicleNumber amount paymentMethod paymentBreakdown type note transactionId upiLast4 isCollected collectedAmount collectedPhonePe collectionHistory._id collectionHistory.channel collectionHistory.amount collectionHistory.note collectionHistory.collectedBy collectionHistory.collectedByName collectionHistory.collectedAt lastCollectedAt lastCollectedBy createdBy customPaymentDate paymentDate createdAt updatedAt";
const text = (value) => typeof value === "string" ? value : null;
const reference = (value) => value instanceof mongoose.Types.ObjectId ? value.toHexString() : text(value);
const timestamp = (value) => {
  if (!value || !["string", "object"].includes(typeof value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export async function loadPaymentDetail(id, company) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, "Invalid payment id");
  const payment = await PaymentHistory.findOne({ _id: id, company }).select(DETAIL_FIELDS).lean();
  // Same response for missing and inaccessible records avoids tenant disclosure.
  if (!payment) throw new ApiError(404, "Payment not found");
  const row = paymentReportRow(payment);
  const history = Array.isArray(payment.collectionHistory) ? payment.collectionHistory.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
  const actorIds = [...new Set([payment.createdBy, payment.lastCollectedBy, ...history.map((entry) => entry.collectedBy)].map(reference).filter((value) => mongoose.isValidObjectId(value)))];
  const User = mongoose.model("User");
  const users = await User.find({ _id: { $in: actorIds } }).select("_id fullName name").lean();
  const names = new Map(users.map((user) => [String(user._id), text(user.fullName) || text(user.name)]));
  const actor = (idValue, nameSnapshot) => {
    const actorId = reference(idValue);
    return { id: actorId, name: text(nameSnapshot) || names.get(actorId) || null };
  };
  return {
    id: String(payment._id),
    customer: { name: text(payment.customer?.fullName), mobile: text(payment.customer?.mobileNumber), bookingId: reference(payment.bookingId) },
    vehicle: { name: text(payment.vehicle?.vehicleName), registration: text(payment.vehicle?.vehicleNumber) },
    payment: { amount: row.amountPaise === null ? null : row.amountPaise / 100, method: row.method, originalMethod: text(payment.paymentMethod), transactionId: text(payment.transactionId), paymentDate: timestamp(paymentTableRow(payment).effectivePaymentDate), createdDate: timestamp(payment.createdAt), note: text(payment.note), type: text(payment.type), refund: row.refund },
    breakdown: Object.entries(row.channels).map(([channel, amount]) => ({ channel, amount: amount === null ? null : amount / 100 })),
    allocationValid: row.allocationValid,
    reviewReasons: row.reviewReasons,
    collection: {
      amount: row.pendingPaise === null || row.amountPaise === null ? null : (row.amountPaise - row.pendingPaise) / 100,
      outstanding: row.pendingPaise === null ? null : row.pendingPaise / 100,
      status: row.collection, dates: collectionEventDates(row), lastRecordedAt: timestamp(payment.lastCollectedAt),
      lastCollector: actor(payment.lastCollectedBy),
      history: history.map((entry) => ({ id: reference(entry._id), channel: text(entry.channel) || "cash", amount: typeof entry.amount === "number" && Number.isFinite(entry.amount) && entry.amount >= 0 ? entry.amount : null, collectedAt: timestamp(entry.collectedAt), collector: actor(entry.collectedBy, entry.collectedByName), note: text(entry.note) })),
    },
    audit: { createdBy: actor(payment.createdBy), createdAt: timestamp(payment.createdAt), updatedAt: timestamp(payment.updatedAt), vehicleHandoverId: reference(payment.handoverId), settlementReferences: [] },
    timezone: "Asia/Kolkata",
    readOnly: true,
  };
}
