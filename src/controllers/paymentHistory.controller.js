import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js";

const AMOUNT_EPSILON = 0.01;

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
    const remaining = collectibleAmount - alreadyCollected;

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
        collectedAmount: payment.collectedAmount,
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
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
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


