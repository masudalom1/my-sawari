import PaymentHistory from "../models/paymentHistory.model.js";

const getPaymentHistory = async (req, res, next) => {
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

export default getPaymentHistory;
