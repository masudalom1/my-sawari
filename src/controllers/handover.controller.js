import mongoose from "mongoose";
import Handover from "../models/handover.model.js";
import Vehicle from "../models/vehicle.model.js";
import { sendBookingConfirmation } from "../services/wati.service.js";
import VehicleReturn from "../models/vehicleReturn.model.js";
import Booking from "../models/booking.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";

const PAGE_SIZE_DEFAULT = 10;
const MAX_PAGE_LIMIT = 30;
//extra function helper
const IST_TZ = "Asia/Kolkata";
// recieved list
function istDayBoundsUTC(yyyyMmDd) {
  const startUTC = new Date(`${yyyyMmDd}T00:00:00+05:30`);
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
  return { startUTC, endUTC };
}
// recieved list helper
async function countNonCompleted(baseMatch, dateFilter) {
  const result = await Handover.aggregate([
    { $match: { ...baseMatch, ...dateFilter } },
    {
      $lookup: {
        from: VehicleReturn.collection.name,
        let: { hid: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$handover", "$$hid"] },
                  { $eq: ["$returnStatus", "completed"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "ret",
      },
    },
    { $match: { ret: { $size: 0 } } },
    { $count: "count" },
  ]);
  return result[0]?.count || 0;
}

/* =========================================================
   HELPERS
========================================================= */

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const parseDateParam = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ==========================================
// Draft contoller
// ==========================================
export const createDraftHandover = async (req, res) => {
  try {
    const draft = await Handover.create({
      company: req.user.company || req.user._id,
      createdBy: req.user._id,

      bookingStatus: "draft",

      draftProgress: {
        enabled: true,
        currentScreen: "customer",
        customerCompleted: false,
        vehicleCompleted: false,
        tripCompleted: false,
        paymentCompleted: false,
        imagesCompleted: false,
        uploadedImages: 0,
        totalImages: 9,
        lastSavedAt: new Date(),
      },

      customer: {
        fullName: "",
        mobileNumber: "",
        alternateMobileNumber: "",
        occupation: "",
        destination: "",
      },

      identity: {
        aadhaarNumber: "",
        drivingLicenseNumber: "",
      },

      vehicle: {
        vehicleId: null,
        vehicleName: "",
        vehicleNumber: "",
        vehicleColor: "",
        handoverKm: 0,
      },

      trip: {
        tripType: "local",
        numberOfDays: 1,
        pickupDateTime: null,
        dropDateTime: null,
      },

      payment: {
        fuelLevel: 7,
        fastTagBalance: 0,
        fastTagPayableAmount: 0,
        totalFare: 0,
        securityDeposit: 0,
        extraCharges: 0,
        discountAmount: 0,
        totalAmount: 0,
        bookingAmountPaid: 0,
        amountReceivedNow: 0,
        balanceAmount: 0,
        paymentMethod: "cash",
        paymentBreakdown: {
          cash: 0,
          phonePe: 0,
          razorpay: 0,
        },
        paymentStatus: "pending",
      },

      notes: "",

      images: {
        customerPhoto: "",
        customerProfileImage: "",
        customerWithVehicle: "",
        idCardFront: "",
        idCardBack: "",
        vehicleFront: "",
        vehicleRear: "",
        vehicleLeft: "",
        vehicleRight: "",
      },
    });

    return res.status(201).json({
      success: true,
      message: "Draft handover created successfully.",
      data: {
        handoverId: draft._id,
        bookingStatus: draft.bookingStatus,
        draftProgress: draft.draftProgress,
      },
    });
  } catch (error) {
    console.error("Create Draft Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create draft.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const updateDraftHandover = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid handover id",
      });
    }

    const handover = await Handover.findById(id);

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Draft not found",
      });
    }

    const { customer, identity, vehicle, trip, payment, notes, currentScreen } =
      req.body;

    if (customer) {
      handover.customer = {
        ...handover.customer.toObject(),
        ...customer,
      };
    }

    if (identity) {
      handover.identity = {
        ...handover.identity.toObject(),
        ...identity,
      };
    }

    if (vehicle) {
      handover.vehicle = {
        ...handover.vehicle.toObject(),
        ...vehicle,
      };
    }

    if (trip) {
      handover.trip = {
        ...handover.trip.toObject(),
        ...trip,
      };
    }

    if (payment) {
      handover.payment = {
        ...handover.payment.toObject(),
        ...payment,
      };
    }

    if (notes !== undefined) {
      handover.notes = notes;
    }

    if (currentScreen) {
      handover.draftProgress.currentScreen = currentScreen;
    }

    handover.draftProgress.enabled = true;
    handover.draftProgress.lastSavedAt = new Date();

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Draft auto-saved.",
      data: handover,
    });
  } catch (error) {
    console.error("Update Draft Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to save draft.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const updateDraftImages = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid handover id",
      });
    }

    const handover = await Handover.findById(id);

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Draft not found",
      });
    }

    if (!handover.images) {
      handover.images = {};
    }

    const files = req.files || {};

    if (files.customerPhoto?.[0]) {
      handover.images.customerPhoto = files.customerPhoto[0].path;
    }

    if (files.customerProfileImage?.[0]) {
      handover.images.customerProfileImage = files.customerProfileImage[0].path;
    }

    if (files.customerWithVehicle?.[0]) {
      handover.images.customerWithVehicle = files.customerWithVehicle[0].path;
    }

    if (files.idCardFront?.[0]) {
      handover.images.idCardFront = files.idCardFront[0].path;
    }

    if (files.idCardBack?.[0]) {
      handover.images.idCardBack = files.idCardBack[0].path;
    }

    if (files.vehicleFront?.[0]) {
      handover.images.vehicleFront = files.vehicleFront[0].path;
    }

    if (files.vehicleRear?.[0]) {
      handover.images.vehicleRear = files.vehicleRear[0].path;
    }

    if (files.vehicleLeft?.[0]) {
      handover.images.vehicleLeft = files.vehicleLeft[0].path;
    }

    if (files.vehicleRight?.[0]) {
      handover.images.vehicleRight = files.vehicleRight[0].path;
    }

    handover.draftProgress.enabled = true;
    handover.draftProgress.currentScreen = "images";
    handover.draftProgress.lastSavedAt = new Date();

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Images saved successfully.",
      data: {
        uploadedImages: handover.draftProgress.uploadedImages,
        totalImages: handover.draftProgress.totalImages,
        imagesCompleted: handover.draftProgress.imagesCompleted,
      },
    });
  } catch (error) {
    console.error("Upload Draft Images Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to upload images.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const getLatestDraftHandover = async (req, res) => {
  try {
    const draft = await Handover.findOne({
      bookingStatus: "draft",
      isDeleted: false,
    })
      .populate("vehicle.vehicleId", "vehicleName vehicleNumber")
      .sort({ updatedAt: -1 })
      .lean();

    if (!draft) {
      return res.status(200).json({
        success: true,
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        _id: draft._id,

        customer: draft.customer,

        vehicle: draft.vehicle,

        trip: draft.trip,

        payment: draft.payment,

        images: draft.images,

        draftProgress: draft.draftProgress,

        bookingStatus: draft.bookingStatus,

        updatedAt: draft.updatedAt,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch latest draft.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const getHandoverById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid handover id",
      });
    }

    const handover = await Handover.findById(id)
      .populate("createdBy", "fullName email mobileNumber role")
      .populate("vehicle.vehicleId")
      .populate("extensionBills.createdBy", "fullName email")
      .lean();

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    const payment = handover.payment || {};
    const billSummary = payment.billSummary || {};

    const extensionBills = [...(handover.extensionBills || [])].sort(
      (a, b) => a.billNumber - b.billNumber,
    );

    const totalExtensionAmount = extensionBills.reduce(
      (sum, bill) => sum + (bill.extensionAmount || 0),
      0,
    );

    const totalExtensionCollected = extensionBills.reduce(
      (sum, bill) => sum + (bill.amountCollected || 0),
      0,
    );

    const extensionHistory = extensionBills.map((bill) => ({
      _id: bill._id,

      billNumber: bill.billNumber,

      previousDropDateTime: bill.previousDropDateTime,
      newDropDateTime: bill.newDropDateTime,

      previousNumberOfDays: bill.previousNumberOfDays,
      newNumberOfDays: bill.newNumberOfDays,

      extraDays: bill.extraDays,

      extensionAmount: bill.extensionAmount,

      amountCollected: bill.amountCollected,

      remainingAmount: Math.max(
        (bill.extensionAmount || 0) - (bill.amountCollected || 0),
        0,
      ),

      totalFareAfterThisBill: bill.totalFareAfterThisBill,

      reason: bill.reason,

      createdBy: bill.createdBy,

      createdAt: bill.createdAt,
    }));

    const latestExtension =
      extensionHistory.length > 0
        ? extensionHistory[extensionHistory.length - 1]
        : null;

    handover.payment.billSummary = {
      ...billSummary,

      extensionSummary: {
        totalExtensions: extensionHistory.length,

        totalExtensionAmount,

        totalExtensionCollected,

        totalOutstanding: Math.max(
          totalExtensionAmount - totalExtensionCollected,
          0,
        ),

        latestExtension,

        history: extensionHistory,
      },
    };

    return res.status(200).json({
      success: true,
      data: handover,
    });
  } catch (error) {
    console.error("GET HANDOVER BY ID ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch handover.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const completeDraftHandover = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid handover id",
      });
    }

    const handover = await Handover.findById(id);

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Draft not found",
      });
    }

    if (!handover.draftProgress.customerCompleted) {
      return res.status(400).json({
        success: false,
        message: "Customer details are incomplete.",
      });
    }

    if (!handover.draftProgress.vehicleCompleted) {
      return res.status(400).json({
        success: false,
        message: "Vehicle details are incomplete.",
      });
    }

    if (!handover.draftProgress.tripCompleted) {
      return res.status(400).json({
        success: false,
        message: "Trip details are incomplete.",
      });
    }

    if (!handover.draftProgress.paymentCompleted) {
      return res.status(400).json({
        success: false,
        message: "Payment details are incomplete.",
      });
    }

    if (!handover.draftProgress.imagesCompleted) {
      return res.status(400).json({
        success: false,
        message: `Please upload all images (${handover.draftProgress.uploadedImages}/${handover.draftProgress.totalImages}).`,
      });
    }

    const vehicle = await Vehicle.findById(handover.vehicle.vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found.",
      });
    }

    if (vehicle.status !== "available") {
      return res.status(400).json({
        success: false,
        message: "Vehicle is not available.",
      });
    }

    vehicle.status = "rent";

    if (handover.vehicle.handoverKm) {
      vehicle.currentKm = handover.vehicle.handoverKm;
    }

    await vehicle.save();

    handover.bookingStatus = "confirmed";

    handover.draftProgress.enabled = false;

    handover.draftProgress.currentScreen = "completed";

    await handover.save();

    try {
      await sendBookingConfirmation({
        customer: handover.customer,
        vehicle: handover.vehicle,
        trip: handover.trip,
        payment: handover.payment,
      });
    } catch (err) {
      console.log("WhatsApp Error:", err.message);
    }

    return res.status(200).json({
      success: true,
      message: "Handover completed successfully.",
      data: handover,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Unable to complete handover.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
// ==========================================
// CREATE HANDOVER
// ==========================================
export const createHandover = async (req, res, next) => {
  try {
    const {
      bookingId,
      customer,
      identity,
      vehicle,
      trip,
      payment,
      notes,
      bookingStatus,
    } = req.body;

    const files = req.files || {};

    // ==========================
    // VALIDATIONS
    // ==========================
    if (!customer?.fullName || !customer?.mobileNumber) {
      return res.status(400).json({
        success: false,
        message: "Customer details are required",
      });
    }

    if (!identity?.aadhaarNumber || !identity?.drivingLicenseNumber) {
      return res.status(400).json({
        success: false,
        message: "Aadhaar and Driving License are required",
      });
    }

    if (!vehicle?.vehicleId) {
      return res.status(400).json({
        success: false,
        message: "Vehicle selection is required",
      });
    }

    if (!trip?.pickupDateTime || !trip?.dropDateTime) {
      return res.status(400).json({
        success: false,
        message: "Trip dates are required",
      });
    }

    // ==========================
    // NORMALIZE / VALIDATE UPI LAST 4 DIGITS
    // ==========================
    // Accepts an array of 4-digit strings (new multi-entry format).
    // Falls back gracefully if a single string is somehow still sent,
    // so older clients don't break outright.
    const rawUpiLast4 = payment?.upiLast4;
    const upiLast4List = Array.isArray(rawUpiLast4)
      ? rawUpiLast4
      : rawUpiLast4
        ? [rawUpiLast4]
        : [];

    const normalizedUpiLast4 = upiLast4List
      .map((v) => String(v || "").trim())
      .filter((v) => v.length > 0);

    const hasInvalidUpiEntry = normalizedUpiLast4.some(
      (v) => !/^\d{4}$/.test(v),
    );

    if (hasInvalidUpiEntry) {
      return res.status(400).json({
        success: false,
        message: "Each UPI last 4 digits entry must contain exactly 4 numbers",
      });
    }

    // ==========================
    // CHECK VEHICLE
    // ==========================
    const selectedVehicle = await Vehicle.findOne({
      _id: vehicle.vehicleId,
      isDeleted: false,
    });

    if (!selectedVehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    if (selectedVehicle.status !== "available") {
      return res.status(400).json({
        success: false,
        message: "Selected vehicle is not available",
      });
    }
    if (
      payment?.fuelLevel === undefined ||
      payment.fuelLevel < 0 ||
      payment.fuelLevel > 7
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid fuel level",
      });
    }

    const booking = await Booking.findById(bookingId);

    // ==========================
    // CREATE HANDOVER
    // ==========================
    const handover = await Handover.create({
      company: req.user.company || req.user._id,
      createdBy: req.user._id,
      bookingId,
      customer: {
        fullName: customer.fullName,
        mobileNumber: customer.mobileNumber,
        alternateMobileNumber: customer.alternateMobileNumber || "",
        occupation: customer.occupation || "",
        destination: customer.destination || "",
      },

      identity: {
        aadhaarNumber: identity.aadhaarNumber,
        drivingLicenseNumber: identity.drivingLicenseNumber,
      },

      vehicle: {
        vehicleId: selectedVehicle._id,
        vehicleName: selectedVehicle.vehicleName,
        vehicleNumber: selectedVehicle.vehicleNumber,
        vehicleColor: selectedVehicle.color || "",
        handoverKm: Number(vehicle?.handoverKm) || 0,
        spareAvailable: vehicle?.spareAvailable === true,
        toolkitAvailable: vehicle?.toolkitAvailable === true,
      },

      trip: {
        tripType: trip?.tripType || "local",
        numberOfDays: Number(trip?.numberOfDays) || 1,
        pickupDateTime: trip.pickupDateTime,
        dropDateTime: trip.dropDateTime,
      },

      payment: {
        fuelLevel:
          payment?.fuelLevel !== undefined ? Number(payment.fuelLevel) : 7,

        fastTagBalance: Number(payment?.fastTagBalance) || 0,

        fastTagPayableAmount: Number(payment?.fastTagPayableAmount) || 0,

        totalFare: Number(payment?.totalFare) || 0,

        securityDeposit: Number(payment?.securityDeposit) || 0,

        extraCharges: Number(payment?.extraCharges) || 0,

        discountAmount: Number(payment?.discountAmount) || 0,

        totalAmount: Number(payment?.totalAmount) || 0,

        bookingAmountPaid: Number(payment?.bookingAmountPaid) || 0,

        amountReceivedNow: Number(payment?.amountReceivedNow) || 0,

        balanceAmount: Number(payment?.balanceAmount) || 0,

        paymentMethod: payment?.paymentMethod || "cash",

        upiLast4: normalizedUpiLast4,

        paymentBreakdown: {
          cash: Number(payment?.paymentBreakdown?.cash) || 0,

          phonePe: Number(payment?.paymentBreakdown?.phonePe) || 0,

          razorpay: Number(payment?.paymentBreakdown?.razorpay) || 0,
        },
        billSummary: {
          totalFare: Number(payment?.totalFare) || 0,

          fastTagPayable: Number(payment?.fastTagPayableAmount) || 0,

          pickupCharge: Number(booking?.pickup?.charge) || 0,

          dropCharge: Number(booking?.drop?.charge) || 0,

          securityDeposit: Number(payment?.securityDeposit) || 0,

          extraCharges: Number(payment?.extraCharges) || 0,

          discountAmount: Number(payment?.discountAmount) || 0,

          totalAmount: Number(payment?.totalAmount) || 0,

          bookingAmountPaid: Number(payment?.bookingAmountPaid) || 0,

          amountReceivedNow: Number(payment?.amountReceivedNow) || 0,

          totalCollected:
            Number(payment?.bookingAmountPaid || 0) +
            Number(payment?.amountReceivedNow || 0),

          balanceAmount: Number(payment?.balanceAmount) || 0,
        },
      },

      notes: notes || "",

      bookingStatus: "draft",

      images: {
        customerPhoto: files?.customerPhoto?.[0]?.path || "",

        customerWithVehicle: files?.customerWithVehicle?.[0]?.path || "",

        vehicleFront: files?.vehicleFront?.[0]?.path || "",

        vehicleRear: files?.vehicleRear?.[0]?.path || "",

        vehicleLeft: files?.vehicleLeft?.[0]?.path || "",

        vehicleRight: files?.vehicleRight?.[0]?.path || "",
      },
    });

    // ==========================
    // CREATE PAYMENT HISTORY
    // ==========================
    // Only record money actually received during handover.
    // bookingAmountPaid is NOT recorded here because it may
    // have been collected previously during booking.
    if (Number(payment?.amountReceivedNow) > 0) {
      try {
        await PaymentHistory.create({
          company: req.user.company || req.user._id,

          bookingId,

          handoverId: handover._id,

          customer: {
            fullName: customer.fullName,
            mobileNumber: customer.mobileNumber,
          },

          vehicle: {
            vehicleId: selectedVehicle._id,
            vehicleName: selectedVehicle.vehicleName,
            vehicleNumber: selectedVehicle.vehicleNumber,
          },

          amount: Number(payment.amountReceivedNow),

          paymentMethod: payment?.paymentMethod || "cash",
          upiLast4: normalizedUpiLast4,

          paymentBreakdown: {
            cash: Number(payment?.paymentBreakdown?.cash) || 0,
            phonePe: Number(payment?.paymentBreakdown?.phonePe) || 0,
            razorpay: Number(payment?.paymentBreakdown?.razorpay) || 0,
          },

          type: "handover",

          note: "Payment received during vehicle handover",

          createdBy: req.user._id,
        });
      } catch (paymentHistoryError) {
        // Do NOT break the handover flow if payment history fails.
        console.error(
          "Payment History Creation Error:",
          paymentHistoryError?.message || paymentHistoryError,
        );
      }
    }

    // ==========================
    // UPDATE VEHICLE STATUS
    // ==========================
    selectedVehicle.status = "rent";

    if (vehicle?.handoverKm) {
      selectedVehicle.currentKm = Number(vehicle.handoverKm);
    }

    await selectedVehicle.save();
    await Booking.findByIdAndUpdate(bookingId, {
      handover: handover._id,
      status: "vehicle_handover",
    });
    // ==========================
    // SEND WHATSAPP BOOKING MESSAGE
    // ==========================
    try {
      const result = await sendBookingConfirmation({
        customer: handover.customer,
        vehicle: handover.vehicle,
        trip: handover.trip,
        payment: handover.payment,
      });

      console.log("WATI RESPONSE:", result);
    } catch (whatsappError) {
      console.error(
        "WhatsApp Error:",
        whatsappError?.response?.data || whatsappError?.message,
      );

      // Booking should still be created
    }

    // ==========================
    // SUCCESS RESPONSE
    // ==========================
    return res.status(201).json({
      success: true,
      message: "Handover created successfully",
      data: handover,
    });
  } catch (error) {
    console.error("Create Handover Error:", error);

    next(error);
  }
};

export const uploadHandoverImages = async (req, res, next) => {
  try {
    console.log("FILES RECEIVED:", req.files);

    const { handoverId } = req.params;

    if (!handoverId) {
      return res.status(400).json({
        success: false,
        message: "Handover ID is required",
      });
    }

    const handover = await Handover.findById(handoverId);

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    // Ensure images object exists
    if (!handover.images) {
      handover.images = {};
    }

    // Customer Images
    if (req.files?.customerPhoto?.[0]) {
      handover.images.customerPhoto = req.files.customerPhoto[0].path;
    }
    if (req.files?.customerProfileImage?.[0]) {
      handover.images.customerProfileImage =
        req.files.customerProfileImage[0].path;
    }

    if (req.files?.customerWithVehicle?.[0]) {
      handover.images.customerWithVehicle =
        req.files.customerWithVehicle[0].path;
    }

    // ID Card Images
    if (req.files?.idCardFront?.[0]) {
      handover.images.idCardFront = req.files.idCardFront[0].path;
    }

    if (req.files?.idCardBack?.[0]) {
      handover.images.idCardBack = req.files.idCardBack[0].path;
    }

    // Vehicle Images
    if (req.files?.vehicleFront?.[0]) {
      handover.images.vehicleFront = req.files.vehicleFront[0].path;
    }

    if (req.files?.vehicleRear?.[0]) {
      handover.images.vehicleRear = req.files.vehicleRear[0].path;
    }

    if (req.files?.vehicleLeft?.[0]) {
      handover.images.vehicleLeft = req.files.vehicleLeft[0].path;
    }

    if (req.files?.vehicleRight?.[0]) {
      handover.images.vehicleRight = req.files.vehicleRight[0].path;
    }

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Handover images uploaded successfully",
      data: handover,
    });
  } catch (error) {
    console.error("UPLOAD ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to upload handover images",
    });
  }
};
//new
export const uploadSingleImage = async (req, res) => {
  console.log(req.file);
  console.log(req.body);
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image is required",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Image uploaded successfully",
      data: {
        url: req.file.path,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Image upload failed",
    });
  }
};
// version 1.0
export const saveHandoverImage = async (req, res) => {
  try {
    const { handoverId } = req.params;

    if (!handoverId) {
      return res.status(400).json({
        success: false,
        message: "Handover ID is required",
      });
    }

    const {
      customerPhoto,
      customerProfileImage,
      customerWithVehicle,
      idCardFront,
      idCardBack,
      vehicleFront,
      vehicleRear,
      vehicleLeft,
      vehicleRight,
    } = req.body;

    const update = {};

    if (customerPhoto) update["images.customerPhoto"] = customerPhoto;
    if (customerProfileImage)
      update["images.customerProfileImage"] = customerProfileImage;
    if (customerWithVehicle)
      update["images.customerWithVehicle"] = customerWithVehicle;
    if (idCardFront) update["images.idCardFront"] = idCardFront;
    if (idCardBack) update["images.idCardBack"] = idCardBack;
    if (vehicleFront) update["images.vehicleFront"] = vehicleFront;
    if (vehicleRear) update["images.vehicleRear"] = vehicleRear;
    if (vehicleLeft) update["images.vehicleLeft"] = vehicleLeft;
    if (vehicleRight) update["images.vehicleRight"] = vehicleRight;

    const handover = await Handover.findByIdAndUpdate(
      handoverId,
      {
        $set: update,
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    const images = handover.images || {};

    const allImagesUploaded = [
      images.customerPhoto,
      images.customerProfileImage,
      images.customerWithVehicle,
      images.idCardFront,
      images.idCardBack,
      images.vehicleFront,
      images.vehicleRear,
      images.vehicleLeft,
      images.vehicleRight,
    ].every((img) => typeof img === "string" && img.trim() !== "");

    handover.hasUploadedImages = allImagesUploaded;

    if (!allImagesUploaded) {
      handover.bookingStatus = "draft";
    }

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Images saved successfully",
      data: {
        _id: handover._id,
        bookingStatus: handover.bookingStatus,
        hasUploadedImages: handover.hasUploadedImages,
        images: handover.images,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to save images",
    });
  }
};
// version 1.1
export const saveHandoverImages = async (req, res) => {
  try {
    const { handoverId } = req.params;

    if (!handoverId) {
      return res.status(400).json({
        success: false,
        message: "Handover ID is required",
      });
    }

    // These MUST be present for the handover to be considered complete
    const REQUIRED_IMAGES = [
      "customerPhoto",
      "customerProfileImage",
      "customerWithVehicle",
      "idCardFront",
      "idCardBack",
      "vehicleFront",
      "vehicleRear",
      "vehicleLeft",
      "vehicleRight",
    ];

    // Saved if provided, but don't affect completion/progress calculation
    const OPTIONAL_IMAGES = [
      "drivingLicenseFront",
      "drivingLicenseBack",
      "toolkit",
      "spareTyre",
      "odometer",
      "fuelGauge",
      "interior",
      "roofTop",
    ];

    const update = {};

    REQUIRED_IMAGES.forEach((key) => {
      const value = req.body[key];
      if (typeof value === "string" && value.trim() !== "") {
        update[`images.${key}`] = value.trim();
      }
    });

    OPTIONAL_IMAGES.forEach((key) => {
      const value = req.body[key];
      if (typeof value === "string" && value.trim() !== "") {
        update[`images.${key}`] = value.trim();
      }
    });

    // Optional close-up damage photos (array of Cloudinary URLs)
    let damageImages = req.body.damageImages;

    if (typeof damageImages === "string") {
      try {
        damageImages = JSON.parse(damageImages);
      } catch {
        damageImages = damageImages ? [damageImages] : [];
      }
    }

    if (Array.isArray(damageImages)) {
      update["images.damageImages"] = damageImages
        .filter((url) => typeof url === "string" && url.trim() !== "")
        .map((url) => url.trim());
    }

    const handover = await Handover.findByIdAndUpdate(
      handoverId,
      {
        $set: update,
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    const images = handover.images || {};

    const uploadedCount = REQUIRED_IMAGES.filter((key) => {
      const value = images[key];
      return typeof value === "string" && value.trim() !== "";
    }).length;

    const totalRequired = REQUIRED_IMAGES.length;

    const allImagesUploaded = uploadedCount === totalRequired;

    const progress = Math.round((uploadedCount / totalRequired) * 100);

    handover.hasUploadedImages = allImagesUploaded;

    // Keep booking as draft until every required image is uploaded
    if (allImagesUploaded) {
      handover.bookingStatus = "confirmed";
    } else {
      handover.bookingStatus = "draft";
    }

    await handover.save();

    return res.status(200).json({
      success: true,
      message: allImagesUploaded
        ? "All images uploaded successfully."
        : "Images saved successfully. Draft updated.",

      data: {
        _id: handover._id,

        bookingStatus: handover.bookingStatus,

        hasUploadedImages: handover.hasUploadedImages,

        uploadedCount,

        totalRequired,

        progress,

        remainingImages: REQUIRED_IMAGES.filter((key) => {
          const value = images[key];

          return !(typeof value === "string" && value.trim() !== "");
        }),

        images: handover.images,
      },
    });
  } catch (error) {
    console.error("Save Handover Images Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save images",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
//immediate save image
export const saveSingleHandoverImage = async (req, res) => {
  try {
    const { handoverId } = req.params;
    const { key, url } = req.body;

    if (!handoverId) {
      return res.status(400).json({
        success: false,
        message: "Handover ID is required",
      });
    }

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Image key is required",
      });
    }

    if (!url || typeof url !== "string" || url.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Image URL is required",
      });
    }

    const ALLOWED_IMAGES = [
      "customerPhoto",
      "customerProfileImage",
      "customerWithVehicle",
      "idCardFront",
      "idCardBack",
      "vehicleFront",
      "vehicleRear",
      "vehicleLeft",
      "vehicleRight",

      // Optional
      "drivingLicenseFront",
      "drivingLicenseBack",
      "toolkit",
      "spareTyre",
      "odometer",
      "fuelGauge",
      "interior",
      "roofTop",
    ];

    if (!ALLOWED_IMAGES.includes(key)) {
      return res.status(400).json({
        success: false,
        message: `Invalid image key: ${key}`,
      });
    }

    const REQUIRED_IMAGES = [
      "customerPhoto",
      "customerProfileImage",
      "customerWithVehicle",
      "idCardFront",
      "idCardBack",
      "vehicleFront",
      "vehicleRear",
      "vehicleLeft",
      "vehicleRight",
    ];

    const handover = await Handover.findById(handoverId);

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    // Immediately save this single image
    handover.images = handover.images || {};
    handover.images[key] = url.trim();

    // Recalculate required image progress
    const uploadedCount = REQUIRED_IMAGES.filter((imageKey) => {
      const value = handover.images[imageKey];

      return typeof value === "string" && value.trim() !== "";
    }).length;

    const totalRequired = REQUIRED_IMAGES.length;

    const allImagesUploaded = uploadedCount === totalRequired;

    const progress = Math.round((uploadedCount / totalRequired) * 100);

    // Keep your existing flow
    handover.hasUploadedImages = allImagesUploaded;

    if (allImagesUploaded) {
      handover.bookingStatus = "confirmed";
    } else {
      handover.bookingStatus = "draft";
    }

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Image saved successfully",
      data: {
        _id: handover._id,
        key,
        url: handover.images[key],
        bookingStatus: handover.bookingStatus,
        hasUploadedImages: handover.hasUploadedImages,
        uploadedCount,
        totalRequired,
        progress,
        remainingImages: REQUIRED_IMAGES.filter((imageKey) => {
          const value = handover.images[imageKey];

          return !(typeof value === "string" && value.trim() !== "");
        }),
      },
    });
  } catch (error) {
    console.error("Save Single Handover Image Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save image",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const getHandoverImages = async (req, res) => {
  try {
    const { handoverId } = req.params;

    if (!handoverId) {
      return res.status(400).json({
        success: false,
        message: "Handover ID is required",
      });
    }

    const handover = await Handover.findById(handoverId).select(
      "images bookingStatus hasUploadedImages",
    );

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Handover images fetched successfully",
      data: {
        images: handover.images || {},
        bookingStatus: handover.bookingStatus,
        hasUploadedImages: handover.hasUploadedImages,
      },
    });
  } catch (error) {
    console.error("Get Handover Images Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch handover images",
    });
  }
};
// active rental screen new
export const getActiveHandover = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      MAX_PAGE_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || PAGE_SIZE_DEFAULT),
    );
    const skip = (page - 1) * limit;

    const tab = ["today", "yesterday", "all"].includes(req.query.tab)
      ? req.query.tab
      : "all";

    const search = String(req.query.search || "").trim();

    // Custom date range (from the filter modal) always wins over the
    // today/yesterday/all tab logic when present.
    const rangeFrom = parseDateParam(req.query.from);
    const rangeTo = parseDateParam(req.query.to);

    const match = {
      handoverStatus: "active",
      isDeleted: false,
    };

    if (rangeFrom || rangeTo) {
      match["trip.pickupDateTime"] = {};
      if (rangeFrom) match["trip.pickupDateTime"].$gte = rangeFrom;
      if (rangeTo) match["trip.pickupDateTime"].$lte = rangeTo;
    } else if (tab === "today") {
      const now = new Date();
      match["trip.pickupDateTime"] = {
        $gte: startOfDay(now),
        $lte: endOfDay(now),
      };
    } else if (tab === "yesterday") {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      match["trip.pickupDateTime"] = {
        $gte: startOfDay(y),
        $lte: endOfDay(y),
      };
    }
    // tab === "all" with no custom range -> no date filter

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [
        { "customer.fullName": regex },
        { "customer.mobileNumber": regex },
        { "vehicle.vehicleName": regex },
        { "vehicle.vehicleNumber": regex },
      ];
    }

    // Only the fields the list screen actually renders. No populate —
    // formatRentalItem on the client never reads the populated
    // vehicle.vehicleId or createdBy fields, so joining them was pure
    // wasted query cost.
    const projection = {
      "customer.fullName": 1,
      "customer.mobileNumber": 1,
      "vehicle.vehicleName": 1,
      "vehicle.vehicleNumber": 1,
      "trip.pickupDateTime": 1,
      "trip.dropDateTime": 1,
      "payment.billSummary.balanceAmount": 1,
      "payment.balanceAmount": 1,
      "images.vehicleFront": 1,
      createdAt: 1,
    };

    const [data, total] = await Promise.all([
      Handover.find(match, projection)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Handover.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      data,
      page,
      limit,
      total,
      hasMore: skip + data.length < total,
      tab,
    });
  } catch (error) {
    console.log("ACTIVE HANDOVER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch active handovers",
    });
  }
};
//old
export const getActiveHandovers = async (req, res) => {
  try {
    const activeHandovers = await Handover.find({
      handoverStatus: "active",
      isDeleted: false,
    })
      // Only pull the fields the app actually renders instead of full
      // vehicle/user documents — smaller payload, faster to serialize.
      .populate("vehicle.vehicleId", "vehicleName vehicleNumber")
      .populate("createdBy", "fullName")
      // .lean() skips hydrating full Mongoose documents (getters, virtuals,
      // change tracking) since this is a read-only list response — this
      // alone is typically the single biggest speedup for a GET-list route.
      .select(
        "customer vehicle trip payment images handoverStatus isDeleted createdAt",
      )
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: activeHandovers.length,
      data: activeHandovers,
    });
  } catch (error) {
    console.log("ACTIVE HANDOVER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch active handovers",
    });
  }
};

