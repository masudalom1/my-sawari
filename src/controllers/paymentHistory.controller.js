import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js";
import User from "../models/user.model.js";
import ApiError from "../utils/ApiError.js";
import { toDayKey, addDayKeys, isValidDayKey, dayStartIST, dayEndIST } from "../utils/revenue.utils.js";

const AMOUNT_EPSILON = 0.01;
const MAX_PAGE_LIMIT = 500;
const DEFAULT_PAGE_LIMIT = 100;
const CASH_COLLECTION_FIELDS = [
  "bookingId",
  "customer.fullName",
  "customer.mobileNumber",
  "vehicle.vehicleName",
  "vehicle.vehicleNumber",
  "booking.fromDate",
  "booking.toDate",
  "booking.bookingAmount",
  "amount",
  "paymentMethod",
  "paymentBreakdown",
  "type",
  "note",
  "createdBy",
  "createdAt",
  "paymentDate",
  "customPaymentDate",
  "paymentTime",
  "collectedAmount",
  "isCollected",
  "collectionHistory._id",
  "collectionHistory.channel",
  "collectionHistory.collectedAt",
  "collectionHistory.amount",
  "collectionHistory.collectedByName",
  "collectionHistory.note",
  "lastCollectedAt",
  "lastCollectedByName",
].join(" ");
const monthStart = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return next.toISOString().slice(0, 10);
};

const parseCashQuery = (query = {}) => {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new ApiError(400, "Invalid cash collection filters");
  const { tab, search = "", month = "", date = "", dateType = "payment", page = "1", limit = "25", section = "all" } = query;
  if ((tab !== undefined && !["today", "yesterday", "pending", "completed", "all"].includes(tab)) ||
    !["all", "page", "summary"].includes(section) ||
    typeof search !== "string" || search.length > 120 ||
    typeof month !== "string" || (month && !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) ||
    typeof date !== "string" || (date && !isValidDayKey(date)) ||
    !["created", "payment", "collected"].includes(dateType) ||
    (month && date && !date.startsWith(`${month}-`))) {
    throw new ApiError(400, "Invalid cash collection filters");
  }
  if (typeof page !== "string" || !/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1000000) {
    throw new ApiError(400, "Invalid cash collection page");
  }
  const allRows = typeof limit === "string" && limit.toLowerCase() === "all";
  if (!allRows && (typeof limit !== "string" || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > MAX_PAGE_LIMIT)) {
    throw new ApiError(400, `Cash collection page size must be 1 to ${MAX_PAGE_LIMIT}, or All`);
  }
  return { tab, search, month, date, dateType, section, requestedPage: Number(page), limit: allRows ? "all" : Number(limit),
    status: ["pending", "collected", "all"].includes(query.status) ? query.status : "pending" };
};

// Match the Payments History deployment's optional company scoping. When
// enabled, use authenticated account references, never a client-supplied ID.
const cashScope = (req) => process.env.PAYMENTS_SCOPE_BY_COMPANY === "true"
  ? { company: req.user.company || req.user.createdBy || req.user._id }
  : {};

const computePaymentFields = (payment) => {
  const method = String(payment.paymentMethod || "").toLowerCase();

  const collectibleAmount =
    method === "mixed"
      ? Number(payment.paymentBreakdown?.cash) || 0
      : Number(payment.amount) || 0;

  const collectedAmount = Number(payment.collectedAmount) || 0;

  const remainingAmount = payment.isCollected ? 0 : Math.max(
    0,
    Number((collectibleAmount - collectedAmount).toFixed(2)),
  );

  const isCollected = remainingAmount === 0;

  // Mixed payments share an audit array with PhonePe verification. Only cash
  // entries describe the cash collector; old entries without a channel are cash.
  const collectionHistory = (payment.collectionHistory || [])
    .filter((entry) => entry && (!entry.channel || entry.channel === "cash"))
    .map((entry) => ({
      _id: entry._id,
      channel: entry.channel,
      collectedAt: entry.collectedAt,
      amount: entry.amount,
      collectedByName: entry.collectedByName,
      note: entry.note,
    }));
  const lastEntry = collectionHistory.at(-1);
  const effectivePaymentDate = [payment.customPaymentDate, payment.paymentDate, payment.createdAt]
    .find((value) => value && Number.isFinite(new Date(value).getTime())) || null;
  const lastCollectedAt = lastEntry?.collectedAt || (method === "cash" ? payment.lastCollectedAt : null);

  return {
    ...payment,
    collectibleAmount,
    collectedAmount,
    remainingAmount,
    isCollected,
    collectionHistory,
    effectivePaymentDate,
    paymentDay: effectivePaymentDate ? toDayKey(effectivePaymentDate) : null,
    createdDay: payment.createdAt && Number.isFinite(new Date(payment.createdAt).getTime())
      ? toDayKey(payment.createdAt)
      : null,
    collectedDay: lastCollectedAt && Number.isFinite(new Date(lastCollectedAt).getTime())
      ? toDayKey(lastCollectedAt)
      : null,
    lastCollectedAt,
    lastCollectedByName: lastEntry?.collectedByName || (method === "cash" ? payment.lastCollectedByName : null) || null,
  };
};

const cashDateValue = (payment, dateType) =>
  dateType === "created"
    ? payment.createdAt
    : dateType === "collected"
      ? payment.lastCollectedAt
      : payment.effectivePaymentDate;
const cashDateDay = (payment, dateType) =>
  dateType === "created"
    ? payment.createdDay
    : dateType === "collected"
      ? payment.collectedDay
      : payment.paymentDay;
