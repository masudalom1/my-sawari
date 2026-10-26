// Native MongoDB execution of the shared reporting contract. Policy values are
// shared; parity tests compare expressions against the existing JS classifier.
// No server-side JavaScript ($function/$where) or transaction/event unwinding.
import { PAYMENT_CHANNELS as CHANNELS, PAYMENT_METHOD_ALIASES as ALIASES, PAYMENT_RECEIPT_TYPES, PAYMENT_MAX_PAISE as MAX, PAYMENT_PAISE_EPSILON as EPSILON } from "../../../shared/paymentReporting.mjs";
import { allocateRevenuePayment, revenuePaymentAmount as paymentAmount, mongoAllocationMath } from "./paymentAllocation.service.js";

const WHITESPACE = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const eq = (a, b) => ({ $eq: [a, b] });
const ne = (a, b) => ({ $ne: [a, b] });
const and = (...conditions) => ({ $and: conditions });
const or = (...conditions) => ({ $or: conditions });
const not = (condition) => ({ $not: [condition] });
const gt = (a, b) => ({ $gt: [a, b] });
const size = (value) => ({ $size: value });
const known = (value) => ({ $in: [value, CHANNELS] });
const filter = (input, cond, as = "entry") => ({ $filter: { input, as, cond } });
const any = (input, cond) => gt(size(filter(input, cond)), 0);
const trim = (value) => ({ $trim: { input: value, chars: WHITESPACE } });
const rawToken = (value) => ({ $cond: [eq({ $type: value }, "string"), { $toLower: trim(value) }, ""] });

export function mongoPaymentMethod(value) {
  // A JS-built chain of replaceAll expressions exceeds Atlas's BSON depth
  // limit. MongoDB's reduce keeps the same normalization at constant depth.
  return { $let: { vars: { token: rawToken(value) }, in: { $let: { vars: { compact: { $reduce: { input: [...WHITESPACE, "_", "-"], initialValue: "$$token", in: { $replaceAll: { input: "$$value", find: "$$this", replacement: "" } } } } }, in: { $switch: { branches: Object.entries(ALIASES).map(([alias, method]) => ({ case: eq("$$compact", alias), then: method })), default: "$$token" } } } } } };
}

export function mongoPaise(value) {
  return { $let: { vars: { raw: value }, in: { $let: { vars: { input: { $cond: [eq({ $type: "$$raw" }, "string"), trim("$$raw"), "$$raw"] } }, in: { $let: { vars: { number: { $convert: { input: "$$input", to: "double", onError: null, onNull: null } } }, in: { $cond: [and(
    or({ $in: [{ $type: "$$raw" }, ["double", "int", "long"]] }, and(eq({ $type: "$$raw" }, "string"), { $regexMatch: { input: { $cond: [eq({ $type: "$$input" }, "string"), "$$input", ""] }, regex: "^\\d+(?:\\.\\d+)?$" } })),
    ne("$$number", null), { $gte: ["$$number", 0] }, { $lte: ["$$number", MAX / 100] },
    { $lt: [{ $abs: { $subtract: [{ $multiply: ["$$number", 100] }, { $round: [{ $multiply: ["$$number", 100] }, 0] }] } }, EPSILON] }
  ), { $round: [{ $multiply: ["$$number", 100] }, 0] }, null] } } } } } } };
}

const entries = (key) => filter("$_pr.pairs", eq("$$entry.method", key));
const positiveEntries = (key) => filter(entries(key), gt("$$entry.amount", 0));
const channelExpression = (key) => ({ $cond: [any(entries(key), eq("$$entry.amount", null)), null, { $ifNull: [{ $arrayElemAt: [{ $map: { input: positiveEntries(key), as: "entry", in: "$$entry.amount" } }, 0] }, 0] }] });

