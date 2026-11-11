import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js";
import User from "../models/user.model.js";
import ApiError from "../utils/ApiError.js";
import {
  classifyPayment,
  normalizePaymentMethod,
  PAYMENT_RECEIPT_TYPES,
} from "../../shared/paymentReporting.mjs";
import {
  toDayKey,
  addDayKeys,
  isValidDayKey,
  dayStartIST,
  dayEndIST,
} from "../utils/revenue.utils.js";

export const UPI_CHANNELS = ["phonepe", "gpay", "razorpay"];
const TABS = ["today", "yesterday", "pending", "completed", "all"];
const DATE_BASIS = {
  created: "createdAt",
  payment: "paymentDate",
  collected: "collectedDate",
};
const monthStart = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return next.toISOString().slice(0, 10);
};
const fields =
  "bookingId customer vehicle amount paymentMethod paymentBreakdown type transactionId upiLast4 createdBy createdAt paymentDate customPaymentDate paymentTime collectedAmount collectedPhonePe isCollected isPhonePeCollected collectionHistory lastCollectedAt lastCollectedByName __v";
const viewFields = fields.split(/\s+/).filter((field) => field !== "__v").join(" ");
const fieldProjection = Object.fromEntries(viewFields.split(/\s+/).map((field) => [field, 1]));
// Use the same deployment-owned access boundary as Cash Verification. A client
// cannot choose the company, collector or verification time.
export const upiScope = (user) =>
  process.env.PAYMENTS_SCOPE_BY_COMPANY === "true"
    ? { company: user.company || user.createdBy || user._id }
    : {};
const paise = (value) => {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))
    value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) && Math.abs(value * 100 - result) < 0.001
    ? result
    : null;
};

export function parseUpiQuery(query = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query))
    throw new ApiError(400, "Invalid UPI filters");
  const allowed = ["tab", "method", "month", "date", "dateType", "search", "page", "limit", "section"];
  if (Object.keys(query).some((key) => !allowed.includes(key)))
    throw new ApiError(400, "Unknown UPI filter");
  const result = {
    tab: "pending",
    method: "all",
    month: "",
    date: "",
    dateType: "created",
    search: "",
    page: "1",
    limit: "25",
    section: "all",
    ...query,
  };
  // Keep earlier clients compatible while the UI exposes exactly five tabs.
  if (result.tab === "verified") result.tab = "completed";
  if (
    Object.values(result).some(
      (value) =>
        typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value),
    ) ||
    !TABS.includes(result.tab) ||
    !["all", "mixed", ...UPI_CHANNELS].includes(result.method) ||
    !["created", "payment", "collected"].includes(result.dateType) ||
    result.search.length > 120 ||
    (result.month && !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(result.month)) ||
    (result.date && !isValidDayKey(result.date)) ||
    (result.month &&
      result.date &&
      !result.date.startsWith(`${result.month}-`)) ||
    !/^[1-9]\d{0,5}$/.test(result.page) ||
    !["25", "50", "100", "all"].includes(result.limit) ||
    !["all", "page", "summary"].includes(result.section)
  ) {
    throw new ApiError(400, "Invalid UPI filters or page size");
  }
  return { ...result, search: result.search.trim(), page: Number(result.page) };
}

