import mongoose from "mongoose";
import Booking from "../models/booking.model.js";
import Handover from "../models/handover.model.js";

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
          { path: "createdBy", select: "name email" },
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

    // FIX: vehicleFare now comes straight from the field the DB actually
    // stores it under — there is no field literally called "vehicleFare"
    // in either schema:
    //   - Handover.payment.totalFare   → the vehicle rent figure once the
    //     handover is finalized (see Handover model: totalFare, required).
    //   - Booking.payment.vehicleRent  → the vehicle rent figure at the
    //     booking/estimate stage (see Booking model: payment.vehicleRent).
    // The frontend previously tried to guess this from several
    // never-populated field names (baseFare, rentAmount, vehiclePrice...)
    // and fell back to reverse-engineering it via subtraction, which is
    // what produced the ₹2000 → ₹2200-style mismatches. Mapping it here,
    // once, from the correct source field removes the guesswork entirely.
    const normalizedPayment = handoverPayment
      ? {
          isFinal: true,
          vehicleFare: handoverPayment.totalFare || 0,
          totalAmount:
            handoverPayment.totalAmount ?? handoverPayment.totalFare ?? 0,
          extraCharges: handoverPayment.extraCharges || 0,
          discountAmount: handoverPayment.discountAmount || 0,
          securityDeposit: handoverPayment.securityDeposit || 0,
          fastTagPayableAmount: handoverPayment.fastTagPayableAmount || 0,
          bookingAmountPaid: handoverPayment.bookingAmountPaid || 0,
          amountReceivedNow: handoverPayment.amountReceivedNow || 0,
          balanceAmount: handoverPayment.balanceAmount || 0,
          paymentMethod: handoverPayment.paymentMethod || null,
          paymentBreakdown: handoverPayment.paymentBreakdown || null,
          paymentStatus:
            handoverPayment.paymentStatus ||
            computeStatus(
              (handoverPayment.bookingAmountPaid || 0) +
                (handoverPayment.amountReceivedNow || 0),
              handoverPayment.balanceAmount || 0,
            ),
        }
      : bookingPayment
        ? {
            isFinal: false,
            vehicleFare: bookingPayment.vehicleRent || 0,
            totalAmount: bookingPayment.totalAmount || 0,
            extraCharges: 0,
            discountAmount: bookingPayment.discountAmount || 0,
            securityDeposit: bookingPayment.securityDeposit || 0,
            fastTagPayableAmount: bookingPayment.fastagAmount || 0,
            bookingAmountPaid: bookingPayment.bookingAmountPaid || 0,
            amountReceivedNow: 0,
            balanceAmount: bookingPayment.balanceAmount || 0,
            paymentMethod: bookingPayment.paymentMethod || null,
            paymentBreakdown: bookingPayment.paymentBreakdown || null,
            paymentStatus:
              bookingPayment.paymentStatus ||
              computeStatus(
                bookingPayment.bookingAmountPaid || 0,
                bookingPayment.balanceAmount || 0,
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

      payment: normalizedPayment, // <-- always populated, one consistent shape, vehicleFare included
      images: handover?.images || null,
      hasUploadedImages: handover?.hasUploadedImages ?? false,
      vehicleHistory: handover?.vehicleHistory || [],
      returnDetails: handover?.returnDetails || null,
      handoverStatus: handover?.handoverStatus || null,
      handoverNotes: handover?.notes || "",

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