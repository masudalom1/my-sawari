import PaymentHistory from "../models/paymentHistory.model.js";

const getPaymentHistory = async (req, res, next) => {
  try {
    const payments = await PaymentHistory.find({})
      .populate("createdBy", "name fullName email")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: payments.length,
      data: payments,
    });
  } catch (error) {
    console.error("Get Payment History Error:", error);
    next(error);
  }
};

export default getPaymentHistory;