export function upiPaymentRow(payment) {
  const allocation = classifyPayment(payment);
  const method = normalizePaymentMethod(payment.paymentMethod);
  const reasons = [...allocation.reviewReasons];
  const audit = Array.isArray(payment.collectionHistory)
    ? payment.collectionHistory
    : [];
  const sums = { cash: 0, phonepe: 0, gpay: 0, razorpay: 0 };
  const verifiedAudit = [];
  const verifiedSums = { phonepe: 0, gpay: 0, razorpay: 0 };
  for (const entry of audit) {
    const channel = entry?.channel || "cash",
      amount = paise(entry?.amount);
    if (
      !Object.hasOwn(sums, channel) ||
      amount === null ||
      !Number.isSafeInteger(sums[channel] + amount)
    )
      reasons.push("Collection audit contains an invalid entry.");
    else {
      sums[channel] += amount;
      if (UPI_CHANNELS.includes(channel)) {
        // Only explicit digital verification actions with an actor and date
        // prove staff verification. Collection flags/counters alone do not.
        if (
          mongoose.isObjectIdOrHexString(entry.collectedBy) &&
          entry.collectedAt &&
          Number.isFinite(new Date(entry.collectedAt).getTime())
        ) {
          verifiedSums[channel] += amount;
          verifiedAudit.push(entry);
        } else
          reasons.push(
            "UPI verification audit is missing its staff member or timestamp; reconciliation is required.",
          );
      }
    }
  }
  const cashRecorded = paise(payment.collectedAmount ?? 0);
  const phoneRecorded = paise(payment.collectedPhonePe ?? 0);
  if (cashRecorded === null || phoneRecorded === null)
    reasons.push("Recorded verification amounts are invalid.");
  if (UPI_CHANNELS.includes(method) && sums.cash > 0)
    reasons.push(
      "Digital receipt contains a cash collection audit; reconciliation is required.",
    );
  // Existing Revenue treats a nonempty audit as authoritative. Do not add an
  // event that would hide an older counter-only collection from its totals.
  if (
    method === "mixed" &&
    (cashRecorded !== sums.cash ||
      phoneRecorded !== sums.phonepe ||
      (payment.isCollected && cashRecorded !== allocation.channels.cash))
  )
    reasons.push(
      "Legacy cash or PhonePe totals need reconciliation before UPI verification.",
    );
  const verification = {};
  for (const channel of UPI_CHANNELS) {
    const amount = allocation.channels[channel] ?? 0;
    const stored =
      channel === "phonepe"
        ? phoneRecorded
        : method === channel
          ? cashRecorded
          : sums[channel];
    const recorded = Math.max(sums[channel], stored ?? 0);
    const collectedFlag =
      channel === "phonepe"
        ? payment.isPhonePeCollected ||
          (method === channel && payment.isCollected)
        : method === channel && payment.isCollected;
    if (recorded > amount)
      reasons.push(`Recorded ${channel} amount (${(recorded / 100).toFixed(2)}) exceeds its allocated channel portion (${(amount / 100).toFixed(2)}).`);
    if (
      method === channel &&
      (recorded !== sums[channel] ||
        (channel === "phonepe" && cashRecorded !== phoneRecorded))
    ) {
      reasons.push(
        "Legacy verification totals lack a matching audit trail; reconciliation is required.",
      );
    }
    const verifiedAmount = verifiedSums[channel];
    if (amount > 0 && collectedFlag && verifiedAmount < amount)
      reasons.push(
        "Recorded collection is not proof of staff verification; the UPI audit needs reconciliation.",
      );
    const history = verifiedAudit.filter((entry) => entry.channel === channel);
    verification[channel] = {
      amount: amount / 100,
      verifiedAmount: verifiedAmount / 100,
      remainingAmount: Math.max(0, amount - verifiedAmount) / 100,
      verified:
        allocation.allocationValid && amount > 0 && verifiedAmount === amount,
      history: history.map((entry) => ({
        _id: entry._id,
        amount: entry.amount,
        note: entry.note,
        collectedByName: entry.collectedByName,
        collectedAt: entry.collectedAt,
        adjustment: entry.adjustment || null,
      })),
    };
  }
  const portions = Object.values(verification).filter(
    (part) => part.amount > 0,
  );
  const effectivePaymentDate =
    [payment.customPaymentDate, payment.paymentDate].find(
      (value) => value && Number.isFinite(new Date(value).getTime()),
    ) || null;
  const recordedAt = payment.createdAt && Number.isFinite(new Date(payment.createdAt).getTime())
    ? payment.createdAt : null;
  const reviewReasons = [
    ...new Set(
      reasons.map((reason) =>
        reason.startsWith("Unsupported breakdown channel:")
          ? "Unsupported payment breakdown channel."
          : reason,
      ),
    ),
  ];
  return {
    _id: payment._id,
    bookingId: payment.bookingId,
    customer: payment.customer,
    vehicle: payment.vehicle,
    type: payment.type,
    paymentMethod: method,
    amount: payment.amount,
    transactionId: payment.transactionId || "",
    upiLast4: Array.isArray(payment.upiLast4) ? payment.upiLast4 : payment.upiLast4 ? [String(payment.upiLast4)] : [],
    createdBy: payment.createdBy,
    createdAt: recordedAt,
    recordedDay: recordedAt ? toDayKey(recordedAt) : null,
    paymentDate: payment.paymentDate || null,
    customPaymentDate: payment.customPaymentDate || null,
    paymentTime: typeof payment.paymentTime === "string" ? payment.paymentTime : "",
    effectivePaymentDate,
    paymentDay: effectivePaymentDate ? toDayKey(effectivePaymentDate) : null,
    verification,
    upiAmount:
      portions.reduce((sum, part) => sum + Math.round(part.amount * 100), 0) /
      100,
    verifiedAmount:
      portions.reduce(
        (sum, part) => sum + Math.round(part.verifiedAmount * 100),
        0,
      ) / 100,
    remainingAmount:
      portions.reduce(
        (sum, part) => sum + Math.round(part.remainingAmount * 100),
        0,
      ) / 100,
    verified: portions.length > 0 && portions.every((part) => part.verified),
    canVerify:
      allocation.allocationValid &&
      reviewReasons.length === 0 &&
      portions.some((part) => part.remainingAmount > 0),
    reviewReasons,
  };
}

const createSummaryAccumulator = () => ({
  count: 0,
  amount: 0,
  verifiedCount: 0,
  verifiedAmount: 0,
  pendingCount: 0,
  pendingAmount: 0,
  reviewCount: 0,
});

