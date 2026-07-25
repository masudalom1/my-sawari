import mongoose from "mongoose";
import Booking from "../models/booking.model.js";
import Handover from "../models/handover.model.js";

/**
 * GET /api/bookings/:id/details
 * Returns a single booking with vehicle, handover, and lead data populated.
 * Used by the "View Booking" flow for Active Rental / Completed bookings.
 */
export const getBookingDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user?.company || req.user?._id; // adjust to your auth middleware shape

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

    // Flatten a bit so the frontend doesn't have to reach through
    // booking.handover.customer / booking.handover.payment etc. for
    // every field it already renders from the Booking doc itself.
    const handover = booking.handover || null;

    const data = {
      ...booking,

      // Prefer handover copies of these fields once handover exists
      // (they may have been edited/confirmed at handover time),
      // falling back to the original booking values.
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

      payment: handover?.payment || null,
      images: handover?.images || null,
      hasUploadedImages: handover?.hasUploadedImages ?? false,
      vehicleHistory: handover?.vehicleHistory || [],
      returnDetails: handover?.returnDetails || null,
      handoverStatus: handover?.handoverStatus || null,
      handoverNotes: handover?.notes || "",

      // Keep the raw nested handover doc too, in case the UI needs it as-is.
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