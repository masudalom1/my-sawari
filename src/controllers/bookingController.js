import mongoose from "mongoose";
import Booking from "../models/booking.model.js";
import Handover from "../models/handover.model.js";
import User from "../models/user.model.js";

export const getBookingDetails = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking id.",
      });
    }

    const booking = await Booking.findOne({
      _id: id,
      isDeleted: false,
    })
      .populate("vehicleId")
      .populate("lead")
      .populate({
        path: "handover",
        populate: [
          { path: "vehicle.vehicleId" },
          { path: "createdBy", select: "fullName email" },
          { path: "vehicleHistory.oldVehicle.vehicleId" },
          { path: "vehicleHistory.newVehicle.vehicleId" },
          { path: "returnDetails.returnedBy", select: "name email" },
        ],
      })
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
    }

    const handover = booking.handover || null;
    const handoverPayment = handover?.payment || null;
    const bookingPayment = booking.payment || null; // Booking schema's own estimate

    const computeStatus = (paid, balance) =>
      balance === 0 && paid > 0 ? "paid" : paid > 0 ? "partial" : "pending";

    // FIX: normalizedPayment is now built straight from the stored
    // `billSummary` object on whichever payment doc is active
    // (Handover.payment.billSummary once finalized, or
    // Booking.payment.billSummary at the estimate stage). billSummary is
    // already the fully-computed, saved-to-DB bill — pickupCharge,
    // dropCharge, totalFare, totalCollected, balanceAmount, all of it —
    // so there is no more re-deriving individual charges from unrelated
    // fields (booking.pickup.charge, manual addition for "collected",
    // etc.) that could drift out of sync with each other. One source of
    // truth in, one consistent shape out.
    const handoverBill = handoverPayment?.billSummary || null;
    const bookingBill = bookingPayment?.billSummary || null;

    const normalizedPayment = handoverBill
      ? {
          isFinal: true,
          vehicleFare: handoverBill.totalFare || 0,
          pickupCharge: handoverBill.pickupCharge || 0,
          dropCharge: handoverBill.dropCharge || 0,
          extraCharges: handoverBill.extraCharges || 0,
          discountAmount: handoverBill.discountAmount || 0,
          securityDeposit: handoverBill.securityDeposit || 0,
          fastTagPayableAmount: handoverBill.fastTagPayable || 0,
          totalAmount: handoverBill.totalAmount || 0,
          bookingAmountPaid: handoverBill.bookingAmountPaid || 0,
          amountReceivedNow: handoverBill.amountReceivedNow || 0,
          totalCollected:
            handoverBill.totalCollected ??
            (handoverBill.bookingAmountPaid || 0) +
              (handoverBill.amountReceivedNow || 0),
          balanceAmount: handoverBill.balanceAmount || 0,
          paymentMethod: handoverPayment.paymentMethod || null,
          paymentBreakdown: handoverPayment.paymentBreakdown || null,
          paymentStatus:
            handoverPayment.paymentStatus ||
            computeStatus(
              (handoverBill.bookingAmountPaid || 0) +
                (handoverBill.amountReceivedNow || 0),
              handoverBill.balanceAmount || 0,
            ),
        }
      : bookingBill
        ? {
            isFinal: false,
            vehicleFare: bookingBill.totalFare || 0,
            pickupCharge: bookingBill.pickupCharge || 0,
            dropCharge: bookingBill.dropCharge || 0,
            extraCharges: bookingBill.extraCharges || 0,
            discountAmount: bookingBill.discountAmount || 0,
            securityDeposit: bookingBill.securityDeposit || 0,
            fastTagPayableAmount: bookingBill.fastTagPayable || 0,
            totalAmount: bookingBill.totalAmount || 0,
            bookingAmountPaid: bookingBill.bookingAmountPaid || 0,
            amountReceivedNow: bookingBill.amountReceivedNow || 0,
            totalCollected:
              bookingBill.totalCollected ??
              (bookingBill.bookingAmountPaid || 0) +
                (bookingBill.amountReceivedNow || 0),
            balanceAmount: bookingBill.balanceAmount || 0,
            paymentMethod: bookingPayment.paymentMethod || null,
            paymentBreakdown: bookingPayment.paymentBreakdown || null,
            paymentStatus:
              bookingPayment.paymentStatus ||
              computeStatus(
                bookingBill.bookingAmountPaid || 0,
                bookingBill.balanceAmount || 0,
              ),
          }
        : null;

    const data = {
      ...booking,

      customerName: handover?.customer?.fullName || booking.customerName,
      mobileNumber: handover?.customer?.mobileNumber || booking.mobileNumber,
      alternateMobileNumber:
        handover?.customer?.alternateMobileNumber ||
        booking.alternateMobileNumber,
      occupation: handover?.customer?.occupation || booking.occupation,
      destination: handover?.customer?.destination || booking.destination,

      aadhaarNumber: handover?.identity?.aadhaarNumber || booking.aadhaarNumber,
      drivingLicenseNumber:
        handover?.identity?.drivingLicenseNumber ||
        booking.drivingLicenseNumber,

      vehicleName: handover?.vehicle?.vehicleName || booking.vehicleName,
      vehicleNumber: handover?.vehicle?.vehicleNumber || booking.vehicleNumber,
      vehicleColor: handover?.vehicle?.vehicleColor || booking.vehicleColor,
      handoverKm: handover?.vehicle?.handoverKm ?? null,

      payment: normalizedPayment, // <-- always populated, sourced from billSummary
      images: handover?.images || null,
      hasUploadedImages: handover?.hasUploadedImages ?? false,
      vehicleHistory: handover?.vehicleHistory || [],
      returnDetails: handover?.returnDetails || null,
      handoverStatus: handover?.handoverStatus || null,
      handoverNotes: handover?.notes || "",

      handoverInfo: handover
  ? {
      fullName: handover.createdBy?.fullName || "",
      email: handover.createdBy?.email || "",
      handoverDateTime: handover.createdAt,
    }
  : null,

      handoverRecord: handover,
    };

    return res.json({
      success: true,
      booking: data,
    });
  } catch (error) {
    console.error("getBookingDetails error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch booking details.",
    });
  }
};

export const getBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user?.company || req.user?._id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking id.",
      });
    }

    const booking = await Booking.findOne({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
      isDeleted: false,
    })
      .populate("vehicleId")
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
    }

    return res.json({ success: true, booking });
  } catch (error) {
    console.error("getBookingById error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch booking.",
    });
  }
};
export const getDrivers = async (req, res) => {
  try {
    const drivers = await User.find({
      role: "driver",
      isDeleted: false,
    })
      .select("fullName mobileNumber profileImage")
      .sort({ fullName: 1 });

    return res.json({
      success: true,
      data: drivers,
    });
  } catch (err) {
    console.error("getDrivers error:", err);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch drivers.",
    });
  }
};
export const assignDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(driverId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid id.",
      });
    }

    const booking = await Booking.findOne({
      lead: id,
      isDeleted: false,
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
    }

    const driver = await User.findOne({
      _id: driverId,
      role: "driver",
      isDeleted: false,
    });

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found.",
      });
    }

    booking.assignedDriver = driverId;

    await booking.save();

    await booking.populate(
      "assignedDriver",
      "fullName mobileNumber profileImage"
    );

    return res.json({
      success: true,
      message: "Driver assigned successfully.",
      data: booking.assignedDriver,
    });
  } catch (err) {
    console.error("assignDriver error:", err);

    return res.status(500).json({
      success: false,
      message: "Unable to assign driver.",
    });
  }
};