const addSummaryRow = (summary, row) => {
  summary.count += 1;
  summary.amount += Math.round(row.upiAmount * 100);
  if (
    row.visibleChannels.some((channel) => row.verification[channel].verified)
  )
    summary.verifiedCount += 1;
  summary.verifiedAmount += Math.round(row.verifiedAmount * 100);
  if (!row.verified) {
    summary.pendingCount += 1;
    summary.pendingAmount += Math.round(row.remainingAmount * 100);
  }
  if (row.reviewReasons.length > 0) summary.reviewCount += 1;
};

const finishSummary = (summary) => ({
  count: summary.count,
  amount: summary.amount / 100,
  verified: {
    count: summary.verifiedCount,
    amount: summary.verifiedAmount / 100,
  },
  pending: {
    count: summary.pendingCount,
    amount: summary.pendingAmount / 100,
  },
  reviewCount: summary.reviewCount,
});

const summaryOf = (rows) => {
  const summary = createSummaryAccumulator();
  for (const row of rows) addSummaryRow(summary, row);
  return finishSummary(summary);
};

function scopeToChannels(row, channels) {
  const visibleChannels = channels.filter(
    (channel) => row.verification[channel].amount > 0,
  );
  const parts = visibleChannels.map((channel) => row.verification[channel]);
  const collectedAt = parts
    .flatMap((part) => part.history)
    .map((entry) => entry.collectedAt)
    .filter((value) => value && Number.isFinite(new Date(value).getTime()))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  const total = (key) =>
    parts.reduce((sum, part) => sum + Math.round(part[key] * 100), 0) / 100;
  return {
    ...row,
    visibleChannels,
    collectedAt,
    collectedDay: collectedAt ? toDayKey(collectedAt) : null,
    upiAmount: total("amount"),
    verifiedAmount: total("verifiedAmount"),
    remainingAmount: total("remainingAmount"),
    verified: parts.length > 0 && parts.every((part) => part.verified),
    canVerify:
      row.canVerify &&
      parts.some((part) => !part.verified && part.remainingAmount > 0),
  };
}

function withDateBasis(row, dateType) {
  const dateValue = dateType === "created"
    ? row.createdAt
    : dateType === "collected"
      ? row.collectedAt
      : row.effectivePaymentDate;
  return {
    ...row,
    dateValue,
    dateDay: dateValue && Number.isFinite(new Date(dateValue).getTime())
      ? toDayKey(dateValue)
      : null,
  };
}