export function paymentClassificationStages() {
  const posCount = size("$_pr.positive");
  const flag = not({ $in: [{ $ifNull: ["$isCollected", null] }, [false, null, 0, "", NaN]] });
  const cashValid = and(ne("$_pr.cashCollected", null), { $lte: ["$_pr.cashCollected", "$_pr.channels.cash"] });
  const phoneValid = and(ne("$_pr.phonePeCollected", null), { $lte: ["$_pr.phonePeCollected", "$_pr.channels.phonepe"] });
  const legacyConsistent = { $cond: [eq("$_pr.method", "phonepe"), and(eq("$_pr.cashCollected", "$_pr.phonePeCollected"), or(not(flag), eq("$_pr.phonePeCollected", "$_pr.amount"))), or(not(flag), eq("$_pr.cashCollected", "$_pr.channels.cash"))] };
  return [
    { $set: { _pr: {
      source: mongoPaymentMethod("$paymentMethod"), rawMethod: rawToken("$paymentMethod"), amount: paymentAmount({ amount: "$amount" }, { parseAmount: mongoPaise, fallbackToBreakdown: false }),
      shape: { $in: [{ $type: "$paymentBreakdown" }, ["missing", "null", "object"]] },
      receipt: { $in: ["$type", PAYMENT_RECEIPT_TYPES] }, refund: eq("$type", "refund"),
      cashCollected: mongoPaise({ $ifNull: ["$collectedAmount", 0] }), phonePeCollected: mongoPaise({ $ifNull: ["$collectedPhonePe", 0] }),
      pairs: { $map: { input: { $objectToArray: { $cond: [eq({ $type: "$paymentBreakdown" }, "object"), "$paymentBreakdown", {}] } }, as: "entry", in: { method: mongoPaymentMethod("$$entry.k"), amount: mongoPaise({ $ifNull: ["$$entry.v", 0] }), hasValue: ne({ $ifNull: ["$$entry.v", null] }, null) } } },
    } } },
    { $set: {
      "_pr.channels": Object.fromEntries(CHANNELS.map((key) => [key, channelExpression(key)])),
      "_pr.bad": or(any("$_pr.pairs", or(and(known("$$entry.method"), eq("$$entry.amount", null)), and(not(known("$$entry.method")), "$$entry.hasValue", ne("$$entry.amount", 0)))), ...CHANNELS.map((key) => gt(size(positiveEntries(key)), 1))),
    } },
    { $set: { "_pr.positive": { $concatArrays: CHANNELS.map((key) => ({ $cond: [gt(`$_pr.channels.${key}`, 0), [key], []] })) } } },
    { $set: {
      "_pr.method": { $cond: [or(eq("$_pr.source", "mixed"), gt(posCount, 1)), "mixed", { $cond: [ne("$_pr.source", ""), "$_pr.source", { $ifNull: [{ $arrayElemAt: ["$_pr.positive", 0] }, ""] }] }] },
      "_pr.channels": allocateRevenuePayment({ paymentMethod: "$_pr.source" }, "$_pr.amount", {
        channels: Object.fromEntries(CHANNELS.map((key) => [key, `$_pr.channels.${key}`])),
        clearEmpty: false, includeUnspecified: false, math: mongoAllocationMath,
        canFallback: and(known("$_pr.source"), "$_pr.shape", not("$_pr.bad"), ne("$_pr.amount", null)),
      }),
    } },
    { $set: { "_pr.assigned": { $add: CHANNELS.map((key) => ({ $ifNull: [`$_pr.channels.${key}`, 0] })) } } },
    { $set: { "_pr.allocated": { $cond: [and(...CHANNELS.map((key) => ne(`$_pr.channels.${key}`, null)), { $lte: ["$_pr.assigned", MAX] }), "$_pr.assigned", null] } } },
    { $set: { "_pr.difference": { $cond: [and(ne("$_pr.amount", null), ne("$_pr.allocated", null)), { $subtract: ["$_pr.amount", "$_pr.allocated"] }, null] } } },
    { $set: { "_pr.allocation": and("$_pr.shape", not("$_pr.bad"), ne("$_pr.amount", null), ...CHANNELS.map((key) => ne(`$_pr.channels.${key}`, null)), { $lte: ["$_pr.assigned", MAX] }, eq("$_pr.assigned", "$_pr.amount"), { $cond: [eq("$_pr.method", "mixed"), { $gte: [posCount, 2] }, and(known("$_pr.method"), or(ne(posCount, 1), eq("$_pr.method", { $arrayElemAt: ["$_pr.positive", 0] })))] }) } },
    { $set: {
      "_pr.anomaly": or(not("$_pr.allocation"), eq("$_pr.source", ""), and(gt(posCount, 1), ne("$_pr.source", "mixed")), and(not("$_pr.receipt"), not("$_pr.refund"))),
      "_pr.pending": { $cond: [and("$_pr.receipt", "$_pr.allocation", eq("$_pr.source", "$_pr.method"), eq("$_pr.rawMethod", "$_pr.method"), eq("$_pr.channels.razorpay", 0), eq("$_pr.channels.gpay", 0), phoneValid, or(eq("$_pr.method", "phonepe"), cashValid), legacyConsistent), { $add: [{ $max: [0, { $subtract: ["$_pr.channels.cash", { $cond: [eq("$_pr.method", "phonepe"), 0, "$_pr.cashCollected"] }] }] }, { $max: [0, { $subtract: ["$_pr.channels.phonepe", "$_pr.phonePeCollected"] }] }] }, null] },
      "_pr.amountMissing": { $cond: [eq("$_pr.amount", null), 1, 0] },
    } },
    { $set: { "_pr.collection": { $switch: { branches: [{ case: "$_pr.refund", then: "refund" }, { case: eq("$_pr.pending", null), then: "unavailable" }, { case: eq("$_pr.pending", 0), then: "settled" }, { case: or(and(ne("$_pr.method", "phonepe"), gt("$_pr.cashCollected", 0)), gt("$_pr.phonePeCollected", 0)), then: "partial" }], default: "pending" } } } },
  ];
}

