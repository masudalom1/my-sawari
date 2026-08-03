import mongoose from "mongoose";
import Handover from "../models/handover.model.js";
import Vehicle from "../models/vehicle.model.js";
import { sendBookingConfirmation } from "../services/wati.service.js";
import VehicleReturn from "../models/vehicleReturn.model.js";
import Booking from "../models/booking.model.js";

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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
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

    const update = {};

    REQUIRED_IMAGES.forEach((key) => {
      const value = req.body[key];

      if (typeof value === "string" && value.trim() !== "") {
        update[`images.${key}`] = value.trim();
      }
    });

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
// active rental screen
export const getActiveHandovers = async (req, res) => {
  try {
    const activeHandovers = await Handover.find({
      handoverStatus: "active",
      isDeleted: false,
    })
      .populate("vehicle.vehicleId")
      .populate("createdBy", "fullName")
      .sort({ createdAt: -1 });

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
    /* ==========================
       GET ALL HANDOVERS
    ========================== */

    const handovers = await Handover.find({
      isDeleted: false,
      "vehicle.vehicleId": { $exists: true },
      handoverStatus: { $ne: "cancelled" },
    })
      .populate("vehicle.vehicleId")
      .populate("createdBy", "fullName role email mobileNumber profileImage")
      .populate("assignedDriver", "fullName mobileNumber profileImage role")
      .populate({
        path: "bookingId",
        select: {
          tripType: 1,
          destination: 1,
          pickup: 1,
          drop: 1,
        },
      })
      .sort({
        "trip.dropDateTime": 1,
        createdAt: -1,
      });

    /* ==========================
       GET COMPLETED RETURNS
    ========================== */

    const vehicleReturns = await VehicleReturn.find({
      returnStatus: "completed",
    }).populate("receivedBy", "fullName role email mobileNumber").select(`
        handover
        returnStatus
        receivedBy
        receivingTime
        scheduledReturnTime
        timeStatus
        delayText
        settlementDetails
      `);

    /* ==========================
       CREATE LOOKUP MAP
    ========================== */

    const completedMap = new Map(
      vehicleReturns.map((item) => [item.handover.toString(), item]),
    );

    /* ==========================
       MERGE DATA
    ========================== */

    const finalData = handovers.map((handover) => {
      const obj = handover.toObject();

      const now = new Date();
      const dropDateTime = new Date(obj.trip.dropDateTime);

      const diffMs = dropDateTime.getTime() - now.getTime();
      const absMs = Math.abs(diffMs);

      const days = Math.floor(absMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((absMs / (1000 * 60 * 60)) % 24);
      const minutes = Math.floor((absMs / (1000 * 60)) % 60);

      const formatDuration = () => {
        const parts = [];

        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

        return parts.join(" ");
      };

      // ==========================
      // DATE COMPARISON (IST)
      // ==========================

      const today = new Date();
      const tomorrow = new Date();
      tomorrow.setDate(today.getDate() + 1);

      const todayStr = today.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

      const tomorrowStr = tomorrow.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

      const dropStr = dropDateTime.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

      const isToday = dropStr === todayStr;
      const isTomorrow = dropStr === tomorrowStr;
      const isPastDate = dropStr < todayStr;
      const isFutureDate = dropStr > tomorrowStr;

      let receiveStatus = "";
      let receiveLabel = "";

      if (isToday) {
        // Keep in Today tab for the entire calendar day
        receiveStatus = diffMs >= 0 ? "today" : "today_overdue";
        receiveLabel =
          diffMs >= 0
            ? `Due in ${formatDuration()}`
            : `Overdue by ${formatDuration()}`;
      } else if (isTomorrow) {
        receiveStatus = "tomorrow";
        receiveLabel = `Due in ${formatDuration()}`;
      } else if (isPastDate) {
        receiveStatus = "overdue";
        receiveLabel = `Overdue by ${formatDuration()}`;
      } else if (isFutureDate) {
        receiveStatus = "upcoming";
        receiveLabel = `Due in ${formatDuration()}`;
      } else {
        receiveStatus = "upcoming";
        receiveLabel = `Due in ${formatDuration()}`;
      }

      obj.receiveTracker = {
        status: receiveStatus,
        label: receiveLabel,
        overdue: diffMs < 0,
        isToday,
        isTomorrow,
        remainingMs: diffMs,
      };

      obj.billSummary = obj.payment?.billSummary || {};

      const booking = obj.bookingId;

      obj.dropLocation =
        booking &&
        booking.drop &&
        typeof booking.drop.location === "string" &&
        booking.drop.location.trim().length > 0
          ? booking.drop.location.trim()
          : "Office";

      obj.dropLandmark =
        booking && booking.drop && typeof booking.drop.landmark === "string"
          ? booking.drop.landmark.trim()
          : "";

      obj.dropMapLink =
        booking && booking.drop && typeof booking.drop.mapLink === "string"
          ? booking.drop.mapLink.trim()
          : "";
      obj.dropCharge =
        booking && booking.drop && typeof booking.drop.charge === "number"
          ? booking.drop.charge
          : 0;

      // ==========================
      // CREATED BY
      // ==========================

      obj.createdByUser = handover.createdBy
        ? {
            _id: handover.createdBy._id,
            fullName: handover.createdBy.fullName,
            role: handover.createdBy.role,
            email: handover.createdBy.email,
            mobileNumber: handover.createdBy.mobileNumber,
            profileImage: handover.createdBy.profileImage,
          }
        : null;

      // ==========================
      // RETURN DETAILS
      // ==========================

      const returnData = completedMap.get(handover._id.toString());

      if (returnData) {
        obj.returnStatus = "completed";

        obj.returnDetails = {
          receivedBy: returnData.receivedBy
            ? {
                _id: returnData.receivedBy._id,
                fullName: returnData.receivedBy.fullName,
                role: returnData.receivedBy.role,
                email: returnData.receivedBy.email,
                mobileNumber: returnData.receivedBy.mobileNumber,
              }
            : null,

          receivingTime: returnData.receivingTime || null,
          scheduledReturnTime: returnData.scheduledReturnTime || null,
          timeStatus: returnData.timeStatus || "On Time",
          delayText: returnData.delayText || "0 minutes",
          settlementDetails: returnData.settlementDetails || {},
        };
      } else {
        obj.returnStatus = null;
        obj.returnDetails = null;
      }

      return obj;
    });

    /* ==========================
       COUNTS
    ========================== */

    const completedCount = finalData.filter(
      (item) => item.returnStatus === "completed",
    ).length;

    const activeCount = finalData.filter(
      (item) => item.returnStatus !== "completed",
    ).length;

    /* ==========================
       RESPONSE
    ========================== */

    return res.status(200).json({
      success: true,
      count: finalData.length,
      activeCount,
      completedCount,
      data: finalData,
    });
  } catch (error) {
    console.error("GET RECEIVE CAR LIST ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch receive car list",
    });
  }
};

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