export async function readUpiView(user, query) {
  const filter = parseUpiQuery(query);
  if (filter.section === "page") return readUpiPage(user, filter);
  const createdAtRange = filter.dateType === "created" && filter.date
    ? { $gte: dayStartIST(filter.date), $lte: dayEndIST(filter.date) }
    : filter.dateType === "created" && filter.month
      ? {
          $gte: dayStartIST(`${filter.month}-01`),
          $lt: dayStartIST(monthStart(filter.month)),
        }
      : null;
  const paymentQuery = {
    ...upiScope(user),
    type: { $in: PAYMENT_RECEIPT_TYPES },
    ...(createdAtRange ? { createdAt: createdAtRange } : {}),
  };
  if (filter.section === "summary")
    return readUpiSummary(filter, paymentQuery);
  const payments = await PaymentHistory.find(paymentQuery)
    .select(viewFields)
    .lean();
  const today = toDayKey(new Date()),
    yesterday = addDayKeys(today, -1);
  const search = filter.search.toLowerCase();
  // Normalize before eligibility filtering so legacy method spellings are
  // not discarded by an exact-match MongoDB paymentMethod query.
  const paymentRows = payments.filter((payment) =>
    [...UPI_CHANNELS, "mixed"].includes(normalizePaymentMethod(payment.paymentMethod)),
  ).map(upiPaymentRow);
  // Each method is a facet of the same date/search/status selection. Scope
  // mixed receipts to their digital portion before applying channel status.
  const matchesForMethod = (method) =>
    paymentRows
      .map((row) =>
        withDateBasis(
          scopeToChannels(
            row,
            UPI_CHANNELS.includes(method) ? [method] : UPI_CHANNELS,
          ),
          filter.dateType,
        ),
      )
      .filter(
        (row) =>
          row.upiAmount > 0 &&
          (method === "all" ||
            (method === "mixed"
              ? row.paymentMethod === "mixed"
              : row.verification[method].amount > 0)) &&
          (!search ||
            [
              row.customer?.fullName,
              row.customer?.mobileNumber,
              row.vehicle?.vehicleName,
              row.vehicle?.vehicleNumber,
              row._id,
              row.bookingId,
              row.transactionId,
              ...row.upiLast4,
              row.upiAmount,
              row.remainingAmount,
            ].some((value) =>
              String(value ?? "")
                .toLowerCase()
                .includes(search),
            )),
      );
  const forTab = (matches, tab) =>
    matches
      .map((row) =>
        withDateBasis(
          tab === "pending" || tab === "completed"
            ? scopeToChannels(
                row,
                row.visibleChannels.filter(
                  (channel) =>
                    row.verification[channel].verified ===
                    (tab === "completed"),
                ),
              )
            : row,
          filter.dateType,
        ),
      )
      .filter(
        (row) =>
          row.upiAmount > 0 &&
          (!filter.month || row.dateDay?.startsWith(`${filter.month}-`)) &&
          (!filter.date || row.dateDay === filter.date) &&
          ((tab !== "today" && tab !== "yesterday") ||
            row.dateDay === (tab === "today" ? today : yesterday)),
      );
  const methods = Object.fromEntries(
    ["all", ...UPI_CHANNELS].map((method) => [
      method,
      matchesForMethod(method),
    ]),
  );
  const matches = methods[filter.method] || matchesForMethod(filter.method);
  const selectedRows = forTab(matches, filter.tab);
  const methodTotals = Object.fromEntries(
    Object.entries(methods).map(([method, matches]) => {
      const { amount, count } = summaryOf(forTab(matches, filter.tab));
      return [method, { amount, count }];
    }),
  );
  const stats = Object.fromEntries(
    TABS.map((tab) => [tab, summaryOf(forTab(matches, tab))]),
  );
  const rows = selectedRows.sort(
    (a, b) =>
      (b.dateValue ? new Date(b.dateValue).getTime() : -Infinity) -
        (a.dateValue ? new Date(a.dateValue).getTime() : -Infinity) ||
      String(b._id).localeCompare(String(a._id)),
  );
  const totalPages =
    filter.limit === "all"
      ? 1
      : Math.max(1, Math.ceil(rows.length / Number(filter.limit)));
  const page = filter.limit === "all" ? 1 : Math.min(filter.page, totalPages),
    skip = filter.limit === "all" ? 0 : (page - 1) * Number(filter.limit);
  const data =
    filter.limit === "all"
      ? rows
      : rows.slice(skip, skip + Number(filter.limit));
  const creatorIds = [
    ...new Set(
      data
        .map((row) => row.createdBy)
        .filter((id) => mongoose.isObjectIdOrHexString(id))
        .map(String),
    ),
  ];
  const creators = creatorIds.length
    ? await User.find({ _id: { $in: creatorIds } })
        .select("fullName username")
        .lean()
    : [];
  const creatorsById = new Map(
    creators.map((creator) => [String(creator._id), creator]),
  );
  const visibleData = data.map((row) => ({
    ...row,
    createdBy: creatorsById.get(String(row.createdBy)) || null,
  }));
  const dates = new Map();
  for (const row of visibleData) {
    if (!dates.has(row.dateDay))
      dates.set(row.dateDay, { date: row.dateDay, payments: [] });
    dates.get(row.dateDay).payments.push(row);
  }
  const result = {
    success: true,
    data: visibleData,
    dateType: filter.dateType,
    dateBasis: DATE_BASIS[filter.dateType],
    groups: [...dates.values()].map((group) => ({
      ...group, count: group.payments.length,
      amount: group.payments.reduce((sum, row) => sum + Math.round(row.upiAmount * 100), 0) / 100,
    })),
    total: rows.length,
    summary: summaryOf(rows),
    methodTotals,
    stats: { ...stats, verified: stats.completed },
    pagination: {
      page,
      pageSize: filter.limit === "all" ? "all" : Number(filter.limit),
      total: rows.length,
      totalPages,
      from: rows.length ? skip + 1 : 0,
      to: skip + data.length,
    },
    today,
    yesterday,
  };
  return result;
}

function upiRowForTab(row, tab, filter, today, yesterday) {
  let scoped = row;
  if (tab === "pending" || tab === "completed") {
    scoped = scopeToChannels(
      row,
      row.visibleChannels.filter(
        (channel) =>
          row.verification[channel].verified === (tab === "completed"),
      ),
    );
    scoped = withDateBasis(scoped, filter.dateType);
  }
  if (
    scoped.upiAmount <= 0 ||
    (filter.month && !scoped.dateDay?.startsWith(`${filter.month}-`)) ||
    (filter.date && scoped.dateDay !== filter.date) ||
    (tab === "today" && scoped.dateDay !== today) ||
    (tab === "yesterday" && scoped.dateDay !== yesterday)
  )
    return null;
  return scoped;
}

function matchesUpiSearch(row, search) {
  return (
    !search ||
    [
      row.customer?.fullName,
      row.customer?.mobileNumber,
      row.vehicle?.vehicleName,
      row.vehicle?.vehicleNumber,
      row._id,
      row.bookingId,
      row.transactionId,
      ...row.upiLast4,
      row.upiAmount,
      row.remainingAmount,
    ].some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(search),
    )
  );
}