export const getSingleHandover = async (req, res) => {
  try {
    const { id } = req.params;

    const handover = await Handover.findOne({
      _id: id,
      isDeleted: false,
    })
      .populate("createdBy", "fullName email mobileNumber role")
      .populate("vehicle.vehicleId")
      .populate("returnDetails.returnedBy", "fullName email mobileNumber role")
      // NEW: populate the creator of each extension bill so the frontend
      // can show "extended by <name>" without a second lookup.
      .populate("extensionBills.createdBy", "fullName email mobileNumber role");

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    const vehicleReturn = await VehicleReturn.findOne({
      handover: handover._id,
    }).populate("receivedBy", "fullName email mobileNumber role");

    const data = handover.toObject();

    // FIX: build the bill the frontend renders straight from the stored
    // payment.billSummary — the single already-computed, already-saved
    // breakdown — instead of the frontend re-deriving a "Financial Ledger"
    // from loose top-level payment fields. Falls back to the flat payment
    // fields only for older documents saved before billSummary existed, so
    // nothing on old handovers breaks.
    const rawPayment = data.payment || {};
    const bill = rawPayment.billSummary || {};

    data.payment = {
      ...rawPayment,
      billSummary: {
        totalFare: bill.totalFare ?? rawPayment.totalFare ?? 0,
        fastTagPayable:
          bill.fastTagPayable ?? rawPayment.fastTagPayableAmount ?? 0,
        pickupCharge: bill.pickupCharge ?? 0,
        dropCharge: bill.dropCharge ?? 0,
        securityDeposit:
          bill.securityDeposit ?? rawPayment.securityDeposit ?? 0,
        extraCharges: bill.extraCharges ?? rawPayment.extraCharges ?? 0,
        discountAmount: bill.discountAmount ?? rawPayment.discountAmount ?? 0,
        totalAmount: bill.totalAmount ?? rawPayment.totalAmount ?? 0,
        bookingAmountPaid:
          bill.bookingAmountPaid ?? rawPayment.bookingAmountPaid ?? 0,
        amountReceivedNow:
          bill.amountReceivedNow ?? rawPayment.amountReceivedNow ?? 0,
        totalCollected:
          bill.totalCollected ??
          (rawPayment.bookingAmountPaid || 0) +
            (rawPayment.amountReceivedNow || 0),
        balanceAmount: bill.balanceAmount ?? rawPayment.balanceAmount ?? 0,
      },
    };

    // NEW: shape extensionBills for the client — newest first, with the
    // populated creator trimmed down to just what the UI needs, and a
    // rollup summary so the screen doesn't have to reduce() on its own.
    const extensionBills = (handover.extensionBills || [])
      .map((extBill) => ({
        _id: extBill._id,
        billNumber: extBill.billNumber,
        previousDropDateTime: extBill.previousDropDateTime,
        newDropDateTime: extBill.newDropDateTime,
        previousNumberOfDays: extBill.previousNumberOfDays,
        newNumberOfDays: extBill.newNumberOfDays,
        extraDays: extBill.extraDays,
        extensionAmount: extBill.extensionAmount || 0,
        amountCollected: extBill.amountCollected || 0,
        totalFareAfterThisBill: extBill.totalFareAfterThisBill || 0,
        reason: extBill.reason || "",
        createdBy: extBill.createdBy
          ? {
              _id: extBill.createdBy._id,
              fullName: extBill.createdBy.fullName,
              role: extBill.createdBy.role,
            }
          : null,
        createdAt: extBill.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    data.extensionBills = extensionBills;

    data.extensionSummary = {
      totalExtensions: extensionBills.length,
      totalExtensionAmount: extensionBills.reduce(
        (sum, b) => sum + (b.extensionAmount || 0),
        0,
      ),
      totalAmountCollected: extensionBills.reduce(
        (sum, b) => sum + (b.amountCollected || 0),
        0,
      ),
      totalExtraDays: extensionBills.reduce(
        (sum, b) => sum + (b.extraDays || 0),
        0,
      ),
    };

    data.gallery = {
      handover: [
        {
          label: "Customer Photo",
          image: handover.images?.customerPhoto || "",
        },
        {
          label: "Customer Profile",
          image: handover.images?.customerProfileImage || "",
        },
        {
          label: "Customer With Vehicle",
          image: handover.images?.customerWithVehicle || "",
        },
        {
          label: "ID Card Front",
          image: handover.images?.idCardFront || "",
        },
        {
          label: "ID Card Back",
          image: handover.images?.idCardBack || "",
        },
        {
          label: "Vehicle Front",
          image: handover.images?.vehicleFront || "",
        },
        {
          label: "Vehicle Rear",
          image: handover.images?.vehicleRear || "",
        },
        {
          label: "Vehicle Left",
          image: handover.images?.vehicleLeft || "",
        },
        {
          label: "Vehicle Right",
          image: handover.images?.vehicleRight || "",
        },
      ].filter((item) => item.image),
    };

    if (vehicleReturn) {
      data.vehicleReturn = {
        _id: vehicleReturn._id,

        receivedBy: vehicleReturn.receivedBy
          ? {
              _id: vehicleReturn.receivedBy._id,
              fullName: vehicleReturn.receivedBy.fullName,
              role: vehicleReturn.receivedBy.role,
              email: vehicleReturn.receivedBy.email,
              mobileNumber: vehicleReturn.receivedBy.mobileNumber,
            }
          : null,

        receivingTime: vehicleReturn.receivingTime,
        scheduledReturnTime: vehicleReturn.scheduledReturnTime,

        timeStatus: vehicleReturn.timeStatus,
        delayInMinutes: vehicleReturn.delayInMinutes || 0,
        delayText: vehicleReturn.delayText || "0 minutes",

        fuelLevel: vehicleReturn.fuelLevel,
        kilometersAtReturn: vehicleReturn.kilometersAtReturn,

        hasDamage: vehicleReturn.hasDamage,
        damageNotes: vehicleReturn.damageNotes,

        inspection: vehicleReturn.inspection || [],

        settlementDetails: vehicleReturn.settlementDetails || {},

        damageCostDetails: vehicleReturn.damageCostDetails || null,

        returnStatus: vehicleReturn.returnStatus || "completed",

        images: {
          vehicleFront: vehicleReturn.images?.vehicleFront || "",
          vehicleRear: vehicleReturn.images?.vehicleRear || "",
          vehicleLeft: vehicleReturn.images?.vehicleLeft || "",
          vehicleRight: vehicleReturn.images?.vehicleRight || "",
        },

        damageImages: vehicleReturn.damageImages || [],

        createdAt: vehicleReturn.createdAt,
      };

      data.gallery.returnImages = [
        {
          label: "Return Front",
          image: vehicleReturn.images?.vehicleFront || "",
        },
        {
          label: "Return Rear",
          image: vehicleReturn.images?.vehicleRear || "",
        },
        {
          label: "Return Left",
          image: vehicleReturn.images?.vehicleLeft || "",
        },
        {
          label: "Return Right",
          image: vehicleReturn.images?.vehicleRight || "",
        },
      ].filter((item) => item.image);

      data.gallery.damageImages = (vehicleReturn.damageImages || []).map(
        (img, index) => ({
          label: `Damage ${index + 1}`,
          image: img,
        }),
      );
    } else {
      data.vehicleReturn = null;
      data.gallery.returnImages = [];
      data.gallery.damageImages = [];
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("GET SINGLE HANDOVER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch handover",
    });
  }
};

export const getReceiveCarList = async (req, res) => {
  try {
    const {
      tab = "today",
      page = 1,
      limit = 7,
      search = "",
      completedDays = 90,
      includeCounts = "true",
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 7, 1), 50);
    const searchTerm = String(search || "")
      .trim()
      .toLowerCase();

    const baseMatch = {
      isDeleted: false,
      "vehicle.vehicleId": { $exists: true },
      handoverStatus: { $ne: "cancelled" },
    };

    // ---- IST day boundaries, computed once per request ----
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: IST_TZ });
    const tomorrowD = new Date(now);
    tomorrowD.setDate(tomorrowD.getDate() + 1);
    const tomorrowStr = tomorrowD.toLocaleDateString("en-CA", {
      timeZone: IST_TZ,
    });

    const today = istDayBoundsUTC(todayStr);
    const tomorrow = istDayBoundsUTC(tomorrowStr);

    const completedSince = new Date();
    completedSince.setDate(completedSince.getDate() - Number(completedDays));

    let dateFilter = {};
    if (tab === "today") {
      dateFilter = {
        "trip.dropDateTime": { $gte: today.startUTC, $lt: today.endUTC },
      };
    } else if (tab === "tomorrow") {
      dateFilter = {
        "trip.dropDateTime": { $gte: tomorrow.startUTC, $lt: tomorrow.endUTC },
      };
    } else if (tab === "overdue") {
      dateFilter = { "trip.dropDateTime": { $lt: today.startUTC } };
    }


    const wantCounts = String(includeCounts) !== "false";
    const countsPromise = wantCounts
      ? Promise.all([
          countNonCompleted(baseMatch, {
            "trip.dropDateTime": { $gte: today.startUTC, $lt: today.endUTC },
          }),
          countNonCompleted(baseMatch, {}),
          countNonCompleted(baseMatch, {
            "trip.dropDateTime": {
              $gte: tomorrow.startUTC,
              $lt: tomorrow.endUTC,
            },
          }),
          countNonCompleted(baseMatch, {
            "trip.dropDateTime": { $lt: today.startUTC },
          }),
          VehicleReturn.countDocuments({
            returnStatus: "completed",
            receivingTime: { $gte: completedSince },
          }),
        ]).then(
          ([todayCount, allCount, tomorrowCount, overdueCount, completedCount]) => ({
            today: todayCount,
            all: allCount,
            tomorrow: tomorrowCount,
            overdue: overdueCount,
            completed: completedCount,
          }),
        )
      : Promise.resolve(null);

    let data = [];
    let total = 0;
    let hasMore = false;

    if (tab === "completed") {
      // Unchanged: this path was already lean — it paginates on the small
      // VehicleReturn collection first and only ever populates the Handover
      // docs for that one page.
      const returnMatch = {
        returnStatus: "completed",
        receivingTime: { $gte: completedSince },
      };

      total = await VehicleReturn.countDocuments(returnMatch);

      const returnsPage = await VehicleReturn.find(returnMatch)
        .select(
          "handover receivedBy receivingTime scheduledReturnTime timeStatus delayText settlementDetails",
        )
        .populate("receivedBy", "fullName role")
        .sort({ receivingTime: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean();

      const completedMap = new Map(
        returnsPage.map((r) => [String(r.handover), r]),
      );
      const ids = returnsPage.map((r) => r.handover);

      const handoverDocs = await Handover.find({
        ...baseMatch,
        _id: { $in: ids },
      })
        .select(
          "vehicle trip customer createdAt bookingId assignedDriver createdBy payment",
        )
        .populate({
          path: "vehicle.vehicleId",
          select: "vehicleName vehicleNumber images",
        })
        .populate("createdBy", "fullName role")
        .populate("assignedDriver", "fullName mobileNumber profileImage role")
        .populate({ path: "bookingId", select: "drop" })
        .lean();

      // Preserve VehicleReturn's receivingTime-desc order, since the Handover
      // $in query above does not guarantee it.
      const order = new Map(ids.map((id, i) => [String(id), i]));
      handoverDocs.sort(
        (a, b) => order.get(String(a._id)) - order.get(String(b._id)),
      );

      hasMore = (pageNum - 1) * limitNum + returnsPage.length < total;
      data = buildResponseRows(handoverDocs, completedMap);
    } else {
      // ==========================================================
      // STAGE 1 — cheap pass over the tab's date window.
      //
      // Previously this fetched EVERY candidate with full population
      // (vehicle images, assignedDriver, createdBy, bookingId) and only
      // used ~7 of them after slicing in JS — the populate cost was being
      // paid for rows that were immediately thrown away. Here we only
      // populate the two refs actually needed to filter/search/sort
      // correctly (vehicle name/number, drop location), and skip images /
      // driver / creator entirely at this stage.
      // ==========================================================
      const candidates = await Handover.find({ ...baseMatch, ...dateFilter })
        .select("vehicle trip customer createdAt bookingId")
        .populate({
          path: "vehicle.vehicleId",
          select: "vehicleName vehicleNumber",
        })
        .populate({ path: "bookingId", select: "drop" })
        .sort({ "trip.dropDateTime": 1 })
        .lean();

      const candidateIds = candidates.map((h) => h._id);
      const returns = candidateIds.length
        ? await VehicleReturn.find({
            handover: { $in: candidateIds },
            returnStatus: "completed",
          })
            .select("handover")
            .lean()
        : [];
      const completedIdSet = new Set(returns.map((r) => String(r.handover)));

      let notCompleted = candidates.filter(
        (h) => !completedIdSet.has(String(h._id)),
      );

      // Search (within this already-small, tab-scoped set)
      if (searchTerm) {
        notCompleted = notCompleted.filter((h) => {
          const vehicleName =
            h.vehicle?.vehicleId?.vehicleName || h.vehicle?.vehicleName || "";
          const vehicleNumber =
            h.vehicle?.vehicleId?.vehicleNumber ||
            h.vehicle?.vehicleNumber ||
            "";
          const customerName = h.customer?.fullName || "";
          const bookingTag = String(h._id).slice(-8);
          const dropLocation = h.bookingId?.drop?.location || "";
          return [
            vehicleName,
            vehicleNumber,
            customerName,
            bookingTag,
            dropLocation,
          ]
            .join(" ")
            .toLowerCase()
            .includes(searchTerm);
        });
      }

      total = notCompleted.length;
      const start = (pageNum - 1) * limitNum;
      const pageSlice = notCompleted.slice(start, start + limitNum);
      hasMore = start + pageSlice.length < total;
      const pageIds = pageSlice.map((h) => h._id);

      // ==========================================================
      // STAGE 2 — full populate, but ONLY for the ids on this page.
      // ==========================================================
      let handoverDocs = [];
      if (pageIds.length) {
        handoverDocs = await Handover.find({ _id: { $in: pageIds } })
          .select(
            "vehicle trip customer createdAt bookingId assignedDriver createdBy payment",
          )
          .populate({
            path: "vehicle.vehicleId",
            select: "vehicleName vehicleNumber images",
          })
          .populate("createdBy", "fullName role")
          .populate(
            "assignedDriver",
            "fullName mobileNumber profileImage role",
          )
          .populate({ path: "bookingId", select: "drop" })
          .lean();

        const order = new Map(pageIds.map((id, i) => [String(id), i]));
        handoverDocs.sort(
          (a, b) => order.get(String(a._id)) - order.get(String(b._id)),
        );
      }

      data = buildResponseRows(handoverDocs, new Map());
    }

    const counts = await countsPromise;

    return res.status(200).json({
      success: true,
      tab,
      page: pageNum,
      limit: limitNum,
      total,
      hasMore,
      counts,
      data,
    });
  } catch (error) {
    console.error("GET RECEIVE CAR LIST ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch receive car list",
    });
  }
};

function buildResponseRows(handoverDocs, completedMap) {
  return handoverDocs.map((h) => {
    const returnInfo = completedMap.get(String(h._id));
    return {
      ...h,
      dropLocation: h.bookingId?.drop?.location || "Office",
      dropCharge: h.bookingId?.drop?.charge || 0,
      createdByUser: h.createdBy
        ? { fullName: h.createdBy.fullName, role: h.createdBy.role }
        : null,
      returnStatus: returnInfo ? "completed" : null,
      returnDetails: returnInfo
        ? {
            receivedBy: returnInfo.receivedBy
              ? {
                  fullName: returnInfo.receivedBy.fullName,
                  role: returnInfo.receivedBy.role,
                }
              : null,
            receivingTime: returnInfo.receivingTime || null,
            scheduledReturnTime: returnInfo.scheduledReturnTime || null,
            timeStatus: returnInfo.timeStatus || "On Time",
            delayText: returnInfo.delayText || "0 minutes",
            settlementDetails: returnInfo.settlementDetails || {},
          }
        : null,
    };
  });
}

// ACTIVE RENTAL EDIT APIS
function buildBillSummaryResponse(handover) {
  const payment = handover.payment || {};
  const extensionBills = handover.extensionBills || [];

  const billSummary = payment.billSummary || {};

  // ever made, regardless of how Mongo returns/stores the array.
  const sortedExtensionBills = [...extensionBills].sort(
    (a, b) => (a.billNumber || 0) - (b.billNumber || 0),
  );

  const totalExtensionAmount = sortedExtensionBills.reduce(
    (sum, bill) => sum + (bill.extensionAmount || 0),
    0,
  );

  const baseFare = Math.max(0, (payment.totalFare || 0) - totalExtensionAmount);

  const originalNumberOfDays =
    sortedExtensionBills.length > 0
      ? sortedExtensionBills[0].previousNumberOfDays
      : handover.trip?.numberOfDays;

  const originalDropDateTime =
    sortedExtensionBills.length > 0
      ? sortedExtensionBills[0].previousDropDateTime
      : handover.trip?.dropDateTime;

  // "Previous bill total" = what totalFare was right before the CURRENT
  // in-progress edit — i.e. baseFare + every extension already applied.
  // If this rental has never been extended, there's no "previous bill"
  // distinct from the original booking, so this equals baseFare.
  const previousBillTotal = payment.totalFare || 0;

  return {
    originalBill: {
      pickupDateTime: handover.trip?.pickupDateTime,
      dropDateTime: originalDropDateTime,
      numberOfDays: originalNumberOfDays,
      baseFare,
    },

    // Sorted oldest -> newest so the collapsible history list in the
    // UI always displays extensions in the order they actually happened.
    extensionBills: sortedExtensionBills.map((bill) => ({
      billNumber: bill.billNumber,
      previousDropDateTime: bill.previousDropDateTime,
      newDropDateTime: bill.newDropDateTime,
      previousNumberOfDays: bill.previousNumberOfDays,
      newNumberOfDays: bill.newNumberOfDays,
      extraDays: bill.extraDays,
      extensionAmount: bill.extensionAmount,
      amountCollected: bill.amountCollected,
      totalFareAfterThisBill: bill.totalFareAfterThisBill,
      reason: bill.reason,
      createdAt: bill.createdAt,
    })),

    previousBillTotal,

    // FIX: pickupCharge/dropCharge added — previously absent entirely
    // from this object, so the frontend always read them as undefined.
    charges: {
      baseFare,
      totalExtensionAmount,
      totalFare: billSummary.totalFare ?? payment.totalFare ?? 0,
      fastTagPayableAmount:
        billSummary.fastTagPayable ?? payment.fastTagPayableAmount ?? 0,
      pickupCharge: billSummary.pickupCharge || 0,
      dropCharge: billSummary.dropCharge || 0,
      securityDeposit:
        billSummary.securityDeposit ?? payment.securityDeposit ?? 0,
      extraCharges: billSummary.extraCharges ?? payment.extraCharges ?? 0,
      discountAmount: billSummary.discountAmount ?? payment.discountAmount ?? 0,
    },

    // FIX: flat fields matching payment.billSummary's own field names
    // exactly, so this is what the frontend actually reads
    // (billSummary.pickupCharge, billSummary.totalAmount,
    // billSummary.balanceAmount, etc.) instead of the old
    // grandTotal/balanceDue names it never looked for.
    pickupCharge: billSummary.pickupCharge || 0,
    dropCharge: billSummary.dropCharge || 0,
    totalAmount: billSummary.totalAmount ?? payment.totalAmount ?? 0,
    totalCollected:
      billSummary.totalCollected ??
      (payment.bookingAmountPaid || 0) + (payment.amountReceivedNow || 0),
    balanceAmount: billSummary.balanceAmount ?? payment.balanceAmount ?? 0,
    paymentStatus: payment.paymentStatus || "pending",

    // Kept for backwards compatibility if anything else still reads
    // these older names — same values as totalAmount/balanceAmount.
    grandTotal: billSummary.totalAmount ?? payment.totalAmount ?? 0,
    balanceDue: billSummary.balanceAmount ?? payment.balanceAmount ?? 0,
  };
}

export const getRentalDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const handover = await Handover.findById(id);

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    const billSummary = buildBillSummaryResponse(handover);

    return res.status(200).json({
      success: true,
      data: {
        _id: handover._id,

        customerName: handover.customer?.fullName || "",
        customerPhone: handover.customer?.mobileNumber || "",

        vehicleId: handover.vehicle?.vehicleId,
        vehicleModel: handover.vehicle?.vehicleName || "",
        plateNumber: handover.vehicle?.vehicleNumber || "",
        vehicleColor: handover.vehicle?.vehicleColor || "",

        pickupDateTime: handover.trip?.pickupDateTime,
        dropDateTime: handover.trip?.dropDateTime,
        numberOfDays: handover.trip?.numberOfDays,

        // Derived, not stored — see buildBillSummaryResponse
        baseFare: billSummary.charges.baseFare,
        totalFare: handover.payment?.totalFare || 0,
        fastagCharges: handover.payment?.fastTagPayableAmount || 0,
        securityDeposit: handover.payment?.securityDeposit || 0,
        extraCharges: handover.payment?.extraCharges || 0,
        discountAmount: handover.payment?.discountAmount || 0,
        bookingAmountPaid: handover.payment?.bookingAmountPaid || 0,
        amountReceivedPreviously: handover.payment?.amountReceivedNow || 0,
        totalAmount: handover.payment?.totalAmount || 0,
        balanceAmount: handover.payment?.balanceAmount || 0,
        paymentMethod: handover.payment?.paymentMethod || "",
        paymentStatus: handover.payment?.paymentStatus || "pending",

        // FIX: flat fallback fields, matching what EditRentalScreen.js
        // reads via `data.billSummary?.pickupCharge ?? data.pickupCharge`.
        // Kept in sync with billSummary.pickupCharge/dropCharge so this
        // fallback path is never silently stale if billSummary's shape
        // changes later.
        pickupCharge: billSummary.pickupCharge,
        dropCharge: billSummary.dropCharge,

        billSummary,
      },
    });
  } catch (error) {
    console.error("GET RENTAL DETAILS ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch rental details",
    });
  }
};

