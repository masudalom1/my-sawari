import Handover from "../models/handover.model.js";
import Vehicle from "../models/vehicle.model.js";
import { sendBookingConfirmation } from "../services/wati.service.js";
import VehicleReturn from "../models/vehicleReturn.model.js";

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

// active rental screen
export const getActiveHandovers = async (req, res) => {
  try {
    const activeHandovers = await Handover.find({
      company: req.user.company || req.user._id,
      handoverStatus: "active",
      isDeleted: false,
    })
      .populate("vehicle.vehicleId")
      .populate("createdBy", "fullName")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: activeHandovers.length,
      data: activeHandovers,
    });
  } catch (error) {
    console.log("ACTIVE HANDOVER ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
export const getSingleHandover = async (req, res) => {
  try {
    const { id } = req.params;

    const handover = await Handover.findOne({
      _id: id,
      company: req.user.company || req.user._id,
      isDeleted: false,
    })
      .populate("createdBy", "fullName email")
      .populate("vehicle.vehicleId");

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    res.status(200).json({
      success: true,
      data: handover,
    });
  } catch (error) {
    console.log("GET SINGLE HANDOVER ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getReceiveCarList = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;

    /* ==========================
       GET ALL HANDOVERS
    ========================== */

    const handovers = await Handover.find({
      company: companyId,
      isDeleted: false,
      "vehicle.vehicleId": { $exists: true },
      handoverStatus: { $ne: "cancelled" },
    })
      .populate("vehicle.vehicleId")
      .populate("customer")
      .sort({
        "trip.dropDateTime": 1,
        createdAt: -1,
      });

    /* ==========================
       GET COMPLETED RETURNS
    ========================== */

    const vehicleReturns = await VehicleReturn.find({
      company: companyId,
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

      const returnData = completedMap.get(handover._id.toString());

      if (returnData) {
        obj.returnStatus = "completed";

        obj.returnDetails = {
          receivedBy: returnData.receivedBy
            ? {
                _id: returnData.receivedBy._id,
                fullName: returnData.receivedBy.fullName,
                role: returnData.receivedBy.role,
              }
            : null,

          receivingTime: returnData.receivingTime || null,

          scheduledReturnTime: returnData.scheduledReturnTime || null,

          timeStatus: returnData.timeStatus || "On Time",

          delayText: returnData.delayText || "0 minutes",

          pendingAmount:
            returnData.settlementDetails?.pendingAmount ??
            returnData.settlementDetails?.balanceAmount ??
            returnData.settlementDetails?.finalBalance ??
            0,

          settlementDetails: returnData.settlementDetails || {},
        };
      } else {
        obj.returnStatus = null;
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

    const handover = await Handover.findOne({
      _id: id,
      company: req.user.company || req.user._id,
      isDeleted: false,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        _id: handover._id,

        customerName: handover.customer.fullName,
        customerPhone: handover.customer.mobileNumber,

        vehicleModel: handover.vehicle.vehicleName,
        plateNumber: handover.vehicle.vehicleNumber,

        pickupDateTime: handover.trip.pickupDateTime,
        dropDateTime: handover.trip.dropDateTime,

        totalFare: handover.payment.totalFare,

        fastagCharges: handover.payment.fastTagPayableAmount,

        securityDeposit: handover.payment.securityDeposit,

        extraCharges: handover.payment.extraCharges,

        bookingAmountPaid: handover.payment.bookingAmountPaid,

        amountReceivedPreviously: handover.payment.amountReceivedNow,

        totalAmount: handover.payment.totalAmount,

        balanceAmount: handover.payment.balanceAmount,

        paymentMethod: handover.payment.paymentMethod,

        paymentStatus: handover.payment.paymentStatus,
      },
    });
  } catch (error) {
    console.log("GET RENTAL DETAILS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
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

    const handover = await Handover.findOne({
      _id: id,
      company: req.user.company || req.user._id,
      handoverStatus: "active",
      isDeleted: false,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Active rental not found",
      });
    }

    // Update trip
    if (dropDateTime) {
      handover.trip.dropDateTime = new Date(dropDateTime);

      const pickup = handover.trip.pickupDateTime;

      const drop = new Date(dropDateTime);

      const days = Math.ceil((drop - pickup) / (1000 * 60 * 60 * 24));

      handover.trip.numberOfDays = Math.max(1, days);
    }

    // Update payments
    handover.payment.totalFare = Number(totalFare) || 0;

    handover.payment.fastTagPayableAmount = Number(fastagCharges) || 0;

    handover.payment.securityDeposit = Number(securityDeposit) || 0;

    handover.payment.extraCharges = Number(extraCharges) || 0;

    // Calculate total amount
    handover.payment.totalAmount =
      handover.payment.totalFare +
      handover.payment.fastTagPayableAmount +
      handover.payment.securityDeposit +
      handover.payment.extraCharges;

    // Add newly collected payment
    handover.payment.amountReceivedNow += Number(amountReceivedNow) || 0;

    // Recalculate balance
    const totalPaid =
      handover.payment.bookingAmountPaid + handover.payment.amountReceivedNow;

    handover.payment.balanceAmount = Math.max(
      0,
      handover.payment.totalAmount - totalPaid,
    );

    // Payment status
    if (handover.payment.balanceAmount === 0) {
      handover.payment.paymentStatus = "paid";
    } else if (totalPaid > 0) {
      handover.payment.paymentStatus = "partial";
    } else {
      handover.payment.paymentStatus = "pending";
    }

    // Save edit note
    if (reasonForChange) {
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
    console.log("UPDATE RENTAL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
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