async function readUpiSummary(filter, query) {
  const today = toDayKey(new Date());
  const yesterday = addDayKeys(today, -1);
  const search = filter.search.toLowerCase();
  const methodKeys = ["all", ...UPI_CHANNELS];
  const methodsToScan = [...new Set([...methodKeys, filter.method])];
  const methodAccumulators = Object.fromEntries(
    methodKeys.map((method) => [method, createSummaryAccumulator()]),
  );
  const statsAccumulators = Object.fromEntries(
    TABS.map((tab) => [tab, createSummaryAccumulator()]),
  );
  const selectedSummary = createSummaryAccumulator();
  const cursor = PaymentHistory.find(query)
    .select(viewFields)
    .lean()
    .cursor({ batchSize: 100 });

  for await (const payment of cursor) {
    const paymentMethod = normalizePaymentMethod(payment.paymentMethod);
    if (![...UPI_CHANNELS, "mixed"].includes(paymentMethod)) continue;
    const row = upiPaymentRow(payment);

    for (const method of methodsToScan) {
      const scoped = withDateBasis(
        scopeToChannels(
          row,
          UPI_CHANNELS.includes(method) ? [method] : UPI_CHANNELS,
        ),
        filter.dateType,
      );
      if (
        scoped.upiAmount <= 0 ||
        (method === "mixed" && scoped.paymentMethod !== "mixed") ||
        (UPI_CHANNELS.includes(method) &&
          scoped.verification[method].amount <= 0) ||
        !matchesUpiSearch(scoped, search)
      )
        continue;

      if (method === filter.method) {
        for (const tab of TABS) {
          const tabRow = upiRowForTab(scoped, tab, filter, today, yesterday);
          if (tabRow) addSummaryRow(statsAccumulators[tab], tabRow);
        }
        const selectedRow = upiRowForTab(
          scoped,
          filter.tab,
          filter,
          today,
          yesterday,
        );
        if (selectedRow) addSummaryRow(selectedSummary, selectedRow);
      }

      if (methodKeys.includes(method)) {
        const selectedTabRow = upiRowForTab(
          scoped,
          filter.tab,
          filter,
          today,
          yesterday,
        );
        if (selectedTabRow)
          addSummaryRow(methodAccumulators[method], selectedTabRow);
      }
    }
  }

  const summary = finishSummary(selectedSummary);
  const methodTotals = Object.fromEntries(
    methodKeys.map((method) => {
      const total = finishSummary(methodAccumulators[method]);
      return [method, { amount: total.amount, count: total.count }];
    }),
  );
  const stats = Object.fromEntries(
    TABS.map((tab) => [tab, finishSummary(statsAccumulators[tab])]),
  );
  const total = summary.count;
  const totalPages =
    filter.limit === "all"
      ? 1
      : Math.max(1, Math.ceil(total / Number(filter.limit)));
  return {
    success: true,
    dateType: filter.dateType,
    dateBasis: DATE_BASIS[filter.dateType],
    total,
    summary,
    methodTotals,
    stats: { ...stats, verified: stats.completed },
    pagination: {
      page: 1,
      pageSize: filter.limit === "all" ? "all" : Number(filter.limit),
      total,
      totalPages,
      from: total ? 1 : 0,
      to: filter.limit === "all" ? total : Math.min(total, Number(filter.limit)),
    },
    today,
    yesterday,
  };
}