export const getBillSummary = async (req, res) => {
  try {
    const { id } = req.params;

    const handover = await Handover.findById(id);

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: buildBillSummaryResponse(handover),
    });
  } catch (error) {
    console.error("GET BILL SUMMARY ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch bill summary",
    });
  }
};

const formatDropTime = (date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);

  const hour12 = hour % 12 || 12;
  const period = hour >= 12 ? "PM" : "AM";

  return `${String(hour12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${period}`;
};
//v1.0
export const updateRentals = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      vehicleId,
      dropDateTime,
      extensionPrice,
      fastagCharges,
      securityDeposit,
      extraCharges,
      discountAmount,
      amountReceivedNow,
      paymentMethod,
      reasonForChange,
      upiLast4,
    } = req.body;

    // ==========================================================
    // VALIDATE UPI LAST 4 DIGITS (only relevant for phonepe)
    // Reject early rather than letting a malformed value fail
    // silently at handover.save() / PaymentHistory.create().
    // ==========================================================

    let sanitizedUpiLast4 = [];

    if (paymentMethod === "phonepe" && Number(amountReceivedNow) > 0) {
      let references = upiLast4;

      // Support old frontend: "1234"
      if (typeof references === "string") {
        try {
          // Support new frontend: '["1234","5678"]'
          references = JSON.parse(references);
        } catch {
          // Old frontend single value
          references = [references];
        }
      }

      // Safety
      if (!Array.isArray(references)) {
        references = [references];
      }

      sanitizedUpiLast4 = references
        .map((value) => String(value || "").trim())
        .filter(Boolean);

      // Validate every reference
      const invalidReference = sanitizedUpiLast4.some(
        (value) => !/^\d{4}$/.test(value),
      );

      if (sanitizedUpiLast4.length === 0 || invalidReference) {
        return res.status(400).json({
          success: false,
          message: "Please provide valid 4-digit PhonePe reference numbers",
        });
      }
    }

    // ==========================================================
    // FIND ACTIVE RENTAL
    // ==========================================================

    const handover = await Handover.findOne({
      _id: id,
      isDeleted: false,
      handoverStatus: "active",
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Active rental not found",
      });
    }

    // ==========================================================
    // CHANGE VEHICLE
    // ==========================================================

    if (
      vehicleId &&
      handover.vehicle?.vehicleId &&
      vehicleId.toString() !== handover.vehicle.vehicleId.toString()
    ) {
      const oldVehicleId = handover.vehicle.vehicleId;

      const oldVehicleName = handover.vehicle.vehicleName;

      const oldVehicleNumber = handover.vehicle.vehicleNumber;

      const vehicle = await Vehicle.findById(vehicleId);

      if (!vehicle || vehicle.isDeleted) {
        return res.status(404).json({
          success: false,
          message: "Vehicle not found",
        });
      }

      if (!["available", "rent"].includes(vehicle.status)) {
        return res.status(400).json({
          success: false,
          message: "Vehicle is not available",
        });
      }

      // Old vehicle becomes available
      await Vehicle.findByIdAndUpdate(oldVehicleId, {
        status: "available",
      });

      // New vehicle becomes rented
      await Vehicle.findByIdAndUpdate(vehicle._id, {
        status: "rent",
      });

      // Vehicle change history
      handover.vehicleHistory.push({
        oldVehicle: {
          vehicleId: oldVehicleId,
          vehicleName: oldVehicleName,
          vehicleNumber: oldVehicleNumber,
        },

        newVehicle: {
          vehicleId: vehicle._id,
          vehicleName: vehicle.vehicleName,
          vehicleNumber: vehicle.vehicleNumber,
        },

        changedBy: req.user._id,
        changedAt: new Date(),
        reason: reasonForChange || "",
      });

      // Update current vehicle
      handover.vehicle.vehicleId = vehicle._id;

      handover.vehicle.vehicleName = vehicle.vehicleName;

      handover.vehicle.vehicleNumber = vehicle.vehicleNumber;

      handover.vehicle.vehicleColor = vehicle.color || "";
    }

    // ==========================================================
    // UPDATE DROP DATE / TIME
    //
    // This updates:
    // 1. Handover dropDateTime
    // 2. Handover numberOfDays
    // 3. Extension bill history
    // 4. Cumulative totalFare
    // ==========================================================

    if (dropDateTime !== undefined) {
      const previousDropDateTime = new Date(handover.trip.dropDateTime);

      const previousNumberOfDays = Number(handover.trip.numberOfDays) || 1;

      const newDrop = new Date(dropDateTime);

      // Validate new date
      if (Number.isNaN(newDrop.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid drop date/time",
        });
      }

      const dropChanged = previousDropDateTime.getTime() !== newDrop.getTime();

      if (dropChanged) {
        const pickup = new Date(handover.trip.pickupDateTime);

        // Validate pickup date
        if (Number.isNaN(pickup.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid pickup date/time",
          });
        }

        // Prevent drop before pickup
        if (newDrop.getTime() < pickup.getTime()) {
          return res.status(400).json({
            success: false,
            message: "Drop date/time cannot be before pickup date/time",
          });
        }

        // Calculate new rental days
        const newNumberOfDays = Math.max(
          1,
          Math.ceil(
            (newDrop.getTime() - pickup.getTime()) / (1000 * 60 * 60 * 24),
          ),
        );

        const extraDays = newNumberOfDays - previousNumberOfDays;

        const extensionAmount = Number(extensionPrice) || 0;

        // ------------------------------------------------------
        // UPDATE HANDOVER TRIP
        // ------------------------------------------------------

        handover.trip.dropDateTime = newDrop;

        handover.trip.numberOfDays = newNumberOfDays;

        // ------------------------------------------------------
        // UPDATE CUMULATIVE TOTAL FARE
        // ------------------------------------------------------

        handover.payment.totalFare =
          (Number(handover.payment.totalFare) || 0) + extensionAmount;

        // ------------------------------------------------------
        // CREATE EXTENSION BILL HISTORY
        // ------------------------------------------------------

        handover.extensionBills.push({
          billNumber: handover.extensionBills.length + 1,

          previousDropDateTime,

          newDropDateTime: newDrop,

          previousNumberOfDays,

          newNumberOfDays,

          extraDays,

          extensionAmount,

          amountCollected: Number(amountReceivedNow) || 0,

          totalFareAfterThisBill: handover.payment.totalFare,

          reason: reasonForChange || "",

          createdBy: req.user._id,

          createdAt: new Date(),
        });
      }
    }

    // ==========================================================
    // UPDATE OTHER PAYMENT FIELDS
    // ==========================================================

    if (fastagCharges !== undefined) {
      handover.payment.fastTagPayableAmount = Number(fastagCharges) || 0;
    }

    if (securityDeposit !== undefined) {
      handover.payment.securityDeposit = Number(securityDeposit) || 0;
    }

    if (extraCharges !== undefined) {
      handover.payment.extraCharges = Number(extraCharges) || 0;
    }

    if (discountAmount !== undefined) {
      handover.payment.discountAmount = Number(discountAmount) || 0;
    }

    if (paymentMethod) {
      handover.payment.paymentMethod = paymentMethod;
    }

    // ==========================================================
    // GET PICKUP / DROP CHARGES
    // ==========================================================

    const pickupCharge =
      Number(handover.payment.billSummary?.pickupCharge) || 0;

    const dropCharge = Number(handover.payment.billSummary?.dropCharge) || 0;

    // ==========================================================
    // CALCULATE TOTAL AMOUNT
    // ==========================================================

    handover.payment.totalAmount = Math.max(
      0,
      (Number(handover.payment.totalFare) || 0) +
        (Number(handover.payment.fastTagPayableAmount) || 0) +
        pickupCharge +
        dropCharge +
        (Number(handover.payment.securityDeposit) || 0) +
        (Number(handover.payment.extraCharges) || 0) -
        (Number(handover.payment.discountAmount) || 0),
    );

    // ==========================================================
    // PAYMENT RECEIVED NOW
    // ==========================================================

    if (amountReceivedNow !== undefined) {
      const received = Number(amountReceivedNow) || 0;

      handover.payment.amountReceivedNow =
        (Number(handover.payment.amountReceivedNow) || 0) + received;

      if (paymentMethod === "cash") {
        handover.payment.paymentBreakdown.cash =
          (Number(handover.payment.paymentBreakdown.cash) || 0) + received;
      } else if (paymentMethod === "phonepe") {
        handover.payment.paymentBreakdown.phonePe =
          (Number(handover.payment.paymentBreakdown.phonePe) || 0) + received;

        // Keep the last-used UPI reference on the handover itself too,
        // so it's visible without having to look up PaymentHistory.
        handover.payment.upiLast4 = sanitizedUpiLast4;
      } else if (paymentMethod === "razorpay") {
        handover.payment.paymentBreakdown.razorpay =
          (Number(handover.payment.paymentBreakdown.razorpay) || 0) + received;
      }
    }

    // ==========================================================
    // CALCULATE TOTAL PAID
    // ==========================================================

    const totalPaidSoFar =
      (Number(handover.payment.bookingAmountPaid) || 0) +
      (Number(handover.payment.amountReceivedNow) || 0);

    // ==========================================================
    // UPDATE BILL SUMMARY
    // ==========================================================

    handover.payment.billSummary = {
      totalFare: Number(handover.payment.totalFare) || 0,

      fastTagPayable: Number(handover.payment.fastTagPayableAmount) || 0,

      pickupCharge,

      dropCharge,

      securityDeposit: Number(handover.payment.securityDeposit) || 0,

      extraCharges: Number(handover.payment.extraCharges) || 0,

      discountAmount: Number(handover.payment.discountAmount) || 0,

      totalAmount: handover.payment.totalAmount,

      bookingAmountPaid: Number(handover.payment.bookingAmountPaid) || 0,

      amountReceivedNow: Number(handover.payment.amountReceivedNow) || 0,

      totalCollected: totalPaidSoFar,

      balanceAmount: Math.max(0, handover.payment.totalAmount - totalPaidSoFar),
    };

    // ==========================================================
    // UPDATE NOTES
    // ==========================================================

    if (reasonForChange?.trim()) {
      const updateNote = `
[Rental Updated - ${new Date().toLocaleString()}]
Reason: ${reasonForChange}
`;

      handover.notes = `${handover.notes || ""}
${updateNote}`
        .trim()
        .slice(-500);
    }

    if (handover.bookingId) {
      const booking = await Booking.findById(handover.bookingId);

      if (booking) {
        // ------------------------------------------------------
        // DROP DATE + TIME
        // ------------------------------------------------------

        const updatedDropDateTime = new Date(handover.trip.dropDateTime);

        if (Number.isNaN(updatedDropDateTime.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid drop date/time for booking",
          });
        }

        // Booking.toDate
        booking.toDate = updatedDropDateTime;

        // Booking.dropTime
        booking.dropTime = formatDropTime(updatedDropDateTime);

        // Booking.totalDays
        booking.totalDays = Math.max(
          1,
          Number(handover.trip.numberOfDays) || 1,
        );

        // ------------------------------------------------------
        // SYNC VEHICLE
        // ------------------------------------------------------

        if (handover.vehicle) {
          booking.vehicleId = handover.vehicle.vehicleId;

          booking.vehicleName =
            handover.vehicle.vehicleName || booking.vehicleName;

          booking.vehicleNumber =
            handover.vehicle.vehicleNumber || booking.vehicleNumber;

          booking.vehicleColor =
            handover.vehicle.vehicleColor || booking.vehicleColor;
        }

        // ------------------------------------------------------
        // SYNC PAYMENT
        // ------------------------------------------------------

        booking.payment.vehicleRent = Number(handover.payment.totalFare) || 0;

        booking.payment.fastagAmount =
          Number(handover.payment.fastTagPayableAmount) || 0;

        booking.payment.discountAmount =
          Number(handover.payment.discountAmount) || 0;

        booking.payment.securityDeposit =
          Number(handover.payment.securityDeposit) || 0;

        // ------------------------------------------------------
        // BOOKING TOTAL
        //
        // Keep the same formula used by Booking.
        // ------------------------------------------------------

        booking.payment.totalAmount = Math.max(
          0,
          (Number(booking.payment.vehicleRent) || 0) +
            (Number(booking.payment.pickupCharge) || 0) +
            (Number(booking.payment.dropCharge) || 0) +
            (Number(booking.payment.fastagAmount) || 0),
        );

        await booking.save();
      }
    }

    // ==========================================================
    // SAVE HANDOVER
    // ==========================================================

    await handover.save();

    if (Number(amountReceivedNow) > 0) {
      try {
        await PaymentHistory.create({
          company: handover.company,

          bookingId: handover.bookingId,

          handoverId: handover._id,

          customer: {
            fullName: handover.customer?.fullName || "",

            mobileNumber: handover.customer?.mobileNumber || "",
          },

          vehicle: {
            vehicleId: handover.vehicle?.vehicleId || null,

            vehicleName: handover.vehicle?.vehicleName || "",

            vehicleNumber: handover.vehicle?.vehicleNumber || "",
          },

          amount: Number(amountReceivedNow),

          paymentMethod: paymentMethod || "phonepe",

          // Only ever store a UPI reference when it actually applies —
          // sanitizedUpiLast4 was validated up front and is "" for
          // any non-phonepe payment, matching the schema's regex
          // (which allows an empty string or exactly 4 digits).
          upiLast4: sanitizedUpiLast4,

          paymentBreakdown: {
            cash: paymentMethod === "cash" ? Number(amountReceivedNow) : 0,

            phonePe:
              paymentMethod === "phonepe" ? Number(amountReceivedNow) : 0,

            razorpay:
              paymentMethod === "razorpay" ? Number(amountReceivedNow) : 0,
          },

          type: "extension",

          note: reasonForChange?.trim()
            ? `Rental payment - ${reasonForChange.trim()}`
            : "Payment received during rental update",

          createdBy: req.user._id,
        });
      } catch (paymentHistoryError) {
        // Payment history failure must not
        // break the rental update.

        console.error(
          "Payment History Creation Error:",
          paymentHistoryError?.message || paymentHistoryError,
        );
      }
    }

    // ==========================================================
    // SUCCESS RESPONSE
    // ==========================================================

    return res.status(200).json({
      success: true,
      message: "Rental updated successfully",

      data: {
        handover,

        billSummary: buildBillSummaryResponse(handover),
      },
    });
  } catch (error) {
    console.error("UPDATE RENTAL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update rental",
    });
  }
};
export const updateRental = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      vehicleId,
      dropDateTime,
      extensionPrice,
      fastagCharges,
      securityDeposit,
      extraCharges,
      discountAmount,
      amountReceivedNow,
      paymentMethod,
      reasonForChange,
      upiLast4,
    } = req.body;

    // ==========================================================
    // HELPER
    // Get Cloudinary URL from uploaded file
    // ==========================================================

    const getUploadedImage = (files, field) => {
      return files?.[field]?.[0]?.path || "";
    };

    // ==========================================================
    // VALIDATE UPI LAST 4 DIGITS
    //
    // FIX: The frontend now supports multiple PhonePe references per
    // payment and sends them as a JSON-stringified array via FormData
    // (e.g. '["1234","5678"]'), since FormData can only carry strings.
    // sanitizedUpiLast4 is now always an ARRAY of 4-digit strings —
    // every place that reads it below (handover.payment.upiLast4,
    // PaymentHistory.upiLast4) must store it as an array too.
    // ==========================================================

    let sanitizedUpiLast4 = [];

    if (paymentMethod === "phonepe" && Number(amountReceivedNow) > 0) {
      let parsedUpiLast4 = upiLast4;

      // Parse the JSON array string back into a real array. Falls back
      // to wrapping the raw value in an array if it isn't valid JSON,
      // so an older client still sending a bare 4-digit string keeps
      // working without a hard break.
      if (typeof parsedUpiLast4 === "string") {
        try {
          parsedUpiLast4 = JSON.parse(parsedUpiLast4);
        } catch {
          parsedUpiLast4 = [parsedUpiLast4];
        }
      }

      if (!Array.isArray(parsedUpiLast4)) {
        parsedUpiLast4 = [parsedUpiLast4];
      }

      sanitizedUpiLast4 = parsedUpiLast4
        .map((value) => String(value || "").trim())
        .filter(Boolean);

      const allValid =
        sanitizedUpiLast4.length > 0 &&
        sanitizedUpiLast4.every((value) => /^\d{4}$/.test(value));

      if (!allValid) {
        return res.status(400).json({
          success: false,
          message: "Please provide valid 4-digit PhonePe reference number(s)",
        });
      }
    }

    // ==========================================================
    // FIND ACTIVE RENTAL
    // ==========================================================

    const handover = await Handover.findOne({
      _id: id,
      isDeleted: false,
      handoverStatus: "active",
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Active rental not found",
      });
    }

    // ==========================================================
    // VEHICLE EXCHANGE
    // ==========================================================

    const isVehicleExchange =
      vehicleId &&
      handover.vehicle?.vehicleId &&
      vehicleId.toString() !== handover.vehicle.vehicleId.toString();

    if (isVehicleExchange) {
      // --------------------------------------------------------
      // OLD VEHICLE DETAILS
      // --------------------------------------------------------

      const oldVehicleId = handover.vehicle.vehicleId;
      const oldVehicleName = handover.vehicle.vehicleName;
      const oldVehicleNumber = handover.vehicle.vehicleNumber;

      // --------------------------------------------------------
      // FIND NEW VEHICLE
      // --------------------------------------------------------

      const vehicle = await Vehicle.findById(vehicleId);

      if (!vehicle || vehicle.isDeleted) {
        return res.status(404).json({
          success: false,
          message: "Vehicle not found",
        });
      }

      // --------------------------------------------------------
      // CHECK VEHICLE STATUS
      // --------------------------------------------------------

      if (!["available", "rent"].includes(vehicle.status)) {
        return res.status(400).json({
          success: false,
          message: "Vehicle is not available",
        });
      }

      // --------------------------------------------------------
      // VALIDATE REQUIRED EXCHANGE PHOTOS
      // --------------------------------------------------------

      const requiredExchangePhotos = [
        "vehicleFront",
        "vehicleRear",
        "vehicleLeft",
        "vehicleRight",
      ];

      const missingPhotos = requiredExchangePhotos.filter(
        (field) => !req.files?.[field]?.length,
      );

      if (missingPhotos.length > 0) {
        return res.status(400).json({
          success: false,
          message: "All four vehicle exchange photos are required",
          missingPhotos,
        });
      }

      // --------------------------------------------------------
      // GET CLOUDINARY URLS
      // --------------------------------------------------------

      const exchangeImages = {
        vehicleFront: getUploadedImage(req.files, "vehicleFront"),

        vehicleRear: getUploadedImage(req.files, "vehicleRear"),

        vehicleLeft: getUploadedImage(req.files, "vehicleLeft"),

        vehicleRight: getUploadedImage(req.files, "vehicleRight"),
        additional: getUploadedImage(req.files, "additional"),
      };

      // --------------------------------------------------------
      // EXTRA SAFETY CHECK
      // --------------------------------------------------------

      const invalidExchangeImages = Object.entries(exchangeImages)
        .filter(([, url]) => !url)
        .map(([field]) => field);

      if (invalidExchangeImages.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Failed to upload vehicle exchange photos",
          invalidImages: invalidExchangeImages,
        });
      }

      // --------------------------------------------------------
      // OLD VEHICLE -> AVAILABLE
      // --------------------------------------------------------

      await Vehicle.findByIdAndUpdate(oldVehicleId, {
        status: "available",
      });

      // --------------------------------------------------------
      // NEW VEHICLE -> RENT
      // --------------------------------------------------------

      await Vehicle.findByIdAndUpdate(vehicle._id, {
        status: "rent",
      });

      // --------------------------------------------------------
      // VEHICLE CHANGE HISTORY
      // --------------------------------------------------------

      handover.vehicleHistory.push({
        oldVehicle: {
          vehicleId: oldVehicleId,
          vehicleName: oldVehicleName,
          vehicleNumber: oldVehicleNumber,
        },

        newVehicle: {
          vehicleId: vehicle._id,
          vehicleName: vehicle.vehicleName,
          vehicleNumber: vehicle.vehicleNumber,
        },

        // IMPORTANT:
        // These photos belong to THIS exchange,
        // not the original handover.
        exchangeImages,

        changedBy: req.user._id,

        changedAt: new Date(),

        reason: reasonForChange || "",
      });

      // --------------------------------------------------------
      // UPDATE CURRENT VEHICLE
      // --------------------------------------------------------

      handover.vehicle.vehicleId = vehicle._id;

      handover.vehicle.vehicleName = vehicle.vehicleName;

      handover.vehicle.vehicleNumber = vehicle.vehicleNumber;

      handover.vehicle.vehicleColor = vehicle.color || "";
    }

    // ==========================================================
    // UPDATE DROP DATE / TIME
    //
    // This updates:
    // 1. Handover dropDateTime
    // 2. Handover numberOfDays
    // 3. Extension bill history
    // 4. Cumulative totalFare
    // ==========================================================

    if (dropDateTime !== undefined) {
      const previousDropDateTime = new Date(handover.trip.dropDateTime);

      const previousNumberOfDays = Number(handover.trip.numberOfDays) || 1;

      const newDrop = new Date(dropDateTime);

      // --------------------------------------------------------
      // VALIDATE NEW DATE
      // --------------------------------------------------------

      if (Number.isNaN(newDrop.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid drop date/time",
        });
      }

      const dropChanged = previousDropDateTime.getTime() !== newDrop.getTime();

      if (dropChanged) {
        const pickup = new Date(handover.trip.pickupDateTime);

        // ------------------------------------------------------
        // VALIDATE PICKUP DATE
        // ------------------------------------------------------

        if (Number.isNaN(pickup.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid pickup date/time",
          });
        }

        // ------------------------------------------------------
        // PREVENT DROP BEFORE PICKUP
        // ------------------------------------------------------

        if (newDrop.getTime() < pickup.getTime()) {
          return res.status(400).json({
            success: false,
            message: "Drop date/time cannot be before pickup date/time",
          });
        }

        // ------------------------------------------------------
        // CALCULATE NEW RENTAL DAYS
        // ------------------------------------------------------

        const newNumberOfDays = Math.max(
          1,
          Math.ceil(
            (newDrop.getTime() - pickup.getTime()) / (1000 * 60 * 60 * 24),
          ),
        );

        const extraDays = newNumberOfDays - previousNumberOfDays;

        const extensionAmount = Number(extensionPrice) || 0;

        // ------------------------------------------------------
        // UPDATE HANDOVER TRIP
        // ------------------------------------------------------

        handover.trip.dropDateTime = newDrop;

        handover.trip.numberOfDays = newNumberOfDays;

        // ------------------------------------------------------
        // UPDATE CUMULATIVE TOTAL FARE
        // ------------------------------------------------------

        handover.payment.totalFare =
          (Number(handover.payment.totalFare) || 0) + extensionAmount;

        // ------------------------------------------------------
        // CREATE EXTENSION BILL HISTORY
        // ------------------------------------------------------

        handover.extensionBills.push({
          billNumber: handover.extensionBills.length + 1,

          previousDropDateTime,

          newDropDateTime: newDrop,

          previousNumberOfDays,

          newNumberOfDays,

          extraDays,

          extensionAmount,

          amountCollected: Number(amountReceivedNow) || 0,

          totalFareAfterThisBill: handover.payment.totalFare,

          reason: reasonForChange || "",

          createdBy: req.user._id,

          createdAt: new Date(),
        });
      }
    }

    // ==========================================================
    // UPDATE OTHER PAYMENT FIELDS
    // ==========================================================

    if (fastagCharges !== undefined) {
      handover.payment.fastTagPayableAmount = Number(fastagCharges) || 0;
    }

    if (securityDeposit !== undefined) {
      handover.payment.securityDeposit = Number(securityDeposit) || 0;
    }

    if (extraCharges !== undefined) {
      handover.payment.extraCharges = Number(extraCharges) || 0;
    }

    if (discountAmount !== undefined) {
      handover.payment.discountAmount = Number(discountAmount) || 0;
    }

    if (paymentMethod) {
      handover.payment.paymentMethod = paymentMethod;
    }

    // ==========================================================
    // GET PICKUP / DROP CHARGES
    // ==========================================================

    const pickupCharge =
      Number(handover.payment.billSummary?.pickupCharge) || 0;

    const dropCharge = Number(handover.payment.billSummary?.dropCharge) || 0;

    // ==========================================================
    // CALCULATE TOTAL AMOUNT
    // ==========================================================

    handover.payment.totalAmount = Math.max(
      0,

      (Number(handover.payment.totalFare) || 0) +
        (Number(handover.payment.fastTagPayableAmount) || 0) +
        pickupCharge +
        dropCharge +
        (Number(handover.payment.securityDeposit) || 0) +
        (Number(handover.payment.extraCharges) || 0) -
        (Number(handover.payment.discountAmount) || 0),
    );

    // ==========================================================
    // PAYMENT RECEIVED NOW
    // ==========================================================

    if (amountReceivedNow !== undefined) {
      const received = Number(amountReceivedNow) || 0;

      handover.payment.amountReceivedNow =
        (Number(handover.payment.amountReceivedNow) || 0) + received;

      if (paymentMethod === "cash") {
        handover.payment.paymentBreakdown.cash =
          (Number(handover.payment.paymentBreakdown.cash) || 0) + received;
      } else if (paymentMethod === "phonepe") {
        handover.payment.paymentBreakdown.phonePe =
          (Number(handover.payment.paymentBreakdown.phonePe) || 0) + received;

        // Keep the latest set of UPI references from this update.
        // FIX: sanitizedUpiLast4 is now an array — handover.payment.upiLast4
        // must be typed [String] in the Handover schema for this to save
        // correctly (see schema note below).
        handover.payment.upiLast4 = sanitizedUpiLast4;
      } else if (paymentMethod === "razorpay") {
        handover.payment.paymentBreakdown.razorpay =
          (Number(handover.payment.paymentBreakdown.razorpay) || 0) + received;
      }
    }

    // ==========================================================
    // CALCULATE TOTAL PAID
    // ==========================================================

    const totalPaidSoFar =
      (Number(handover.payment.bookingAmountPaid) || 0) +
      (Number(handover.payment.amountReceivedNow) || 0);

    // ==========================================================
    // UPDATE BILL SUMMARY
    // ==========================================================

    handover.payment.billSummary = {
      totalFare: Number(handover.payment.totalFare) || 0,

      fastTagPayable: Number(handover.payment.fastTagPayableAmount) || 0,

      pickupCharge,

      dropCharge,

      securityDeposit: Number(handover.payment.securityDeposit) || 0,

      extraCharges: Number(handover.payment.extraCharges) || 0,

      discountAmount: Number(handover.payment.discountAmount) || 0,

      totalAmount: handover.payment.totalAmount,

      bookingAmountPaid: Number(handover.payment.bookingAmountPaid) || 0,

      amountReceivedNow: Number(handover.payment.amountReceivedNow) || 0,

      totalCollected: totalPaidSoFar,

      balanceAmount: Math.max(0, handover.payment.totalAmount - totalPaidSoFar),
    };

    // ==========================================================
    // UPDATE NOTES
    // ==========================================================

    if (reasonForChange?.trim()) {
      const updateNote = `
[Rental Updated - ${new Date().toLocaleString()}]
Reason: ${reasonForChange}
`;

      handover.notes = `${handover.notes || ""}
${updateNote}`
        .trim()
        .slice(-500);
    }

    // ==========================================================
    // SYNC BOOKING
    // ==========================================================

    if (handover.bookingId) {
      const booking = await Booking.findById(handover.bookingId);

      if (booking) {
        // ------------------------------------------------------
        // DROP DATE + TIME
        // ------------------------------------------------------

        const updatedDropDateTime = new Date(handover.trip.dropDateTime);

        if (Number.isNaN(updatedDropDateTime.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid drop date/time for booking",
          });
        }

        // Booking.toDate
        booking.toDate = updatedDropDateTime;

        // Booking.dropTime
        booking.dropTime = formatDropTime(updatedDropDateTime);

        // Booking.totalDays
        booking.totalDays = Math.max(
          1,
          Number(handover.trip.numberOfDays) || 1,
        );

        // ------------------------------------------------------
        // SYNC VEHICLE
        // ------------------------------------------------------

        if (handover.vehicle) {
          booking.vehicleId = handover.vehicle.vehicleId;

          booking.vehicleName =
            handover.vehicle.vehicleName || booking.vehicleName;

          booking.vehicleNumber =
            handover.vehicle.vehicleNumber || booking.vehicleNumber;

          booking.vehicleColor =
            handover.vehicle.vehicleColor || booking.vehicleColor;
        }

        // ------------------------------------------------------
        // SYNC PAYMENT
        // ------------------------------------------------------

        booking.payment.vehicleRent = Number(handover.payment.totalFare) || 0;

        booking.payment.fastagAmount =
          Number(handover.payment.fastTagPayableAmount) || 0;

        booking.payment.discountAmount =
          Number(handover.payment.discountAmount) || 0;

        booking.payment.securityDeposit =
          Number(handover.payment.securityDeposit) || 0;

        // ------------------------------------------------------
        // BOOKING TOTAL
        // ------------------------------------------------------

        booking.payment.totalAmount = Math.max(
          0,

          (Number(booking.payment.vehicleRent) || 0) +
            (Number(booking.payment.pickupCharge) || 0) +
            (Number(booking.payment.dropCharge) || 0) +
            (Number(booking.payment.fastagAmount) || 0),
        );

        await booking.save();
      }
    }

    // ==========================================================
    // SAVE HANDOVER
    // ==========================================================

    await handover.save();

    // ==========================================================
    // PAYMENT HISTORY
    // ==========================================================

    if (Number(amountReceivedNow) > 0) {
      try {
        await PaymentHistory.create({
          company: handover.company,

          bookingId: handover.bookingId,

          handoverId: handover._id,

          customer: {
            fullName: handover.customer?.fullName || "",

            mobileNumber: handover.customer?.mobileNumber || "",
          },

          vehicle: {
            vehicleId: handover.vehicle?.vehicleId || null,

            vehicleName: handover.vehicle?.vehicleName || "",

            vehicleNumber: handover.vehicle?.vehicleNumber || "",
          },

          amount: Number(amountReceivedNow),

          paymentMethod: paymentMethod || "phonepe",

          // FIX: array of 4-digit strings, matching PaymentHistory's
          // upiLast4: [String] schema field.
          upiLast4: sanitizedUpiLast4,

          paymentBreakdown: {
            cash: paymentMethod === "cash" ? Number(amountReceivedNow) : 0,

            phonePe:
              paymentMethod === "phonepe" ? Number(amountReceivedNow) : 0,

            razorpay:
              paymentMethod === "razorpay" ? Number(amountReceivedNow) : 0,
          },

          type: "extension",

          note: reasonForChange?.trim()
            ? `Rental payment - ${reasonForChange.trim()}`
            : "Payment received during rental update",

          createdBy: req.user._id,
        });
      } catch (paymentHistoryError) {
        // Payment history failure must not
        // break the rental update.

        console.error(
          "Payment History Creation Error:",
          paymentHistoryError?.message || paymentHistoryError,
        );
      }
    }

    // ==========================================================
    // SUCCESS RESPONSE
    // ==========================================================

    return res.status(200).json({
      success: true,

      message: "Rental updated successfully",

      data: {
        handover,

        billSummary: buildBillSummaryResponse(handover),
      },
    });
  } catch (error) {
    console.error("UPDATE RENTAL ERROR:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Failed to update rental",
    });
  }
};

