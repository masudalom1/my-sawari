import PaymentHistory from "../models/paymentHistory.model.js";

const getPaymentHistory = async (req, res, next) => {
  try {
    const { bookingId } = req.params;

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
      });
    }

    const companyId = req.user.company || req.user._id;

    const payments = await PaymentHistory.find({
      bookingId,
      company: companyId,
    })
      .populate("createdBy", "name fullName email")
      .sort({ createdAt: -1 })
      .lean();

    // ==========================
    // CALCULATE TOTAL PAID
    // ==========================
    const totalPaid = payments.reduce(
      (total, payment) => total + Number(payment.amount || 0),
      0,
    );

    // ==========================
    // GET TOTAL AMOUNT
    // ==========================
    const handover = await PaymentHistory.findOne({
      bookingId,
      company: companyId,
      handoverId: { $ne: null },
    })
      .sort({ createdAt: -1 })
      .lean();

    const totalAmount = handover?.totalAmount || 0;

    const balanceAmount = Math.max(
      Number(totalAmount) - totalPaid,
      0,
    );

    return res.status(200).json({
      success: true,

      summary: {
        totalAmount,
        totalPaid,
        balanceAmount,
      },

      data: payments,
    });
  } catch (error) {
    console.error("Get Payment History Error:", error);
    next(error);
  }
};

export default getPaymentHistory;