async function readUpiPage(user, filter) {
  const today = toDayKey(new Date());
  const yesterday = addDayKeys(today, -1);
  const dateRanges = [];
  if (filter.date) {
    dateRanges.push({ $gte: dayStartIST(filter.date), $lte: dayEndIST(filter.date) });
  } else if (filter.month) {
    dateRanges.push({
      $gte: dayStartIST(`${filter.month}-01`),
      $lt: dayStartIST(monthStart(filter.month)),
    });
  }
  if (filter.tab === "today" || filter.tab === "yesterday") {
    const tabDay = filter.tab === "today" ? today : yesterday;
    dateRanges.push({ $gte: dayStartIST(tabDay), $lte: dayEndIST(tabDay) });
  }
  const dateMatches = filter.dateType === "created"
    ? dateRanges.map((range) => ({ createdAt: range }))
    : filter.dateType === "payment"
      ? dateRanges.map((range) => ({
          // Either field can be the effective date on legacy records. This
          // superset is narrowed using the existing precedence below.
          $or: [{ customPaymentDate: range }, { paymentDate: range }],
        }))
      : [];
  const query = {
    ...upiScope(user),
    type: { $in: PAYMENT_RECEIPT_TYPES },
    ...(dateMatches.length ? { $and: dateMatches } : {}),
  };
  const search = filter.search.toLowerCase();
  const skip = filter.limit === "all" ? 0 : (filter.page - 1) * Number(filter.limit);
  const end = filter.limit === "all" ? Infinity : skip + Number(filter.limit);
  const pageSize = filter.limit === "all" ? Infinity : Number(filter.limit);
  const pageRows = [];
  const tailRows = [];
  let total = 0;
  const needsFullSort = filter.dateType === "collected" || filter.limit === "all";
  const cursor = filter.dateType === "payment"
    ? PaymentHistory.aggregate([
        { $match: query },
        {
          $set: {
            _upiEffectivePaymentDate: {
              $ifNull: ["$customPaymentDate", "$paymentDate"],
            },
          },
        },
        { $sort: { _upiEffectivePaymentDate: -1, _id: -1 } },
        { $project: fieldProjection },
      ])
        .allowDiskUse(true)
        .cursor({ batchSize: 100 })
    : PaymentHistory.find(query)
        .select(viewFields)
        .sort({ createdAt: -1, _id: -1 })
        .lean()
        .cursor({ batchSize: 100 });

  for await (const payment of cursor) {
    if (!["phonepe", "gpay", "razorpay", "mixed"].includes(normalizePaymentMethod(payment.paymentMethod))) continue;
    let row = upiPaymentRow(payment);
    const channels = filter.method === "all" || filter.method === "mixed"
      ? UPI_CHANNELS
      : [filter.method];
    row = withDateBasis(scopeToChannels(row, channels), filter.dateType);
    if (
      row.upiAmount <= 0 ||
      (filter.method === "mixed" && row.paymentMethod !== "mixed") ||
      (UPI_CHANNELS.includes(filter.method) && row.verification[filter.method].amount <= 0) ||
      (search && ![
        row.customer?.fullName, row.customer?.mobileNumber, row.vehicle?.vehicleName,
        row.vehicle?.vehicleNumber, row._id, row.bookingId, row.transactionId,
        ...row.upiLast4, row.upiAmount, row.remainingAmount,
      ].some((value) => String(value ?? "").toLowerCase().includes(search)))
    ) continue;

    if (filter.tab === "pending" || filter.tab === "completed") {
      row = scopeToChannels(
        row,
        row.visibleChannels.filter(
          (channel) => row.verification[channel].verified === (filter.tab === "completed"),
        ),
      );
      row = withDateBasis(row, filter.dateType);
      if (row.upiAmount <= 0) continue;
    }
    if (
      (filter.month && !row.dateDay?.startsWith(`${filter.month}-`)) ||
      (filter.date && row.dateDay !== filter.date) ||
      (filter.tab === "today" && row.dateDay !== today) ||
      (filter.tab === "yesterday" && row.dateDay !== yesterday)
    ) continue;

    total += 1;
    if (needsFullSort) {
      pageRows.push(row);
      continue;
    }
    const rank = total - 1;
    if (rank >= skip && rank < end) pageRows.push({ rank, row });
    tailRows.push({ rank, row });
    if (tailRows.length > pageSize) tailRows.shift();
  }

  const totalPages = filter.limit === "all"
    ? 1
    : Math.max(1, Math.ceil(total / pageSize));
  const page = filter.limit === "all" ? 1 : Math.min(filter.page, totalPages);
  const pageSkip = filter.limit === "all" ? 0 : (page - 1) * pageSize;
  const selectedRows = needsFullSort
    ? pageRows.sort(
        (a, b) =>
          (b.dateValue ? new Date(b.dateValue).getTime() : -Infinity) -
            (a.dateValue ? new Date(a.dateValue).getTime() : -Infinity) ||
          String(b._id).localeCompare(String(a._id)),
      ).slice(pageSkip, pageSkip + pageSize)
    : (page === filter.page ? pageRows : tailRows)
        .filter(({ rank }) => rank >= pageSkip && rank < pageSkip + pageSize)
        .map(({ row }) => row);
  const hasNext = page < totalPages;
  const visible = selectedRows;
  const creatorIds = [
    ...new Set(
      visible
        .map((row) => row.createdBy)
        .filter((id) => mongoose.isObjectIdOrHexString(id))
        .map(String),
    ),
  ];
  const creators = creatorIds.length
    ? await User.find({ _id: { $in: creatorIds } }).select("fullName username").lean()
    : [];
  const creatorsById = new Map(creators.map((creator) => [String(creator._id), creator]));
  const data = visible.map((row) => ({
    ...row,
    createdBy: creatorsById.get(String(row.createdBy)) || null,
  }));
  const dates = new Map();
  for (const row of data) {
    if (!dates.has(row.dateDay)) dates.set(row.dateDay, { date: row.dateDay, payments: [] });
    dates.get(row.dateDay).payments.push(row);
  }
  return {
    success: true,
    data,
    dateType: filter.dateType,
    dateBasis: DATE_BASIS[filter.dateType],
    groups: [...dates.values()].map((group) => ({
      ...group,
      count: group.payments.length,
      amount: group.payments.reduce((sum, row) => sum + Math.round(row.upiAmount * 100), 0) / 100,
    })),
    total,
    pagination: {
      page,
      pageSize: filter.limit === "all" ? "all" : Number(filter.limit),
      total,
      totalRecords: total,
      totalPages,
      limit: filter.limit === "all" ? "all" : pageSize,
      from: data.length ? pageSkip + 1 : 0,
      to: pageSkip + data.length,
      hasPrevious: page > 1,
      hasNext: filter.limit === "all" ? false : hasNext,
      hasPreviousPage: page > 1,
      hasNextPage: hasNext,
    },
    hasMore: hasNext,
    today,
    yesterday,
  };
}

