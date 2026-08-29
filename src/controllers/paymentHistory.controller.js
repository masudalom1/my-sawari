import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js";

const AMOUNT_EPSILON = 0.01;

const MAX_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 12;

const computePaymentFields = (payment) => {
  const method = String(payment.paymentMethod || "").toLowerCase();

  const collectibleAmount =
    method === "mixed"
      ? Number(payment.paymentBreakdown?.cash) || 0
      : Number(payment.amount) || 0;

  const collectedAmount = Number(payment.collectedAmount) || 0;

  const remainingAmount = Math.max(
    0,
    Number((collectibleAmount - collectedAmount).toFixed(2)),
  );

  const isCollected = remainingAmount <= AMOUNT_EPSILON;

  const lastEntry =
    Array.isArray(payment.collectionHistory) && payment.collectionHistory.length
      ? payment.collectionHistory[payment.collectionHistory.length - 1]
      : null;

  return {
    ...payment,
    collectibleAmount,
    collectedAmount,
    remainingAmount,
    isCollected,
    lastCollectedByName: lastEntry?.collectedByName || null,
  };
};

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfToday = () => {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date;
};

export const collectCashPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount, note } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment id",
      });
    }

    const payment = await PaymentHistory.findById(id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
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
    const remaining = Number((collectibleAmount - alreadyCollected).toFixed(2));

    const collectAmount = amount != null ? Number(amount) : remaining;

    if (!Number.isFinite(collectAmount) || collectAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection amount",
      });
    }

    if (collectAmount > remaining + AMOUNT_EPSILON) {
      return res.status(400).json({
        success: false,
        message: `Cannot collect more than the remaining ₹${remaining.toFixed(2)}`,
      });
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
      collectedBy: collectorId,
      collectedByName: collectorName,
      amount: collectAmount,
      note: note || "",
    });

    payment.collectedAmount = Number(
      (alreadyCollected + collectAmount).toFixed(2),
    );

    payment.lastCollectedAt = new Date();
    payment.lastCollectedBy = collectorId;
    payment.isCollected =
      payment.collectedAmount >= collectibleAmount - AMOUNT_EPSILON;

    await payment.save();

    const latestEntry =
      payment.collectionHistory[payment.collectionHistory.length - 1];

    return res.status(200).json({
      success: true,
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

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const listQuery = PaymentHistory.find({})
      .populate("createdBy", "name fullName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const summaryPromise =
      page === 1
        ? PaymentHistory.aggregate([
            { $match: { createdAt: { $gte: startOfToday, $lte: endOfToday } } },
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
export const getCashCollectionPayments = async (req, res, next) => {
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

    /*
     * NOTE ON SCALE:
     * We load every cash/mixed PaymentHistory record into memory and
     * compute remainingAmount in JS, because old records can't be
     * trusted to have an accurate `isCollected` flag stored. This is
     * fine at moderate volume (hundreds/low thousands of records). If
     * this collection grows large, move this to a Mongo aggregation
     * pipeline ($addFields + $match + $facet) so filtering and
     * pagination happen in the DB instead of in Node.
     */
    const rawPayments = await PaymentHistory.find({
      paymentMethod: { $in: ["cash", "mixed"] },
    })
      .populate("createdBy", "name fullName email username")
      .sort({ createdAt: -1 })
      .lean();

    const computed = rawPayments.map(computePaymentFields);

    /* ---- stats for tab badges & summary — always computed over the
       FULL data set, independent of the current page, so the UI can
       show an exact total even before every page has loaded ---- */

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

      const collectedAt = payment.lastCollectedAt
        ? new Date(payment.lastCollectedAt)
        : null;

      if (collectedAt && collectedAt >= todayStart && collectedAt <= todayEnd) {
        stats.collectedToday.count += 1;
        stats.collectedToday.amount += payment.collectedAmount;
      }
    });

    stats.pending.amount = Number(stats.pending.amount.toFixed(2));
    stats.collectedToday.amount = Number(
      stats.collectedToday.amount.toFixed(2),
    );
    stats.collectedTotal.amount = Number(
      stats.collectedTotal.amount.toFixed(2),
    );

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
        (a, b) =>
          new Date(b.lastCollectedAt || 0) - new Date(a.lastCollectedAt || 0),
      );
    } else {
      // "all" — already sorted newest-first by createdAt from the query
      filtered = computed;
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
    console.error("Get Cash Collection Payments Error:", error);
    next(error);
  }
};


const computePhonePeFields = (payment) => {
  const collectibleAmount = Number(payment.amount) || 0;
  const collectedAmount = Number(payment.collectedAmount) || 0;
  const remainingAmount = Math.max(0, collectibleAmount - collectedAmount);

  return {
    ...payment,
    collectibleAmount,
    remainingAmount: Number(remainingAmount.toFixed(2)),
    collectedAmount: Number(collectedAmount.toFixed(2)),
    isCollected: Boolean(payment.isCollected),
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
      paymentMethod: "phonepe",
    })
      .populate("createdBy", "name fullName email username")
      .populate("lastCollectedBy", "name fullName email username")
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

      const collectedAt = payment.lastCollectedAt
        ? new Date(payment.lastCollectedAt)
        : null;

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
        (a, b) =>
          new Date(b.lastCollectedAt || 0) - new Date(a.lastCollectedAt || 0),
      );
    } else {
      // "all" — already sorted newest-first by createdAt from the query
      filtered = computed;
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
      return res.status(400).json({
        success: false,
        message: "Payment ID is required",
      });
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid amount is required",
      });
    }

    const payment = await PaymentHistory.findOne({
      _id: paymentId,
      paymentMethod: "phonepe",
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "PhonePe payment not found",
      });
    }

    // Optimistic-concurrency guard: another device/staff member may have
    // already verified this payment between page load and this request.
    if (payment.isCollected) {
      return res.status(409).json({
        success: false,
        message: "This payment has already been verified by someone else.",
      });
    }

    const alreadyCollected = Number(payment.collectedAmount) || 0;
    const remaining = Number(payment.amount) - alreadyCollected;

    if (numericAmount > remaining + 0.01) {
      return res.status(409).json({
        success: false,
        message: "Amount exceeds what's left to verify for this payment.",
      });
    }

    const collectedByName =
      req.user?.name || req.user?.fullName || req.user?.username || "";

    payment.collectionHistory.push({
      collectedBy: req.user?._id,
      collectedByName,
      amount: numericAmount,
      note: note || "",
    });

    const newCollectedAmount = Number(
      (alreadyCollected + numericAmount).toFixed(2),
    );

    payment.collectedAmount = newCollectedAmount;
    payment.isCollected = newCollectedAmount >= Number(payment.amount) - 0.01;
    payment.lastCollectedAt = new Date();
    payment.lastCollectedBy = req.user?._id;

    await payment.save();

    return res.status(200).json({
      success: true,
      data: {
        transactionAmount: numericAmount,
        totalCollectedAmount: payment.collectedAmount,
        collectedAt: payment.lastCollectedAt,
        collectedBy: collectedByName,
      },
    });
  } catch (error) {
    console.error("Collect PhonePe Payment Error:", error);
    next(error);
  }
};