const cashDateMatch = (dateType, dateRange) => {
  if (!dateRange) return null;
  if (dateType === "created") return { createdAt: dateRange };
  if (dateType === "collected") return {
    $or: [
      {
        collectionHistory: {
          $elemMatch: {
            collectedAt: dateRange,
            $or: [{ channel: "cash" }, { channel: null }],
          },
        },
      },
      { lastCollectedAt: dateRange },
    ],
  };
  return {
    $or: [
      { customPaymentDate: dateRange },
      { customPaymentDate: null, paymentDate: dateRange },
      { customPaymentDate: null, paymentDate: null, createdAt: dateRange },
    ],
  };
};

// Sum cash in paise before converting back to rupees. Totals always describe
// the entire filtered view, never just the visible page of payment cards.
const createCashSummaryAccumulator = () => ({
  count: 0,
  amount: 0,
  collected: { count: 0, amount: 0 },
  pending: { count: 0, amount: 0 },
});

const addCashPayment = (summary, payment) => {
  summary.count += 1;
  summary.amount += Math.round(payment.collectibleAmount * 100);
  summary.collected.amount += Math.round(
    Math.min(payment.collectibleAmount, payment.collectedAmount) * 100,
  );
  if (payment.isCollected) summary.collected.count += 1;
  else {
    summary.pending.count += 1;
    summary.pending.amount += Math.round(payment.remainingAmount * 100);
  }
};

const finishCashSummary = (summary) => ({
  count: summary.count,
  amount: summary.amount / 100,
  collected: {
    count: summary.collected.count,
    amount: summary.collected.amount / 100,
  },
  pending: {
    count: summary.pending.count,
    amount: summary.pending.amount / 100,
  },
});

const cashSummary = (payments) => {
  const summary = createCashSummaryAccumulator();
  for (const payment of payments) addCashPayment(summary, payment);
  return finishCashSummary(summary);
};

// "Today" is the IST calendar day whatever timezone the server runs in
// (Render runs in UTC, which shifted the day boundary by 5h30).
const startOfToday = () => dayStartIST(toDayKey(new Date()));

const endOfToday = () => dayEndIST(toDayKey(new Date()));

async function readCashCollectionSummary(req, parsed, query) {
  const { tab, search, month, date, dateType, limit, status } = parsed;
  const todayStart = startOfToday();
  const todayEnd = endOfToday();
  const today = toDayKey(todayStart);
  const yesterday = addDayKeys(today, -1);
  const normalizedSearch = search.trim().toLowerCase();
  const normalizedQuery = normalizedSearch.replace(/[,\s₹]/g, "");
  const currencyQuery =
    /[₹,]/.test(normalizedSearch) && /^[₹,\d\s.]+$/.test(normalizedSearch);
  const overall = createCashSummaryAccumulator();
  const todaySummary = createCashSummaryAccumulator();
  const yesterdaySummary = createCashSummaryAccumulator();
  const completedSummary = createCashSummaryAccumulator();
  const collectedTodaySummary = createCashSummaryAccumulator();
  const selectedSummary = createCashSummaryAccumulator();
  const groups = new Map();
  let partialCount = 0;
  const cursor = PaymentHistory.find(query)
    .select(CASH_COLLECTION_FIELDS)
    .lean()
    .cursor({ batchSize: 100 });

  for await (const rawPayment of cursor) {
    const payment = computePaymentFields(rawPayment);
    if (
      (month && !cashDateDay(payment, dateType)?.startsWith(`${month}-`)) ||
      (date && cashDateDay(payment, dateType) !== date) ||
      (normalizedSearch &&
        ![
          ...(!currencyQuery
            ? [
                payment.customer?.fullName,
                payment.customer?.mobileNumber,
                payment.vehicle?.vehicleName,
                payment.vehicle?.vehicleNumber,
              ]
            : []),
          payment.collectibleAmount,
          payment.remainingAmount,
        ].some(
          (value) =>
            String(value ?? "").toLowerCase().includes(normalizedSearch) ||
            (normalizedQuery &&
              String(value ?? "")
                .toLowerCase()
                .replace(/[,\s₹]/g, "")
                .includes(normalizedQuery)),
        ))
    )
      continue;

    addCashPayment(overall, payment);
    const paymentDay = cashDateDay(payment, dateType);
    if (paymentDay === today) addCashPayment(todaySummary, payment);
    if (paymentDay === yesterday) addCashPayment(yesterdaySummary, payment);
    if (payment.isCollected) {
      addCashPayment(completedSummary, payment);
      if (
        payment.lastCollectedAt &&
        new Date(payment.lastCollectedAt) >= todayStart &&
        new Date(payment.lastCollectedAt) <= todayEnd
      )
        addCashPayment(collectedTodaySummary, payment);
    }

    let include =
      tab === "today"
        ? paymentDay === today
        : tab === "yesterday"
          ? paymentDay === yesterday
          : tab === "pending" || (!tab && status === "pending")
            ? !payment.isCollected
            : tab === "completed" || (!tab && status === "collected")
              ? payment.isCollected
              : true;
    if (include && (tab === "completed" || (!tab && status === "collected"))) {
      const { collectedFrom, collectedTo } = req.query;
      if (collectedFrom || collectedTo) {
        if (!payment.lastCollectedAt) include = false;
        const collectedAt = new Date(payment.lastCollectedAt);
        if (collectedFrom && collectedAt < new Date(collectedFrom))
          include = false;
        if (collectedTo && collectedAt > new Date(collectedTo))
          include = false;
      }
    }
    if (!include) continue;

    addCashPayment(selectedSummary, payment);
    if (!payment.isCollected && payment.collectedAmount > 0) partialCount += 1;
    const groupDate = paymentDay;
    if (!groups.has(groupDate))
      groups.set(groupDate, createCashSummaryAccumulator());
    addCashPayment(groups.get(groupDate), payment);
  }

  const summary = finishCashSummary(selectedSummary);
  const total = summary.count;
  const totalPages =
    limit === "all" ? 1 : Math.max(1, Math.ceil(total / limit));
  return {
    success: true,
    dateType,
    total,
    status,
    stats: {
      today: finishCashSummary(todaySummary),
      yesterday: finishCashSummary(yesterdaySummary),
      pending: finishCashSummary(overall).pending,
      collectedToday: {
        count: collectedTodaySummary.count,
        amount: finishCashSummary(collectedTodaySummary).collected.amount,
      },
      collectedTotal: {
        count: completedSummary.count,
        amount: finishCashSummary(completedSummary).collected.amount,
      },
      all: { count: overall.count },
    },
    today,
    yesterday,
    cashTotal: summary.amount,
    summary: { ...summary, partialCount },
    groups: [...groups].map(([groupDate, groupSummary]) => ({
      date: groupDate,
      ...finishCashSummary(groupSummary),
    })),
    filters: {
      tab: tab || (status === "collected" ? "completed" : status),
      month,
      date,
      search: search.trim(),
    },
    pagination: {
      page: 1,
      pageSize: limit,
      total,
      totalPages,
      from: total ? 1 : 0,
      to: Math.min(total, limit === "all" ? total : limit),
      hasPrevious: false,
      hasNext: totalPages > 1,
    },
  };
}

