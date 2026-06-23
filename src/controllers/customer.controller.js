import Handover from "../models/handover.model.js";

export const getAllCustomers = async (req, res) => {
  try {
    const handovers = await Handover.find({
      isDeleted: false,
    }).sort({ createdAt: -1 });

    const customerMap = new Map();

    handovers.forEach((handover) => {
      const phone = handover.customer?.mobileNumber;

      if (!phone) return;

      const existing = customerMap.get(phone);

      if (
        !existing ||
        new Date(handover.createdAt) > new Date(existing.createdAt)
      ) {
        customerMap.set(phone, {
          id: handover._id,
          name: handover.customer?.fullName || "-",
          phone: handover.customer?.mobileNumber || "-",
          email: handover.customer?.email || "-",
          idNo:
            handover.identity?.aadhaarNumber ||
            handover.identity?.drivingLicenseNumber ||
            "-",
          profession: handover.customer?.occupation || "-",
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
      active: customers.filter(
        (customer) => customer.status === "Active"
      ).length,
      inactive: customers.filter(
        (customer) => customer.status === "Inactive"
      ).length,
      newThisMonth: customers.filter((customer) => {
        const date = new Date(customer.createdAt);

        return (
          date.getMonth() === currentMonth &&
          date.getFullYear() === currentYear
        );
      }).length,
    };

    return res.status(200).json({
      success: true,
      stats,
      data: customers,
    });
  } catch (error) {
    console.error("Get Customers Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch customers",
    });
  }
};