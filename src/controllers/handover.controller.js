import Handover from "../models/handover.model.js";
import Vehicle from "../models/vehicle.model.js";
import { sendBookingConfirmation } from "../services/wati.service.js";
import VehicleReturn from "../models/vehicleReturn.model.js";

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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
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

    const {
      customer,
      identity,
      vehicle,
      trip,
      payment,
      notes,
      currentScreen,
    } = req.body;

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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
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
      handover.images.customerProfileImage =
        files.customerProfileImage[0].path;
    }

    if (files.customerWithVehicle?.[0]) {
      handover.images.customerWithVehicle =
        files.customerWithVehicle[0].path;
    }

    if (files.idCardFront?.[0]) {
      handover.images.idCardFront =
        files.idCardFront[0].path;
    }

    if (files.idCardBack?.[0]) {
      handover.images.idCardBack =
        files.idCardBack[0].path;
    }

    if (files.vehicleFront?.[0]) {
      handover.images.vehicleFront =
        files.vehicleFront[0].path;
    }

    if (files.vehicleRear?.[0]) {
      handover.images.vehicleRear =
        files.vehicleRear[0].path;
    }

    if (files.vehicleLeft?.[0]) {
      handover.images.vehicleLeft =
        files.vehicleLeft[0].path;
    }

    if (files.vehicleRight?.[0]) {
      handover.images.vehicleRight =
        files.vehicleRight[0].path;
    }

    handover.draftProgress.enabled = true;
    handover.draftProgress.currentScreen = "images";
    handover.draftProgress.lastSavedAt = new Date();

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Images saved successfully.",
      data: {
        uploadedImages:
          handover.draftProgress.uploadedImages,
        totalImages:
          handover.draftProgress.totalImages,
        imagesCompleted:
          handover.draftProgress.imagesCompleted,
      },
    });
  } catch (error) {
    console.error("Upload Draft Images Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to upload images.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
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
      .populate("createdBy", "fullName email")
      .populate("vehicle.vehicleId")
      .lean();

    if (!handover || handover.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: handover,
    });
  } catch (error) {
    console.error(error);

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

    const vehicle = await Vehicle.findById(
      handover.vehicle.vehicleId
    );

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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};
// ==========================================
// CREATE HANDOVER
// ==========================================
export const createHandover = async (req, res, next) => {
  try {
    const { customer, identity, vehicle, trip, payment, notes, bookingStatus } =
      req.body;

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

    // ==========================
    // CREATE HANDOVER
    // ==========================
    const handover = await Handover.create({
      company: req.user.company || req.user._id,
      createdBy: req.user._id,

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
      },

      notes: notes || "",

      bookingStatus: bookingStatus || "confirmed",

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
export const saveHandoverImages = async (req, res) => {
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

    if (customerPhoto)
      update["images.customerPhoto"] = customerPhoto;

    if (customerProfileImage)
      update["images.customerProfileImage"] =
        customerProfileImage;

    if (customerWithVehicle)
      update["images.customerWithVehicle"] =
        customerWithVehicle;

    if (idCardFront)
      update["images.idCardFront"] =
        idCardFront;

    if (idCardBack)
      update["images.idCardBack"] =
        idCardBack;

    if (vehicleFront)
      update["images.vehicleFront"] =
        vehicleFront;

    if (vehicleRear)
      update["images.vehicleRear"] =
        vehicleRear;

    if (vehicleLeft)
      update["images.vehicleLeft"] =
        vehicleLeft;

    if (vehicleRight)
      update["images.vehicleRight"] =
        vehicleRight;

    const handover = await Handover.findByIdAndUpdate(
      handoverId,
      {
        $set: update,
      },
      {
        new: true,
        runValidators: true,
      }
    ).select("_id images");

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Images saved successfully",
      data: handover,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to save images",
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
      .populate("returnDetails.returnedBy", "fullName email mobileNumber role");

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

      // Always include created by user
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

    return res.status(200).json({
      success: true,
      data: {
        _id: handover._id,

        customerName: handover.customer?.fullName || "",
        customerPhone: handover.customer?.mobileNumber || "",

        vehicleModel: handover.vehicle?.vehicleName || "",
        plateNumber: handover.vehicle?.vehicleNumber || "",

        pickupDateTime: handover.trip?.pickupDateTime,
        dropDateTime: handover.trip?.dropDateTime,

        totalFare: handover.payment?.totalFare || 0,

        fastagCharges: handover.payment?.fastTagPayableAmount || 0,

        securityDeposit: handover.payment?.securityDeposit || 0,

        extraCharges: handover.payment?.extraCharges || 0,

        bookingAmountPaid: handover.payment?.bookingAmountPaid || 0,

        amountReceivedPreviously: handover.payment?.amountReceivedNow || 0,

        totalAmount: handover.payment?.totalAmount || 0,

        balanceAmount: handover.payment?.balanceAmount || 0,

        paymentMethod: handover.payment?.paymentMethod || "",

        paymentStatus: handover.payment?.paymentStatus || "pending",
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
export const updateRental = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      dropDateTime,
      totalFare,
      fastagCharges,
      securityDeposit,
      extraCharges,
      amountReceivedNow,
      reasonForChange,
    } = req.body;

    const handover = await Handover.findById(id);

    if (
      !handover ||
      handover.isDeleted ||
      handover.handoverStatus !== "active"
    ) {
      return res.status(404).json({
        success: false,
        message: "Active rental not found",
      });
    }

    /* ==========================
       UPDATE TRIP
    ========================== */

    if (dropDateTime) {
      handover.trip.dropDateTime = new Date(dropDateTime);

      const pickup = new Date(handover.trip.pickupDateTime);
      const drop = new Date(dropDateTime);

      const days = Math.ceil((drop - pickup) / (1000 * 60 * 60 * 24));

      handover.trip.numberOfDays = Math.max(1, days);
    }

    /* ==========================
       UPDATE PAYMENTS
    ========================== */

    handover.payment.totalFare = Number(totalFare) || 0;

    handover.payment.fastTagPayableAmount = Number(fastagCharges) || 0;

    handover.payment.securityDeposit = Number(securityDeposit) || 0;

    handover.payment.extraCharges = Number(extraCharges) || 0;

    handover.payment.totalAmount =
      handover.payment.totalFare +
      handover.payment.fastTagPayableAmount +
      handover.payment.securityDeposit +
      handover.payment.extraCharges;

    handover.payment.amountReceivedNow += Number(amountReceivedNow) || 0;

    const totalPaid =
      (handover.payment.bookingAmountPaid || 0) +
      (handover.payment.amountReceivedNow || 0);

    handover.payment.balanceAmount = Math.max(
      0,
      handover.payment.totalAmount - totalPaid,
    );

    if (handover.payment.balanceAmount === 0) {
      handover.payment.paymentStatus = "paid";
    } else if (totalPaid > 0) {
      handover.payment.paymentStatus = "partial";
    } else {
      handover.payment.paymentStatus = "pending";
    }

    /* ==========================
       SAVE CHANGE NOTE
    ========================== */

    if (reasonForChange?.trim()) {
      handover.notes = `${handover.notes || ""}

[Rental Updated - ${new Date().toLocaleString()}]
${reasonForChange}`.trim();
    }

    await handover.save();

    return res.status(200).json({
      success: true,
      message: "Rental updated successfully",
      data: handover,
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

    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(today.getDate() + 2);

    switch (tab) {
      case "today":
        query["trip.pickupDateTime"] = {
          $gte: today,
          $lt: tomorrow,
        };
        break;

      case "tomorrow":
        query["trip.pickupDateTime"] = {
          $gte: tomorrow,
          $lt: dayAfterTomorrow,
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
      .populate(
        "company",
        "fullName companyName businessName"
      )
      .populate(
        "vehicle.vehicleId",
        "vehicleName vehicleNumber color status"
      )
      .select(`
        company
        customer
        vehicle
        trip
        payment
        bookingStatus
        handoverStatus
        notes
        createdAt
        updatedAt
        createdBy
      `)
      .sort({
        "trip.pickupDateTime": 1,
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

      totalFare: item.payment?.totalFare || 0,
      totalAmount: item.payment?.totalAmount || 0,
      balanceAmount: item.payment?.balanceAmount || 0,
      paymentStatus: item.payment?.paymentStatus || "pending",

      bookingStatus: item.bookingStatus,
      handoverStatus: item.handoverStatus,

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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
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
      company: req.user.company || req.user._id,
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
      company: req.user.company || req.user._id,
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