export const updateRental = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      vehicleId,
      dropDateTime,
      extensionPrice, // itemized charge for THIS extension
      fastagCharges,
      securityDeposit,
      extraCharges,
      discountAmount,
      amountReceivedNow,
      paymentMethod,
      reasonForChange,
    } = req.body;

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

    /* ==========================
       CHANGE VEHICLE (unchanged)
    ========================== */
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

      await Vehicle.findByIdAndUpdate(oldVehicleId, { status: "available" });
      await Vehicle.findByIdAndUpdate(vehicle._id, { status: "rent" });

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

      handover.vehicle.vehicleId = vehicle._id;
      handover.vehicle.vehicleName = vehicle.vehicleName;
      handover.vehicle.vehicleNumber = vehicle.vehicleNumber;
      handover.vehicle.vehicleColor = vehicle.color || "";
    }

    /* ==========================
       EXTEND / SHORTEN TRIP
       -> totalFare is bumped by extensionAmount (cumulative,
          since there's no separate baseFare field) and a new
          ledger entry is appended
    ========================== */
    if (dropDateTime) {
      const previousDropDateTime = handover.trip.dropDateTime;
      const previousNumberOfDays = handover.trip.numberOfDays || 1;
      const newDrop = new Date(dropDateTime);

      const dropChanged =
        new Date(previousDropDateTime).getTime() !== newDrop.getTime();

      if (dropChanged) {
        const pickup = new Date(handover.trip.pickupDateTime);
        const newNumberOfDays = Math.max(
          1,
          Math.ceil((newDrop - pickup) / (1000 * 60 * 60 * 24)),
        );
        const extraDays = newNumberOfDays - previousNumberOfDays;
        const extensionAmount = Number(extensionPrice) || 0;

        handover.trip.dropDateTime = newDrop;
        handover.trip.numberOfDays = newNumberOfDays;

        // totalFare is cumulative — bump it by this extension's amount
        handover.payment.totalFare =
          (handover.payment.totalFare || 0) + extensionAmount;

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

    /* ==========================
       UPDATE OTHER PAYMENT FIELDS
    ========================== */
    if (fastagCharges !== undefined)
      handover.payment.fastTagPayableAmount = Number(fastagCharges) || 0;

    if (securityDeposit !== undefined)
      handover.payment.securityDeposit = Number(securityDeposit) || 0;

    if (extraCharges !== undefined)
      handover.payment.extraCharges = Number(extraCharges) || 0;

    if (discountAmount !== undefined)
      handover.payment.discountAmount = Number(discountAmount) || 0;

    if (paymentMethod) handover.payment.paymentMethod = paymentMethod;

    const pickupCharge = handover.payment.billSummary?.pickupCharge || 0;
    const dropCharge = handover.payment.billSummary?.dropCharge || 0;

    handover.payment.totalAmount = Math.max(
      0,
      (handover.payment.totalFare || 0) +
        (handover.payment.fastTagPayableAmount || 0) +
        pickupCharge +
        dropCharge +
        (handover.payment.securityDeposit || 0) +
        (handover.payment.extraCharges || 0) -
        (handover.payment.discountAmount || 0),
    );

    if (amountReceivedNow !== undefined) {
      const received = Number(amountReceivedNow) || 0;
      handover.payment.amountReceivedNow =
        (handover.payment.amountReceivedNow || 0) + received;

      if (paymentMethod === "cash") {
        handover.payment.paymentBreakdown.cash =
          (handover.payment.paymentBreakdown.cash || 0) + received;
      } else if (paymentMethod === "phonepe") {
        handover.payment.paymentBreakdown.phonePe =
          (handover.payment.paymentBreakdown.phonePe || 0) + received;
      } else if (paymentMethod === "razorpay") {
        handover.payment.paymentBreakdown.razorpay =
          (handover.payment.paymentBreakdown.razorpay || 0) + received;
      }
    }

    // Keep the cached snapshot in sync — this schema's hook doesn't
    // touch billSummary, so the controller refreshes it explicitly.
    //
    // FIX: totalAmount below is now the SAME value just computed
    // above (not re-derived a second, different way), and
    // balanceAmount is totalAmount - totalCollected only — the
    // discount is already baked into totalAmount, so it must not be
    // subtracted again here.
    const totalPaidSoFar =
      (handover.payment.bookingAmountPaid || 0) +
      (handover.payment.amountReceivedNow || 0);

    handover.payment.billSummary = {
      totalFare: handover.payment.totalFare || 0,
      fastTagPayable: handover.payment.fastTagPayableAmount || 0,
      pickupCharge,
      dropCharge,
      securityDeposit: handover.payment.securityDeposit || 0,
      extraCharges: handover.payment.extraCharges || 0,
      discountAmount: handover.payment.discountAmount || 0,
      totalAmount: handover.payment.totalAmount,
      bookingAmountPaid: handover.payment.bookingAmountPaid || 0,
      amountReceivedNow: handover.payment.amountReceivedNow || 0,
      totalCollected: totalPaidSoFar,
      balanceAmount: Math.max(0, handover.payment.totalAmount - totalPaidSoFar),
    };

    /* ==========================
       UPDATE NOTES (unchanged)
    ========================== */
    if (reasonForChange?.trim()) {
      const updateNote = `\n[Rental Updated - ${new Date().toLocaleString()}]\nReason: ${reasonForChange}\n`;
      handover.notes = `${handover.notes || ""}\n${updateNote}`
        .trim()
        .slice(-500);
    }

    /* ==========================
       SYNC LINKED BOOKING
       -> Booking.toDate/totalDays and Booking.payment mirror the
          handover's trip + payment fields. Booking has its own
          pre-save hook (different formula: totalAmount - discount -
          bookingAmountPaid) so it must be saved too, not just
          assigned, or its balanceAmount/paymentStatus go stale.
    ========================== */
    if (handover.bookingId) {
      const booking = await Booking.findById(handover.bookingId);

      if (booking) {
        booking.toDate = handover.trip.dropDateTime;
        booking.totalDays = handover.trip.numberOfDays;

        // Booking.payment.vehicleRent is the counterpart of
        // handover.payment.totalFare (base fare + every extension).
        // pickupCharge/dropCharge originated on Booking in the first
        // place, so they're left untouched here — only re-read to
        // confirm handover.payment.billSummary still agrees with them.
        booking.payment.vehicleRent = handover.payment.totalFare || 0;
        booking.payment.fastagAmount =
          handover.payment.fastTagPayableAmount || 0;
        booking.payment.discountAmount = handover.payment.discountAmount || 0;
        booking.payment.securityDeposit = handover.payment.securityDeposit || 0;

        booking.payment.totalAmount = Math.max(
          0,
          (booking.payment.vehicleRent || 0) +
            (booking.payment.pickupCharge || 0) +
            (booking.payment.dropCharge || 0) +
            (booking.payment.fastagAmount || 0),
        );

        await booking.save(); // hook recomputes balanceAmount/paymentStatus/totalCollected
      }
    }

    await handover.save(); // hook computes balanceAmount + paymentStatus from totalAmount

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