// hanver get api
export const getHandovers = async (req, res) => {
  try {
    const { tab = "all" } = req.query;

    // No company filter
    const query = {
      isDeleted: false,
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    // IMPORTANT: "today" / "yesterday" describe when the handover
    // record was CREATED (createdAt), not the trip's pickupDateTime.
    // A handover created today can have a pickup scheduled for any
    // date, so filtering by pickupDateTime hid same-day entries.
    switch (tab) {
      case "today":
        query.createdAt = {
          $gte: today,
          $lt: tomorrow,
        };
        break;

      case "yesterday":
        query.createdAt = {
          $gte: yesterday,
          $lt: today,
        };
        break;

      case "draft":
        query.bookingStatus = "draft";
        break;

      default:
        break;
    }

    const handovers = await Handover.find(query)
      .populate("createdBy", "fullName email")
      .populate("company", "fullName companyName businessName")
      .populate("vehicle.vehicleId", "vehicleName vehicleNumber color status")
      .select(
        `
        company
        customer
        vehicle
        trip
        payment
        bookingStatus
        handoverStatus
        hasUploadedImages
        notes
        createdAt
        updatedAt
        createdBy
      `,
      )
      .sort({
        createdAt: -1,
      })
      .lean();

    const data = handovers.map((item) => ({
      _id: item._id,

      companyName:
        item.company?.businessName ||
        item.company?.companyName ||
        item.company?.fullName ||
        "",

      customerName: item.customer?.fullName || "",
      mobileNumber: item.customer?.mobileNumber || "",
      destination: item.customer?.destination || "",

      vehicleName: item.vehicle?.vehicleName || "",
      vehicleNumber: item.vehicle?.vehicleNumber || "",
      vehicleColor: item.vehicle?.vehicleColor || "",

      pickupDateTime: item.trip?.pickupDateTime,
      dropDateTime: item.trip?.dropDateTime,
      tripType: item.trip?.tripType,
      numberOfDays: item.trip?.numberOfDays,

      totalFare:
        item.payment?.billSummary?.totalFare ?? item.payment?.totalFare ?? 0,
      totalAmount:
        item.payment?.billSummary?.totalAmount ??
        item.payment?.totalAmount ??
        0,
      // NEW — balance now reads from the billSummary ledger (falls back to
      // payment.balanceAmount only for older records saved before
      // billSummary existed, so nothing breaks for historic data)
      balanceAmount:
        item.payment?.billSummary?.balanceAmount ??
        item.payment?.balanceAmount ??
        0,
      totalCollected: item.payment?.billSummary?.totalCollected ?? 0,
      paymentStatus: item.payment?.paymentStatus || "pending",

      bookingStatus: item.bookingStatus,
      handoverStatus: item.handoverStatus,
      hasUploadedImages: item.hasUploadedImages || false,

      notes: item.notes || "",

      createdBy: item.createdBy?.fullName || "",

      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Get Handovers Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch handovers.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
// NOT USED
export const getAllHandovers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const filters = {
      company: req.user.company || req.user._id,
      isDeleted: false,
    };

    // optional filters
    if (req.query.bookingStatus) {
      filters.bookingStatus = req.query.bookingStatus;
    }

    if (req.query.handoverStatus) {
      filters.handoverStatus = req.query.handoverStatus;
    }

    if (req.query.paymentStatus) {
      filters["payment.paymentStatus"] = req.query.paymentStatus;
    }

    // search
    if (req.query.search) {
      filters.$or = [
        {
          "customer.fullName": {
            $regex: req.query.search,
            $options: "i",
          },
        },
        {
          "customer.mobileNumber": {
            $regex: req.query.search,
            $options: "i",
          },
        },
        {
          "vehicle.vehicleNumber": {
            $regex: req.query.search,
            $options: "i",
          },
        },
        {
          "vehicle.vehicleName": {
            $regex: req.query.search,
            $options: "i",
          },
        },
      ];
    }

    const [handovers, total] = await Promise.all([
      Handover.find(filters)
        .populate("createdBy", "fullName email role")
        .populate("vehicle.vehicleId", "name number color type")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Handover.countDocuments(filters),
    ]);

    res.status(200).json({
      success: true,
      message: "Handovers fetched successfully",
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      data: handovers,
    });
  } catch (error) {
    next(error);
  }
};

export const updateHandover = async (req, res, next) => {
  try {
    const handover = await Handover.findOne({
      _id: req.params.id,
      isDeleted: false,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    Object.assign(handover, req.body);

    await handover.save();

    res.status(200).json({
      success: true,
      message: "Handover updated successfully",
      data: handover,
    });
  } catch (error) {
    console.log("========== CLOUDINARY ERROR ==========");
    console.log(error);
    console.log("MESSAGE:", error.message);
    console.log("STACK:", error.stack);

    return res.status(500).json({
      success: false,
      message: error.message,
      fullError: error,
    });
  }
};

export const deleteHandover = async (req, res, next) => {
  try {
    const handover = await Handover.findOne({
      _id: req.params.id,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    handover.isDeleted = true;

    await handover.save();

    res.status(200).json({
      success: true,
      message: "Handover deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const discardHandoverDraft = async (req, res) => {
  try {
    const { id } = req.params;

    const handover = await Handover.findOne({ _id: id, isDeleted: false });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found.",
      });
    }

    if (handover.bookingStatus !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft handovers can be discarded.",
      });
    }

    handover.bookingStatus = "cancelled";
    handover.isDeleted = true;

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Draft discarded successfully.",
      data: { _id: handover._id, bookingStatus: handover.bookingStatus },
    });
  } catch (error) {
    console.error("Discard Handover Draft Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to discard draft.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
