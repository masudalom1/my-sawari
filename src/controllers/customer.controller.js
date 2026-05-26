import Handover from "../models/handover.model.js";

export const getAllCustomers = async (req, res) => {
  try {
    const handovers = await Handover.find({
      company: req.user.company || req.user._id,
      isDeleted: false,
    }).sort({ createdAt: -1 });

    const customerMap = new Map();

    handovers.forEach((handover) => {
      const phone = handover.customer?.mobileNumber;

      if (!phone) return;

      if (!customerMap.has(phone)) {
        customerMap.set(phone, {
          id: handover._id,
          name: handover.customer.fullName || "-",
          phone: handover.customer.mobileNumber || "-",
          email: handover.customer.email || "-",
          idNo: handover.identity?.idNumber || "-",
          profession: handover.customer.occupation || "-",
          status:
            handover.handoverStatus === "active"
              ? "Active"
              : "Inactive",
          avatar:
            handover.images?.customerPhoto ||
            "https://via.placeholder.com/100",
          createdAt: handover.createdAt,
        });
      }
    });

    const customers = Array.from(customerMap.values());

    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    const stats = {
      total: customers.length,
      active: customers.filter((c) => c.status === "Active").length,
      inactive: customers.filter((c) => c.status === "Inactive").length,
      newThisMonth: customers.filter((c) => {
        const d = new Date(c.createdAt);
        return (
          d.getMonth() === currentMonth &&
          d.getFullYear() === currentYear
        );
      }).length,
    };

    res.status(200).json({
      success: true,
      stats,
      data: customers,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};