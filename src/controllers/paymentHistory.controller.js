import PaymentHistory from "../models/paymentHistory.model.js";

const getPaymentHistory = async (req, res, next) => {
  try {
    const payments = await PaymentHistory.find({})
      .populate("createdBy", "name fullName email")
      .sort({ createdAt: -1 })
      .lean();

    // Start of today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // End of today
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const todayPayments = payments.filter((payment) => {
      const createdAt = new Date(payment.createdAt);

      return createdAt >= startOfToday && createdAt <= endOfToday;
    });

    let totalCollection = 0;
    let cash = 0;
    let phonePe = 0;

    todayPayments.forEach((payment) => {
      const amount = Number(payment.amount) || 0;

      // Refund should reduce collection
      const multiplier = payment.type === "refund" ? -1 : 1;

      if (payment.paymentMethod === "mixed") {
        const mixedCash =
          Number(payment.paymentBreakdown?.cash) || 0;

        const mixedPhonePe =
          Number(payment.paymentBreakdown?.phonePe) || 0;

        cash += mixedCash * multiplier;
        phonePe += mixedPhonePe * multiplier;

        totalCollection += amount * multiplier;
      } else {
        totalCollection += amount * multiplier;

        if (payment.paymentMethod === "cash") {
          cash += amount * multiplier;
        }

        if (payment.paymentMethod === "phonepe") {
          phonePe += amount * multiplier;
        }
      }
    });

    return res.status(200).json({
      success: true,
      count: payments.length,
      data: payments,

      todaySummary: {
        totalCollection,
        cash,
        phonePe,
      },
    });
  } catch (error) {
    console.error("Get Payment History Error:", error);
    next(error);
  }
};

export default getPaymentHistory;