// Matches a stored amount, treating a missing field on old records as 0.
const storedAmountIs = (value) => (value === 0 ? { $in: [0, null] } : value);

// The guarded save matched nothing: Mongoose reports VersionError when the
// save also bumps __v (array push), DocumentNotFoundError otherwise.
const isConcurrentUpdate = (error) =>
  error instanceof mongoose.Error.DocumentNotFoundError ||
  error instanceof mongoose.Error.VersionError;

export const collectCashPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount, note, expectedCollectedAmount, view: viewQuery } = req.body || {};
    if (viewQuery !== undefined) parseCashQuery(viewQuery);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment id",
      });
    }

    const payment = await PaymentHistory.findOne({ _id: id, ...cashScope(req) });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    if (payment.type === "refund") {
      return res.status(400).json({ success: false, message: "Refunds cannot be collected as cash receipts" });
    }

    const method = String(payment.paymentMethod || "").toLowerCase();

    if (!["cash", "mixed"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "Only cash or mixed payments can be collected",
      });
    }

    // For a pure cash payment the whole amount is collectible.
    // For a mixed payment, only the cash portion is.
    const collectibleAmount =
      method === "mixed"
        ? Number(payment.paymentBreakdown?.cash) || 0
        : Number(payment.amount) || 0;

    if (collectibleAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "This payment has no cash amount to collect",
      });
    }

    if (payment.isCollected) {
      return res.status(409).json({
        success: false,
        message: "This payment has already been fully collected",
      });
    }

    const alreadyCollected = Number(payment.collectedAmount) || 0;
    if (expectedCollectedAmount !== undefined && (
      typeof expectedCollectedAmount !== "number" || !Number.isFinite(expectedCollectedAmount) ||
      expectedCollectedAmount !== alreadyCollected
    )) {
      return res.status(409).json({ success: false, message: "Cash collection has changed. Refresh this payment before collecting." });
    }
    const remaining = Number((collectibleAmount - alreadyCollected).toFixed(2));

    const collectAmount = amount != null ? Number(amount) : remaining;

    if ((amount != null && !["number", "string"].includes(typeof amount)) ||
      !Number.isFinite(collectAmount) || collectAmount <= 0 ||
      Math.abs(collectAmount * 100 - Math.round(collectAmount * 100)) > 0.000001) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection amount",
      });
    }

    if (collectAmount > remaining) {
      return res.status(400).json({
        success: false,
        message: `Cannot collect more than the remaining ₹${remaining.toFixed(2)}`,
      });
    }

    if (note != null && (typeof note !== "string" || note.length > 500)) {
      return res.status(400).json({ success: false, message: "Collection note must be at most 500 characters" });
    }

    // Requires your auth middleware to attach req.user (e.g. from a JWT).
    const collectorId = req.user?._id || req.user?.id;

    if (!collectorId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const collectorName =
      req.user?.name || req.user?.fullName || req.user?.username || "";

    payment.collectionHistory.push({
      channel: "cash",
      collectedBy: collectorId,
      collectedByName: collectorName,
      amount: collectAmount,
      note: note?.trim() || "",
    });

    payment.collectedAmount = Number(
      (alreadyCollected + collectAmount).toFixed(2),
    );

    payment.lastCollectedAt = new Date();
    payment.lastCollectedBy = collectorId;
    payment.isCollected =
      payment.collectedAmount >= collectibleAmount;

    // Save only if nobody collected since we read the payment; otherwise two
    // taps would both $push a collection entry for the same cash.
    payment.$where = {
      collectedAmount: storedAmountIs(alreadyCollected),
      isCollected: { $ne: true },
    };

    try {
      await payment.save();
    } catch (error) {
      if (!isConcurrentUpdate(error)) throw error;
      return res.status(409).json({
        success: false,
        message:
          "This payment was just collected by someone else. Refresh and try again.",
      });
    }

    const latestEntry =
      payment.collectionHistory[payment.collectionHistory.length - 1];

    // Return the authoritative post-action view in the same POST response.
    // A read failure must never turn a successful collection into a failed write.
    let view = null;
    if (viewQuery !== undefined) {
      try { view = await readCashCollectionView({ user: req.user, query: viewQuery }); }
      catch { console.error("Cash collection view could not be loaded", { paymentId: String(payment._id) }); }
    }

    return res.status(200).json({
      success: true,
      ...(viewQuery !== undefined ? { view } : {}),
      data: {
        paymentId: payment._id,
        isCollected: payment.isCollected,
        // Amount collected in THIS request. Use this for "just
        // collected" UI feedback — NOT totalCollectedAmount below.
        transactionAmount: collectAmount,
        // Cumulative amount collected across all collection events
        // for this payment (relevant once you support partial/mixed
        // multi-step collections).
        totalCollectedAmount: payment.collectedAmount,
        remainingAmount: Math.max(
          0,
          Number((collectibleAmount - payment.collectedAmount).toFixed(2)),
        ),
        collectedBy: collectorName || "Unknown",
        collectedAt: latestEntry?.collectedAt || payment.lastCollectedAt,
      },
    });
  } catch (error) {
    console.error("Collect Cash Payment Error:", error);
    next(error);
  }
};
export const getPaymentHistory = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit, 10) || 12),
    );
    const skip = (page - 1) * limit;

    const todayStart = startOfToday();
    const todayEnd = endOfToday();
    const listQuery = PaymentHistory.find({})
      .populate("createdBy", "name fullName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const summaryPromise =
      page === 1
        ? PaymentHistory.aggregate([
            { $match: { createdAt: { $gte: todayStart, $lte: todayEnd } } },
            {
              $project: {
                amount: { $ifNull: ["$amount", 0] },
                paymentMethod: 1,
                type: 1,
                multiplier: { $cond: [{ $eq: ["$type", "refund"] }, -1, 1] },
                mixedCash: { $ifNull: ["$paymentBreakdown.cash", 0] },
                mixedPhonePe: { $ifNull: ["$paymentBreakdown.phonePe", 0] },
              },
            },
            {
              $group: {
                _id: null,
                totalCollection: {
                  $sum: { $multiply: ["$amount", "$multiplier"] },
                },
                cash: {
                  $sum: {
                    $cond: [
                      { $eq: ["$paymentMethod", "mixed"] },
                      { $multiply: ["$mixedCash", "$multiplier"] },
                      {
                        $cond: [
                          { $eq: ["$paymentMethod", "cash"] },
                          { $multiply: ["$amount", "$multiplier"] },
                          0,
                        ],
                      },
                    ],
                  },
                },
                phonePe: {
                  $sum: {
                    $cond: [
                      { $eq: ["$paymentMethod", "mixed"] },
                      { $multiply: ["$mixedPhonePe", "$multiplier"] },
                      {
                        $cond: [
                          { $eq: ["$paymentMethod", "phonepe"] },
                          { $multiply: ["$amount", "$multiplier"] },
                          0,
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ])
        : Promise.resolve(null);

    const [payments, summaryResult] = await Promise.all([
      listQuery,
      summaryPromise,
    ]);

    const todaySummary =
      page === 1
        ? {
            totalCollection: summaryResult?.[0]?.totalCollection || 0,
            cash: summaryResult?.[0]?.cash || 0,
            phonePe: summaryResult?.[0]?.phonePe || 0,
          }
        : undefined;

    return res.status(200).json({
      success: true,
      data: payments,
      page,
      limit,
      hasMore: payments.length === limit,
      ...(todaySummary ? { todaySummary } : {}),
    });
  } catch (error) {
    console.error("Get Payment History Error:", error);
    next(error);
  }
};
async function readCashCollectionView(req) {
    const parsed = parseCashQuery(req.query);
    const { tab, search, month, date, dateType, requestedPage, limit, status } = parsed;
    if (parsed.section === "page") return readCashCollectionPage(req, parsed);

    const dateRange = date
      ? { $gte: dayStartIST(date), $lte: dayEndIST(date) }
      : month
        ? {
            $gte: dayStartIST(`${month}-01`),
            $lt: dayStartIST(monthStart(month)),
          }
        : null;
    const dateMatch = cashDateMatch(dateType, dateRange);
    const paymentQuery = {
      ...cashScope(req),
      type: { $ne: "refund" },
      $or: [
        { paymentMethod: "cash" },
        { paymentMethod: "mixed", "paymentBreakdown.cash": { $gt: 0 } },
      ],
      ...(dateMatch ? { $and: [dateMatch] } : {}),
    };
    if (parsed.section === "summary")
        return readCashCollectionSummary(req, parsed, paymentQuery);
    const payments = await PaymentHistory.find(paymentQuery)
        .select(CASH_COLLECTION_FIELDS)
        .lean();

    const computed = payments.map(computePaymentFields);

    const todayStart = startOfToday();
    const todayEnd = endOfToday();
    const today = toDayKey(todayStart);
    const yesterday = addDayKeys(today, -1);

    const query = search.trim().toLowerCase();
    const normalizedQuery = query.replace(/[,\s₹]/g, "");
    const currencyQuery = /[₹,]/.test(query) && /^[₹,\d\s.]+$/.test(query);
    const matches = computed.filter((payment) =>
      (!month || cashDateDay(payment, dateType)?.startsWith(`${month}-`)) &&
      (!date || cashDateDay(payment, dateType) === date) && (!query || [
      ...(!currencyQuery ? [payment.customer?.fullName, payment.customer?.mobileNumber,
        payment.vehicle?.vehicleName, payment.vehicle?.vehicleNumber] : []),
      payment.collectibleAmount, payment.remainingAmount,
    ].some((value) => String(value ?? "").toLowerCase().includes(query) ||
      (normalizedQuery && String(value ?? "").toLowerCase().replace(/[,\s₹]/g, "").includes(normalizedQuery)))));

    // Badges share the active month/date/search scope; the summary below also
    // applies the selected main tab. Both are computed before pagination.
    const overall = cashSummary(matches);
    const completed = matches.filter((payment) => payment.isCollected);
    const collectedToday = completed.filter((payment) => payment.lastCollectedAt &&
      new Date(payment.lastCollectedAt) >= todayStart && new Date(payment.lastCollectedAt) <= todayEnd);
    const stats = {
      today: cashSummary(matches.filter((payment) => cashDateDay(payment, dateType) === today)),
      yesterday: cashSummary(matches.filter((payment) => cashDateDay(payment, dateType) === yesterday)),
      pending: overall.pending,
      collectedToday: { count: collectedToday.length, amount: cashSummary(collectedToday).collected.amount },
      collectedTotal: { count: completed.length, amount: cashSummary(completed).collected.amount },
      all: { count: overall.count },
    };

    /* ---- filter by requested tab ---- */

    let filtered;

    if (tab === "today" || tab === "yesterday") {
      const day = tab === "today" ? today : yesterday;
      filtered = matches.filter((payment) => cashDateDay(payment, dateType) === day);
    } else if (tab === "pending" || (!tab && status === "pending")) {
      filtered = matches.filter((payment) => !payment.isCollected);
    } else if (tab === "completed" || (!tab && status === "collected")) {
      filtered = matches.filter((payment) => payment.isCollected);

      const { collectedFrom, collectedTo } = req.query;

      if (collectedFrom || collectedTo) {
        const from = collectedFrom ? new Date(collectedFrom) : null;
        const to = collectedTo ? new Date(collectedTo) : null;

        filtered = filtered.filter((payment) => {
          if (!payment.lastCollectedAt) return false;

          const collectedAt = new Date(payment.lastCollectedAt);

          if (from && collectedAt < from) return false;
          if (to && collectedAt > to) return false;

          return true;
        });
      }

    } else {
      filtered = matches;
    }

    if (parsed.section === "summary") {
      const total = filtered.length;
      const summary = cashSummary(filtered);
      const groups = new Map();
      for (const payment of filtered) {
        const key = cashDateDay(payment, dateType);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(payment);
      }
      const totalPages = limit === "all" ? 1 : Math.max(1, Math.ceil(total / limit));
      return {
        success: true,
        dateType,
        total,
        status,
        stats,
        today,
        yesterday,
        cashTotal: summary.amount,
        summary: {
          ...summary,
          partialCount: filtered.filter((payment) => !payment.isCollected && payment.collectedAmount > 0).length,
        },
        groups: [...groups].map(([groupDate, payments]) => ({
          date: groupDate,
          ...cashSummary(payments),
        })),
        filters: { tab: tab || (status === "collected" ? "completed" : status), month, date, search: search.trim() },
        pagination: {
          page: 1,
          pageSize: limit,
          total,
          totalPages,
          from: total ? 1 : 0,
          to: Math.min(total, limit === "all" ? total : limit),
          hasPrevious: false,
          hasNext: totalPages > 1,
        },
      };
    }

    // Sort/group by the payment's IST date, with deterministic ties so pages
    // never repeat a payment when several records share the same timestamp.
    filtered.sort((a, b) =>
      (cashDateValue(b, dateType) ? new Date(cashDateValue(b, dateType)).getTime() : -Infinity) -
      (cashDateValue(a, dateType) ? new Date(cashDateValue(a, dateType)).getTime() : -Infinity) ||
      String(b._id).localeCompare(String(a._id)));

    const total = filtered.length;
    const totalPages = limit === "all" ? 1 : Math.max(1, Math.ceil(total / limit));
    const page = limit === "all" ? 1 : Math.min(requestedPage, totalPages);
    const skip = limit === "all" ? 0 : (page - 1) * limit;
    const paginatedPayments = limit === "all" ? filtered : filtered.slice(skip, skip + limit);
    const creatorIds = [
      ...new Set(
        paginatedPayments
          .map((payment) => payment.createdBy)
          .filter((id) => mongoose.isObjectIdOrHexString(id))
          .map(String),
      ),
    ];
    const creators = creatorIds.length
      ? await User.find({ _id: { $in: creatorIds } })
          .select("name fullName username")
          .lean()
      : [];
    const creatorsById = new Map(
      creators.map((creator) => [String(creator._id), creator]),
    );
    const visiblePayments = paginatedPayments.map((payment) => ({
      ...payment,
      createdBy: creatorsById.get(String(payment.createdBy)) || null,
    }));
    const hasMore = page < totalPages;
    const summary = cashSummary(filtered);
    const fullGroups = new Map();
    for (const payment of filtered) {
      const key = cashDateDay(payment, dateType);
      if (!fullGroups.has(key)) fullGroups.set(key, []);
      fullGroups.get(key).push(payment);
    }
    const visibleGroups = new Map();
    for (const payment of paginatedPayments) {
      const key = cashDateDay(payment, dateType);
      if (!visibleGroups.has(key)) visibleGroups.set(key, {
        date: key, ...cashSummary(fullGroups.get(key)), payments: [],
      });
      visibleGroups.get(key).payments.push(payment);
    }

    const result = {
      success: true,
      dateType,
      data: visiblePayments,
      page,
      limit,
      total,
      hasMore,
      status,
      stats,
      today,
      yesterday,
      cashTotal: summary.amount,
      summary: { ...summary, partialCount: filtered.filter((payment) => !payment.isCollected && payment.collectedAmount > 0).length },
      groups: [...visibleGroups.values()],
      filters: { tab: tab || (status === "collected" ? "completed" : status), month, date, search: search.trim() },
      pagination: { page, pageSize: limit, total, totalPages, from: total ? skip + 1 : 0,
        to: skip + paginatedPayments.length, hasPrevious: page > 1, hasNext: hasMore },
    };
    return result;
}

async function readCashCollectionPage(req, filter) {
  const { tab, search, month, date, dateType, requestedPage, limit, status } = filter;
  const today = toDayKey(startOfToday());
  const yesterday = addDayKeys(today, -1);
  const effectiveDay = tab === "today" ? today : tab === "yesterday" ? yesterday : "";
  const dateRange = date
    ? { $gte: dayStartIST(date), $lte: dayEndIST(date) }
    : month
      ? { $gte: dayStartIST(`${month}-01`), $lt: dayStartIST(monthStart(month)) }
      : effectiveDay
        ? { $gte: dayStartIST(effectiveDay), $lte: dayEndIST(effectiveDay) }
        : null;
  const dateMatch = cashDateMatch(dateType, dateRange);
  const match = {
    ...cashScope(req),
    type: { $ne: "refund" },
    $or: [
      { paymentMethod: "cash" },
      { paymentMethod: "mixed", "paymentBreakdown.cash": { $gt: 0 } },
    ],
    ...(dateMatch ? { $and: [dateMatch] } : {}),
  };
  const query = search.trim().toLowerCase();
  const normalizedQuery = query.replace(/[,\s₹]/g, "");
  const currencyQuery = /[₹,]/.test(query) && /^[₹,\d\s.]+$/.test(query);
  const skip = limit === "all" ? 0 : (requestedPage - 1) * limit;
  const end = limit === "all" ? Infinity : skip + limit;
  const rows = [];
  const tailRows = [];
  let total = 0;
  const sortField = dateType === "created"
    ? "createdAt"
    : dateType === "collected"
      ? "cashCollectedDate"
      : "effectivePaymentDate";
  const cursor = PaymentHistory.aggregate([
    { $match: match },
    {
      $set: {
        effectivePaymentDate: {
          $ifNull: ["$customPaymentDate", { $ifNull: ["$paymentDate", "$createdAt"] }],
        },
      },
    },
    {
      $set: {
        cashCollectedDate: {
          $let: {
            vars: {
              cashEntries: {
                $filter: {
                  input: { $ifNull: ["$collectionHistory", []] },
                  as: "entry",
                  cond: { $eq: [{ $ifNull: ["$$entry.channel", "cash"] }, "cash"] },
                },
              },
            },
            in: {
              $ifNull: [
                { $arrayElemAt: ["$$cashEntries.collectedAt", -1] },
                { $cond: [{ $eq: ["$paymentMethod", "cash"] }, "$lastCollectedAt", null] },
              ],
            },
          },
        },
      },
    },
    { $sort: { [sortField]: -1, _id: -1 } },
    {
      $project: {
        bookingId: 1,
        customer: {
          fullName: "$customer.fullName",
          mobileNumber: "$customer.mobileNumber",
        },
        vehicle: {
          vehicleName: "$vehicle.vehicleName",
          vehicleNumber: "$vehicle.vehicleNumber",
        },
        booking: {
          fromDate: "$booking.fromDate",
          toDate: "$booking.toDate",
          bookingAmount: "$booking.bookingAmount",
        },
        amount: 1,
        paymentMethod: 1,
        paymentBreakdown: 1,
        type: 1,
        note: 1,
        createdBy: 1,
        createdAt: 1,
        paymentDate: 1,
        customPaymentDate: 1,
        paymentTime: 1,
        collectedAmount: 1,
        isCollected: 1,
        collectionHistory: {
          $map: {
            input: { $ifNull: ["$collectionHistory", []] },
            as: "entry",
            in: {
              _id: "$$entry._id",
              channel: "$$entry.channel",
              collectedAt: "$$entry.collectedAt",
              amount: "$$entry.amount",
              collectedByName: "$$entry.collectedByName",
              note: "$$entry.note",
            },
          },
        },
        lastCollectedAt: 1,
        lastCollectedByName: 1,
      },
    },
  ])
    .allowDiskUse(true)
    .cursor({ batchSize: 100 });

  for await (const raw of cursor) {
    const payment = computePaymentFields(raw);
    if (
      (month && !cashDateDay(payment, dateType)?.startsWith(`${month}-`)) ||
      (date && cashDateDay(payment, dateType) !== date) ||
      (query && ![
        ...(!currencyQuery ? [payment.customer?.fullName, payment.customer?.mobileNumber,
          payment.vehicle?.vehicleName, payment.vehicle?.vehicleNumber] : []),
        payment.collectibleAmount, payment.remainingAmount,
      ].some((value) =>
        String(value ?? "").toLowerCase().includes(query) ||
        (normalizedQuery && String(value ?? "").toLowerCase().replace(/[,\s₹]/g, "").includes(normalizedQuery)),
      ))
    ) continue;

    let include = true;
    if (tab === "today") include = cashDateDay(payment, dateType) === today;
    else if (tab === "yesterday") include = cashDateDay(payment, dateType) === yesterday;
    else if (tab === "pending" || (!tab && status === "pending")) include = !payment.isCollected;
    else if (tab === "completed" || (!tab && status === "collected")) {
      include = payment.isCollected;
      const { collectedFrom, collectedTo } = req.query;
      if (include && (collectedFrom || collectedTo)) {
        if (!payment.lastCollectedAt) include = false;
        const collectedAt = new Date(payment.lastCollectedAt);
        if (collectedFrom && collectedAt < new Date(collectedFrom)) include = false;
        if (collectedTo && collectedAt > new Date(collectedTo)) include = false;
      }
    }
    if (!include) continue;

    total += 1;
    if (limit === "all") {
      rows.push(payment);
      continue;
    }
    const rank = total - 1;
    if (rank >= skip && rank < end) rows.push({ rank, payment });
    tailRows.push({ rank, payment });
    if (tailRows.length > limit) tailRows.shift();
  }

  const totalPages = limit === "all" ? 1 : Math.max(1, Math.ceil(total / limit));
  const page = limit === "all" ? 1 : Math.min(requestedPage, totalPages);
  const pageSkip = limit === "all" ? 0 : (page - 1) * limit;
  const paginated = limit === "all"
    ? rows
    : (page === requestedPage ? rows : tailRows)
        .filter(({ rank }) => rank >= pageSkip && rank < pageSkip + limit)
        .map(({ payment }) => payment);
  const hasNext = page < totalPages;
  const creatorIds = [
    ...new Set(
      paginated
        .map((payment) => payment.createdBy)
        .filter((id) => mongoose.isObjectIdOrHexString(id))
        .map(String),
    ),
  ];
  const creators = creatorIds.length
    ? await User.find({ _id: { $in: creatorIds } }).select("name fullName username").lean()
    : [];
  const creatorsById = new Map(creators.map((creator) => [String(creator._id), creator]));
  const data = paginated.map((payment) => ({
    ...payment,
    createdBy: creatorsById.get(String(payment.createdBy)) || null,
  }));
  const grouped = new Map();
  for (const payment of data) {
    const key = cashDateDay(payment, dateType);
    if (!grouped.has(key)) grouped.set(key, { date: key, payments: [] });
    const group = grouped.get(key);
    group.payments.push(payment);
  }
  const pageGroups = [...grouped.values()].map((group) => ({
    date: group.date,
    ...cashSummary(group.payments),
    payments: group.payments,
  }));
  return {
    success: true,
    dateType,
    data,
    page,
    limit,
    total,
    hasMore: hasNext,
    status,
    today,
    yesterday,
    groups: pageGroups,
    filters: { tab, month, date, search: search.trim() },
    pagination: {
      page,
      pageSize: limit,
      total,
      totalRecords: total,
      totalPages,
      from: data.length ? pageSkip + 1 : 0,
      to: pageSkip + data.length,
      hasPrevious: page > 1,
      hasNext,
      hasPreviousPage: page > 1,
      hasNextPage: hasNext,
    },
  };
}

export const getCashCollectionPayments = async (req, res, next) => {
  try {
    return res.status(200).json(await readCashCollectionView(req));
  } catch (error) {
    console.error("Get Cash Collection Payments Error:", error);
    next(error);
  }
};

const computePhonePeFields = (payment) => {
  const method = String(payment.paymentMethod || "").toLowerCase();

  const collectibleAmount =
    method === "mixed"
      ? Number(payment.paymentBreakdown?.phonePe) || 0
      : Number(payment.amount) || 0;

  const collectedAmount = Number(payment.collectedPhonePe) || 0;

  const remainingAmount = Math.max(
    0,
    Number((collectibleAmount - collectedAmount).toFixed(2)),
  );

  const isCollected = remainingAmount <= AMOUNT_EPSILON;

  const lastPhonePeEntry =
    Array.isArray(payment.collectionHistory) && payment.collectionHistory.length
      ? [...payment.collectionHistory]
          .reverse()
          .find((entry) => entry.channel === "phonepe")
      : null;

  return {
    ...payment,
    collectibleAmount,
    remainingAmount,
    collectedAmount,
    isCollected,
    lastCollectedByName: lastPhonePeEntry?.collectedByName || null,
    lastCollectedAt: lastPhonePeEntry?.collectedAt || null,
  };
};

export const getPhonePeCollectionPayments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const limit = Math.min(
      MAX_PAGE_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_LIMIT),
    );

    const skip = (page - 1) * limit;

    const status = ["pending", "collected", "all"].includes(req.query.status)
      ? req.query.status
      : "pending";

    const rawPayments = await PaymentHistory.find({
      paymentMethod: { $in: ["phonepe", "mixed"] },
    })
      .populate("createdBy", "name fullName email username")
      .populate("collectionHistory.collectedBy", "name fullName email username")
      .sort({ createdAt: -1 })
      .lean();

    const computed = rawPayments.map(computePhonePeFields);

    /* ---- stats for tab badges & summary — always over the FULL set ---- */

    const todayStart = startOfToday();
    const todayEnd = endOfToday();

    const stats = {
      pending: { count: 0, amount: 0 },
      collectedToday: { count: 0, amount: 0 },
      collectedTotal: { count: 0, amount: 0 },
      all: { count: computed.length },
    };

    computed.forEach((payment) => {
      if (!payment.isCollected) {
        stats.pending.count += 1;
        stats.pending.amount += payment.remainingAmount;
        return;
      }

      stats.collectedTotal.count += 1;
      stats.collectedTotal.amount += payment.collectedAmount;

      const collectedAt = payment.lastCollectedAt ? new Date(payment.lastCollectedAt) : null;

      if (collectedAt && collectedAt >= todayStart && collectedAt <= todayEnd) {
        stats.collectedToday.count += 1;
        stats.collectedToday.amount += payment.collectedAmount;
      }
    });

    stats.pending.amount = Number(stats.pending.amount.toFixed(2));
    stats.collectedToday.amount = Number(stats.collectedToday.amount.toFixed(2));
    stats.collectedTotal.amount = Number(stats.collectedTotal.amount.toFixed(2));

    /* ---- filter by requested tab ---- */

    let filtered;

    if (status === "pending") {
      filtered = computed.filter((payment) => !payment.isCollected);
    } else if (status === "collected") {
      filtered = computed.filter((payment) => payment.isCollected);

      const { collectedFrom, collectedTo } = req.query;

      if (collectedFrom || collectedTo) {
        const from = collectedFrom ? new Date(collectedFrom) : null;
        const to = collectedTo ? new Date(collectedTo) : null;

        filtered = filtered.filter((payment) => {
          if (!payment.lastCollectedAt) return false;
          const collectedAt = new Date(payment.lastCollectedAt);
          if (from && collectedAt < from) return false;
          if (to && collectedAt > to) return false;
          return true;
        });
      }

      filtered.sort(
        (a, b) => new Date(b.lastCollectedAt || 0) - new Date(a.lastCollectedAt || 0),
      );
    } else {
      filtered = [...computed].sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
      );
    }

    const total = filtered.length;
    const paginatedPayments = filtered.slice(skip, skip + limit);
    const hasMore = skip + limit < total;

    return res.status(200).json({
      success: true,
      data: paginatedPayments,
      page,
      limit,
      total,
      hasMore,
      status,
      stats,
    });
  } catch (error) {
    console.error("Get PhonePe Collection Payments Error:", error);
    next(error);
  }
};

export const collectPhonePePayment = async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { amount, note } = req.body;

    const numericAmount = Number(amount);

    if (!paymentId) {
      return res.status(400).json({ success: false, message: "Payment ID is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
      return res.status(400).json({ success: false, message: "Invalid payment id" });
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: "A valid amount is required" });
    }

    const payment = await PaymentHistory.findOne({
      _id: paymentId,
      paymentMethod: { $in: ["phonepe", "mixed"] },
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: "PhonePe payment not found" });
    }

    const method = String(payment.paymentMethod || "").toLowerCase();

    const collectibleAmount =
      method === "mixed"
        ? Number(payment.paymentBreakdown?.phonePe) || 0
        : Number(payment.amount) || 0;

    if (collectibleAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "This payment has no PhonePe amount to collect",
      });
    }

    const alreadyCollected = Number(payment.collectedPhonePe) || 0;
    const remaining = Number((collectibleAmount - alreadyCollected).toFixed(2));

    // Optimistic-concurrency guard: another device/staff member may have
    // already verified the PhonePe portion between page load and this request.
    if (remaining <= AMOUNT_EPSILON) {
      return res.status(409).json({
        success: false,
        message: "This payment has already been verified by someone else.",
      });
    }

    if (numericAmount > remaining + AMOUNT_EPSILON) {
      return res.status(409).json({
        success: false,
        message: "Amount exceeds what's left to verify for this payment.",
      });
    }

    const collectedByName =
      req.user?.name || req.user?.fullName || req.user?.username || "";

    payment.collectionHistory.push({
      channel: "phonepe",
      collectedBy: req.user?._id,
      collectedByName,
      amount: numericAmount,
      note: note || "",
    });

    const newCollectedPhonePe = Number((alreadyCollected + numericAmount).toFixed(2));
    payment.collectedPhonePe = newCollectedPhonePe;

    const phonePeNowCollected = newCollectedPhonePe >= collectibleAmount - AMOUNT_EPSILON;

    // For a pure "phonepe" payment, keep legacy top-level fields in sync.
    if (method === "phonepe") {
      payment.collectedAmount = newCollectedPhonePe;
      payment.isCollected = phonePeNowCollected;
    }

    payment.lastCollectedAt = new Date();
    payment.lastCollectedBy = req.user?._id;

    // Same guard as cash: only save if the PhonePe total is still what we read.
    payment.$where = { collectedPhonePe: storedAmountIs(alreadyCollected) };

    try {
      await payment.save();
    } catch (error) {
      if (!isConcurrentUpdate(error)) throw error;
      return res.status(409).json({
        success: false,
        message: "This payment has already been verified by someone else.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        isCollected: phonePeNowCollected,
        transactionAmount: numericAmount,
        totalCollectedAmount: payment.collectedPhonePe,
        remainingAmount: Math.max(
          0,
          Number((collectibleAmount - payment.collectedPhonePe).toFixed(2)),
        ),
        collectedAt: payment.lastCollectedAt,
        collectedBy: collectedByName,
      },
    });
  } catch (error) {
    console.error("Collect PhonePe Payment Error:", error);
    next(error);
  }
};