// Same format the PaymentHistory pre-save hook writes ("02:30 pm"). Newer ICU
// builds put a narrow no-break space before am/pm; store a plain space.
const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
const formatIstTime = (date) =>
  IST_TIME.format(date).replace(/[  ]/g, " ");
const normalizeTime = (value) =>
  String(value || "")
    .replace(/[\s  ]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^0(\d)/, "$1");
// paymentBreakdown uses camel-cased "phonePe".
const BREAKDOWN_KEY = { phonepe: "phonePe", gpay: "gpay", razorpay: "razorpay" };

// Accepts the date ("YYYY-MM-DD") and 24h time ("HH:mm") the staff member
// entered, interpreted in IST. Both are required together; neither = no edit.
function parsePaymentDateTime(paymentDate, paymentTime) {
  if (paymentDate === undefined && paymentTime === undefined) return null;
  if (
    typeof paymentDate !== "string" ||
    !isValidDayKey(paymentDate) ||
    typeof paymentTime !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(paymentTime)
  )
    throw new ApiError(400, "Enter a valid payment date and time");
  const at = new Date(`${paymentDate}T${paymentTime}:00+05:30`);
  if (!Number.isFinite(at.getTime()))
    throw new ApiError(400, "Enter a valid payment date and time");
  if (at.getTime() > Date.now() + 5 * 60 * 1000)
    throw new ApiError(400, "Payment date and time cannot be in the future");
  return { at, time: formatIstTime(at) };
}