export function derivedPaymentMatch(params) {
  const match = {};
  if (params.method !== "all") match["_pr.method"] = params.method;
  if (params.collection !== "all") match["_pr.collection"] = params.collection;
  return Object.keys(match).length ? [{ $match: match }] : [];
}

export function paymentSummaryStages({ includeChannelSummary = true } = {}) {
  const mixed = and("$_pr.receipt", eq("$_pr.method", "mixed"));
  const count = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
  const group = { _id: null, totalMatchingRecords: { $sum: 1 }, count: { $sum: 1 }, refundCount: count("$_pr.refund"), mixedCount: count(mixed), pendingCount: count(and("$_pr.receipt", gt("$_pr.pending", 0))), unavailableCount: count(and("$_pr.receipt", eq("$_pr.pending", null))), anomalyCount: count("$_pr.anomaly") };
  const values = { total: [true, "$_pr.amount"], refunds: ["$_pr.refund", "$_pr.amount"], mixedValue: [mixed, "$_pr.amount"], pending: ["$_pr.receipt", "$_pr.pending"], ...Object.fromEntries(CHANNELS.map((key) => [key, [true, `$_pr.channels.${key}`]])) };
  const project = { _id: 0, totalMatchingRecords: 1, count: 1, refundCount: 1, mixedCount: 1, pendingCount: 1, unavailableCount: 1, anomalyCount: 1 };
  group.unreconciledCount = count(or(eq("$_pr.difference", null), ne("$_pr.difference", 0)));
  project.unreconciledCount = 1;
  Object.assign(values, {
    allocatedTotal: [true, "$_pr.allocated"],
    unallocatedTotal: [true, { $cond: [eq("$_pr.difference", null), null, { $max: [0, "$_pr.difference"] }] }],
    overallocatedTotal: [true, { $cond: [eq("$_pr.difference", null), null, { $max: [0, { $multiply: [-1, "$_pr.difference"] }] }] }],
  });
  for (const [key, [condition, value]] of Object.entries(values)) {
    group[`${key}Sum`] = { $sum: { $cond: [condition, value, 0] } };
    group[`${key}Invalid`] = { $max: { $cond: [and(condition, eq(value, null)), 1, 0] } };
    project[key] = { $cond: [or(gt(`$${key}Invalid`, 0), gt(`$${key}Sum`, MAX)), null, { $divide: [`$${key}Sum`, 100] }] };
  }
  if (includeChannelSummary) {
    // Keep the table's all-record totals intact. Compute the chart's non-refund
    // totals and review flags in the same group, before pagination, with no unwind.
    const [{ $group: chartGroup }, { $project: chartProject }] = paymentSummaryStages({ includeChannelSummary: false });
    for (const [key, accumulator] of Object.entries(chartGroup)) {
      if (key === "_id" || key === "totalMatchingRecords") continue;
      const [operator, value] = Object.entries(accumulator)[0];
      group[`_chart_${key}`] = { [operator]: { $cond: [not("$_pr.refund"), value, 0] } };
    }
    const chartReference = (value) => {
      if (typeof value === "string" && value.startsWith("$") && !value.startsWith("$$")) return `$_chart_${value.slice(1)}`;
      if (Array.isArray(value)) return value.map(chartReference);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, chartReference(nested)]));
      return value;
    };
    project.channelSummary = Object.fromEntries(Object.entries(chartProject)
      .filter(([key]) => key !== "_id" && key !== "totalMatchingRecords")
      .map(([key, value]) => [key, value === 1 ? `$_chart_${key}` : chartReference(value)]));
  }
  return [{ $group: group }, { $project: project }];
}

export function paymentMethodsStages() {
  return [{ $group: { _id: null, methods: { $addToSet: "$_pr.method" }, hasGpay: { $max: { $cond: [gt("$_pr.channels.gpay", 0), 1, 0] } } } }, { $project: { _id: 0, methods: 1, hasGpay: 1 } }];
}

export function paymentSort(sort) {
  return { $sort: sort === "oldest" ? { createdAt: 1, _id: 1 } : sort === "highest" || sort === "lowest" ? { "_pr.amountMissing": 1, "_pr.amount": sort === "highest" ? -1 : 1, createdAt: -1, _id: -1 } : { createdAt: -1, _id: -1 } };
}