export async function verifyUpi(user, id, body = {}) {
  if (!mongoose.isObjectIdOrHexString(id))
    throw new ApiError(400, "Invalid payment ID");
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "Invalid verification request");
  const {
    channel,
    amount,
    expectedVerifiedAmount,
    expectedMethod,
    confirmed,
    note = "",
    paymentDate,
    paymentTime,
    view,
  } = body;
  if (view !== undefined) parseUpiQuery(view);
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "channel",
          "amount",
          "expectedVerifiedAmount",
          "expectedMethod",
          "confirmed",
          "note",
          "paymentDate",
          "paymentTime",
          "view",
        ].includes(key),
    ) ||
    !UPI_CHANNELS.includes(channel) ||
    (expectedMethod !== undefined &&
      ![...UPI_CHANNELS, "mixed"].includes(expectedMethod)) ||
    confirmed !== true ||
    typeof amount !== "number" ||
    paise(amount) === null ||
    amount <= 0 ||
    typeof expectedVerifiedAmount !== "number" ||
    paise(expectedVerifiedAmount) === null ||
    typeof note !== "string" ||
    note.length > 500
  ) {
    throw new ApiError(
      400,
      "Confirm a valid UPI channel and amount with the current verified balance",
    );
  }
  const when = parsePaymentDateTime(paymentDate, paymentTime);
  const payment = await PaymentHistory.findOne({
    _id: id,
    ...upiScope(user),
    type: { $in: PAYMENT_RECEIPT_TYPES },
  })
    .select(fields)
    .lean();
  if (!payment) throw new ApiError(404, "Payment not found");
  const current = upiPaymentRow(payment);
  if (expectedMethod !== undefined && current.paymentMethod !== expectedMethod)
    throw new ApiError(
      409,
      "Payment method changed. Refresh before verifying again.",
    );

  // ---- Corrections staff make while verifying -----------------------------
  const changes = {};
  const adjustment = {};

  // Method: a single-method UPI receipt can be moved to another UPI channel
  // (e.g. recorded as PhonePe but actually paid by GPay) as long as nothing
  // has been verified or collected on it yet. Mixed receipts keep their split.
  if (
    UPI_CHANNELS.includes(current.paymentMethod) &&
    channel !== current.paymentMethod
  ) {
    const untouched =
      (payment.collectionHistory || []).length === 0 &&
      paise(payment.collectedAmount ?? 0) === 0 &&
      paise(payment.collectedPhonePe ?? 0) === 0 &&
      !payment.isCollected &&
      !payment.isPhonePeCollected;
    if (!untouched)
      throw new ApiError(
        409,
        "The payment method can only be changed before any amount is verified",
      );
    const from = current.paymentMethod;
    changes.paymentMethod = channel;
    if (payment.paymentBreakdown) {
      const fromKey = BREAKDOWN_KEY[from],
        toKey = BREAKDOWN_KEY[channel];
      const fromAmount = paise(payment.paymentBreakdown[fromKey] ?? 0),
        toAmount = paise(payment.paymentBreakdown[toKey] ?? 0);
      if (fromAmount === null || toAmount === null)
        throw new ApiError(
          409,
          "This payment needs reconciliation before its method can change",
        );
      changes.paymentBreakdown = {
        ...payment.paymentBreakdown,
        [fromKey]: 0,
        [toKey]: (fromAmount + toAmount) / 100,
      };
    }
    adjustment.methodFrom = from;
    adjustment.methodTo = channel;
  }

  // Payment date & time: only written when it actually differs.
  if (when) {
    const prevAt = current.effectivePaymentDate
      ? new Date(current.effectivePaymentDate)
      : null;
    const prevTime =
      current.paymentTime || (prevAt ? formatIstTime(prevAt) : "");
    const unchanged =
      prevAt &&
      toDayKey(prevAt) === toDayKey(when.at) &&
      normalizeTime(prevTime) === normalizeTime(when.time);
    if (!unchanged) {
      Object.assign(changes, {
        customPaymentDate: when.at,
        paymentDate: when.at,
        paymentTime: when.time,
      });
      Object.assign(adjustment, {
        paymentDateFrom: prevAt,
        paymentDateTo: when.at,
        paymentTimeFrom: current.paymentTime || "",
        paymentTimeTo: when.time,
      });
    }
  }

  // Re-evaluate eligibility against the receipt as it will be saved.
  const row = Object.keys(changes).length
      ? upiPaymentRow({ ...payment, ...changes })
      : current,
    portion = row.verification[channel];
  if (!portion.amount)
    throw new ApiError(400, "This payment has no amount for that UPI channel");
  if (portion.verified || portion.verifiedAmount !== expectedVerifiedAmount)
    throw new ApiError(
      409,
      "Verification changed. Refresh before verifying again.",
    );
  if (!row.canVerify)
    throw new ApiError(
      409,
      "This payment needs reconciliation before verification",
    );
  if (paise(amount) > paise(portion.remainingAmount))
    throw new ApiError(400, "Amount exceeds the unverified UPI portion");
  const now = new Date(),
    name = user.fullName || user.name || user.username || "Staff";
  const total = (paise(portion.verifiedAmount) + paise(amount)) / 100;
  const set = {};
  if (channel === "phonepe") {
    set.collectedPhonePe = total;
    set.isPhonePeCollected = total === portion.amount;
  }
  if (row.paymentMethod === channel)
    Object.assign(set, {
      collectedAmount: total,
      isCollected: total === portion.amount,
      lastCollectedAt: now,
      lastCollectedBy: user._id,
      lastCollectedByName: name,
    });
  const stored = (value) => (value === undefined ? { $exists: false } : value);
  // Compare the complete snapshot that determined eligibility. Cash and UPI
  // audit appends bump __v, so concurrent actions cannot overwrite each other.
  const guard = Object.fromEntries(
    [
      "__v",
      "collectedAmount",
      "collectedPhonePe",
      "isCollected",
      "isPhonePeCollected",
      "amount",
      "paymentMethod",
      "paymentBreakdown",
      "customPaymentDate",
      "paymentDate",
      "paymentTime",
    ].map((key) => [key, stored(payment[key])]),
  );
  const update = { ...changes, ...set };
  const hasAdjustment = Object.keys(adjustment).length > 0;
  const saved = await PaymentHistory.findOneAndUpdate(
    {
      _id: id,
      ...upiScope(user),
      ...guard,
      $expr: {
        $eq: [
          { $size: { $ifNull: ["$collectionHistory", []] } },
          (payment.collectionHistory || []).length,
        ],
      },
    },
    {
      ...(Object.keys(update).length ? { $set: update } : {}),
      $inc: { __v: 1 },
      $push: {
        collectionHistory: {
          channel,
          amount,
          collectedBy: user._id,
          collectedByName: name,
          collectedAt: now,
          note: note.trim(),
          ...(hasAdjustment ? { adjustment } : {}),
        },
      },
    },
    { new: true, runValidators: true },
  )
    .select(fields)
    .lean();
  if (!saved)
    throw new ApiError(
      409,
      "Payment changed during verification. Refresh and try again.",
    );
  let updatedView = null;
  if (view !== undefined) {
    try {
      updatedView = await readUpiView(user, view);
    } catch {
      console.error("UPI verification saved; updated view unavailable", {
        paymentId: id,
      });
    }
  }
  return {
    success: true,
    data: {
      paymentId: id,
      channel,
      transactionAmount: amount,
      verifiedAmount: total,
      remainingAmount: (paise(portion.amount) - paise(total)) / 100,
      verifiedBy: name,
      verifiedAt: now,
      paymentMethod: saved.paymentMethod,
      paymentDate: saved.customPaymentDate || saved.paymentDate || null,
      paymentTime: saved.paymentTime || "",
      adjustment: hasAdjustment ? adjustment : null,
    },
    view: updatedView,
  };
}