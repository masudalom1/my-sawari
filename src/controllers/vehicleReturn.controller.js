import Handover from "../models/handover.model.js";
import Vehicle from "../models/vehicle.model.js";
import VehicleReturn from "../models/vehicleReturn.model.js";

export const receiveVehicle = async (req, res) => {
  try {
    const { handoverId } = req.params;

    const {
      fuelLevel,
      kilometersAtReturn,
      hasDamage,
      damageNotes,
      inspection,

      repairEstimate,
      repairDays,

      lateReturnFine,
      extraKmFine,
      fuelUsageAmount,
      amountCollected,
      paymentMode,
      balanceReason,

      needsMaintenance,
      maintenanceReason,
      maintenanceDays,
    } = req.body;

    const files = req.files || {};


    /* ==========================
       BASIC VALIDATION
    ========================== */

    if (!fuelLevel || !kilometersAtReturn) {
      return res.status(400).json({
        success: false,
        message: "Fuel level and kilometers at return are required",
      });
    }

    if (
      !files.vehicleFront?.[0] ||
      !files.vehicleRear?.[0] ||
      !files.vehicleLeft?.[0] ||
      !files.vehicleRight?.[0]
    ) {
      return res.status(400).json({
        success: false,
        message: "Front, Rear, Left and Right vehicle images are required",
      });
    }

    /* ==========================
       FIND HANDOVER
    ========================== */
    const handover = await Handover.findById(handoverId);

    if (!handover) {
      return res
        .status(404)
        .json({ success: false, message: "Handover not found" });
    }

    const companyId = handover.company;

    if (handover.handoverStatus === "returned") {
      return res.status(400).json({
        success: false,
        message: "Vehicle already received",
      });
    }

    /* ==========================
       FIND VEHICLE
    ========================== */

    const vehicleId = handover.vehicle?.vehicleId || handover.vehicle;

    const vehicle = await Vehicle.findById(vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    if (vehicle.status !== "rent") {
      return res.status(400).json({
        success: false,
        message: "Vehicle is not currently on rent",
      });
    }

    /* ==========================
       EXISTING RETURN CHECK
    ========================== */

    const existingReturn = await VehicleReturn.findOne({
      handover: handoverId,
    });

    if (existingReturn) {
      return res.status(400).json({
        success: false,
        message: "Return already submitted",
      });
    }

    /* ==========================
       INSPECTION PARSE
    ========================== */

    let parsedInspection = [];

    try {
      if (inspection) {
        parsedInspection =
          typeof inspection === "string" ? JSON.parse(inspection) : inspection;
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid inspection data format",
      });
    }

    /* ==========================
       DAMAGE DATA
    ========================== */

    const isDamaged = hasDamage === true || hasDamage === "true";

    const damageImages = files.damageImages?.map((file) => file.path) || [];

    if (isDamaged && damageImages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Damage images are required when damage is reported",
      });
    }

    const maintenanceRequired =
      needsMaintenance === true ||
      needsMaintenance === "true" ||
      needsMaintenance === "yes";

    if (maintenanceRequired && !maintenanceReason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Maintenance reason is required",
      });
    }

    if (
      maintenanceRequired &&
      (!maintenanceDays || Number(maintenanceDays) <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Maintenance days are required",
      });
    }

    const estimate = Number(repairEstimate) || 0;

    const repairDuration = Number(repairDays) || 0;

    /* ==========================
       SETTLEMENT CALCULATIONS
    ========================== */

    const pendingAmount = Number(handover.payment?.balanceAmount) || 0;

    const lateFine = Number(lateReturnFine) || 0;

    const kmFine = Number(extraKmFine) || 0;

    const fuelFine = Number(fuelUsageAmount) || 0;

    const collected = Number(amountCollected) || 0;

    const totalBalanceAmount =
      pendingAmount + lateFine + kmFine + fuelFine + estimate;

    const finalBalance = Math.max(totalBalanceAmount - collected, 0);

    /* ==========================
       VALIDATE REASON
    ========================== */

    if (finalBalance > 0 && !balanceReason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Reason is required when full amount is not collected",
      });
    }

    /* ==========================
       SETTLEMENT STATUS
    ========================== */

    let settlementStatus = "Pending Collection";

    if (totalBalanceAmount === 0 || collected >= totalBalanceAmount) {
      settlementStatus = "Collected";
    } else if (collected > 0) {
      settlementStatus = "Partially Collected";
    }
    /* ==========================
   TIME CALCULATIONS
========================== */

    const actualReceivingTime = new Date();

    const scheduledReturnTime = new Date(handover.trip.dropDateTime);

    const diffMs = actualReceivingTime - scheduledReturnTime;

    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    let timeStatus = "On Time";
    let delayInMinutes = 0;
    let delayText = "0 minutes";

    if (diffMinutes > 15) {
      // More than 15 minutes late
      timeStatus = "Delayed";

      delayInMinutes = diffMinutes;

      const days = Math.floor(delayInMinutes / (24 * 60));

      const hours = Math.floor((delayInMinutes % (24 * 60)) / 60);

      const mins = delayInMinutes % 60;

      delayText =
        `${days > 0 ? `${days}d ` : ""}` +
        `${hours > 0 ? `${hours}h ` : ""}` +
        `${mins}m`;
    } else if (diffMinutes < -15) {
      // More than 15 minutes early
      timeStatus = "Before Time";

      delayText = "Received Early";
    }

    /* ==========================
       CREATE RETURN
    ========================== */

    const vehicleReturn = await VehicleReturn.create({
      
      company: companyId,

      createdBy: req.user._id,

      // New fields
      receivedBy: req.user._id,

      receivingTime: actualReceivingTime,

      scheduledReturnTime,

      timeStatus,

      delayInMinutes,

      delayText,

      handover: handover._id,

      vehicle: vehicle._id,

      customerName: handover.customer?.fullName || "",

      fuelLevel: Number(fuelLevel),

      kilometersAtReturn: Number(kilometersAtReturn),

      hasDamage: isDamaged,

      damageNotes: damageNotes || "",

      inspection: parsedInspection,

      maintenanceDetails: {
        required: maintenanceRequired,

        reason: maintenanceReason || "",

        estimatedDays: Number(maintenanceDays) || 0,

        estimatedCompletionDate: maintenanceRequired
          ? new Date(Date.now() + Number(maintenanceDays) * 24 * 60 * 60 * 1000)
          : null,
      },

      /* ======================
     VEHICLE RETURN IMAGES
  ====================== */

      images: {
        vehicleFront: files.vehicleFront?.[0]?.path || "",

        vehicleRear: files.vehicleRear?.[0]?.path || "",

        vehicleLeft: files.vehicleLeft?.[0]?.path || "",

        vehicleRight: files.vehicleRight?.[0]?.path || "",
      },

      /* ======================
     DAMAGE IMAGES
  ====================== */

      damageImages,

      /* ======================
     DAMAGE DETAILS
  ====================== */

      damageCostDetails: isDamaged
        ? {
            repairEstimate: estimate,

            repairDays: repairDuration,

            actualRepairCost: 0,

            repairedAt: null,

            remarks: "",

            status: "Pending",
          }
        : undefined,

      /* ======================
     SETTLEMENT DETAILS
  ====================== */

      settlementDetails: {
        pendingAmount,

        lateReturnFine: lateFine,

        extraKmFine: kmFine,

        fuelUsageAmount: fuelFine,

        damageAmount: estimate,

        totalBalanceAmount,

        amountCollected: collected,

        paymentMode: paymentMode || "Cash",

        finalBalance,

        balanceReason: balanceReason || "",

        status: settlementStatus,

        settledAt: new Date(),
      },

      returnStatus: "completed",
    });

    /* ==========================
       UPDATE VEHICLE
    ========================== */

    if (maintenanceRequired) {
      const estimatedDays = Number(maintenanceDays) || 0;

      const completionDate = new Date();

      completionDate.setDate(completionDate.getDate() + estimatedDays);

      vehicle.status = "service";

      vehicle.maintenance = {
        required: true,

        reason: maintenanceReason || "",

        estimatedDays,

        estimatedCompletionDate: completionDate,

        markedBy: req.user._id,

        markedAt: new Date(),
      };
    } else {
      vehicle.status = "available";

      vehicle.maintenance = {
        required: false,

        reason: "",

        estimatedDays: 0,

        estimatedCompletionDate: null,

        markedBy: null,

        markedAt: null,
      };
    }

    await vehicle.save();

    /* ==========================
       UPDATE HANDOVER
    ========================== */

    handover.handoverStatus = "returned";

    handover.returnDetails = {
      returnedAt: new Date(),
      returnedBy: req.user._id,
      remarks: balanceReason || "",
    };

    handover.payment.balanceAmount = finalBalance;

    if (finalBalance === 0) {
      handover.payment.paymentStatus = "paid";
    } else if (collected > 0) {
      handover.payment.paymentStatus = "partial";
    } else {
      handover.payment.paymentStatus = "pending";
    }

    await handover.save();

    /* ==========================
       RESPONSE
    ========================== */

    return res.status(201).json({
      success: true,
      message: "Vehicle received successfully",
      data: vehicleReturn,
    });
  } catch (error) {
    console.error("RECEIVE VEHICLE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error",
    });
  }
};

// menu/service
export const getServiceVehicles = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;

    const vehicles = await Vehicle.find({
      company: companyId,
      isDeleted: false,
      status: "service",
    })
      .populate("maintenance.markedBy", "fullName role")
      .sort({
        "maintenance.markedAt": -1,
      });

    const data = vehicles.map((vehicle) => {
      const today = new Date();

      const completionDate = vehicle.maintenance?.estimatedCompletionDate;

      let remainingDays = 0;

      if (completionDate) {
        remainingDays = Math.ceil(
          (new Date(completionDate) - today) / (1000 * 60 * 60 * 24),
        );
      }

      return {
        _id: vehicle._id,

        vehicleName: vehicle.vehicleName,
        vehicleNumber: vehicle.vehicleNumber,
        manufacturer: vehicle.manufacturer,
        model: vehicle.model,
        variant: vehicle.variant,
        color: vehicle.color,

        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        transmission: vehicle.transmission,
        seatingCapacity: vehicle.seatingCapacity,

        status: vehicle.status,

        images: vehicle.images,

        maintenance: {
          required: vehicle.maintenance?.required || false,

          reason: vehicle.maintenance?.reason || "",

          estimatedDays: vehicle.maintenance?.estimatedDays || 0,

          estimatedCompletionDate: vehicle.maintenance?.estimatedCompletionDate,

          remainingDays,

          markedAt: vehicle.maintenance?.markedAt,

          markedBy: vehicle.maintenance?.markedBy
            ? {
                _id: vehicle.maintenance.markedBy._id,
                fullName: vehicle.maintenance.markedBy.fullName,
                role: vehicle.maintenance.markedBy.role,
              }
            : null,
        },
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("GET SERVICE VEHICLES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch service vehicles",
    });
  }
};
export const markVehicleAvailable = async (req, res) => {
  try {
    const { id } = req.params;

    const companyId = req.user.company || req.user._id;

    const vehicle = await Vehicle.findOne({
      _id: id,
      company: companyId,
      isDeleted: false,
    });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    vehicle.status = "available";

    vehicle.maintenance = {
      required: false,
      reason: "",
      estimatedDays: 0,
      estimatedCompletionDate: null,
      markedBy: null,
      markedAt: null,
    };

    await vehicle.save();

    return res.status(200).json({
      success: true,
      message: "Vehicle marked as available",
      data: vehicle,
    });
  } catch (error) {
    console.error("MARK AVAILABLE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* ==========================
   GET RETURN DETAILS (for Completed tab)
========================== */

export const getReturnDetails = async (req, res) => {
  try {
    const { handoverId } = req.params;

    console.log("========== GET RETURN DETAILS ==========");
    console.log("Requested Handover ID:", handoverId);

    const vehicleReturn = await VehicleReturn.findOne({
      handover: handoverId,
    })
      .populate({
        path: "vehicle", // VehicleReturn.vehicle -> Vehicle
        select:
          "vehicleName vehicleNumber manufacturer model variant color images",
      })
      .populate("receivedBy", "fullName role")
      .populate("createdBy", "fullName role")
      .populate("company", "fullName role")
      .populate({
        path: "handover", // VehicleReturn.handover -> Handover (full doc, no select)
        populate: [
          {
            path: "vehicle.vehicleId", // Handover.vehicle.vehicleId -> Vehicle
            select:
              "vehicleName vehicleNumber manufacturer model variant color images",
          },
          {
            path: "createdBy", // who created the handover
            select: "fullName role",
          },
          {
            path: "company", // owning company
            select: "fullName role",
          },
          {
            path: "bookingId", // linked booking, if you want it too
          },
          {
            path: "extensionBills.createdBy", // who made each extension
            select: "fullName role",
          },
          {
            path: "returnDetails.returnedBy",
            select: "fullName role",
          },
          {
            path: "vehicleHistory.oldVehicle.vehicleId",
            select: "vehicleName vehicleNumber",
          },
          {
            path: "vehicleHistory.newVehicle.vehicleId",
            select: "vehicleName vehicleNumber",
          },
          {
            path: "vehicleHistory.changedBy",
            select: "fullName role",
          },
        ],
      });

    if (!vehicleReturn) {
      console.log("Vehicle return not found for handover:", handoverId);

      return res.status(404).json({
        success: false,
        message: "Return details not found for this handover",
      });
    }

    console.log("Vehicle Return Found:", vehicleReturn._id);

    return res.status(200).json({
      success: true,
      data: vehicleReturn,
    });
  } catch (error) {
    console.error("GET RETURN DETAILS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error",
    });
  }
};

export const getVehicleReturnsDashboard = async (req, res) => {
  try {
    const getISTDate = (date) =>
      new Date(date).toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

    const now = new Date();
    const today = getISTDate(now);

    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = getISTDate(yesterdayDate);

    // Fetch ALL vehicle returns (No company filter)
    const returns = await VehicleReturn.find({})
      .populate({
        path: "vehicle",
        select: "vehicleName vehicleNumber manufacturer model variant color",
      })
      .populate({
        path: "handover",
        // "payment" now included so payment.billSummary comes back too
        select: "customer trip payment",
        populate: {
          path: "customer",
          select: "fullName mobileNumber",
        },
      })
      .populate("receivedBy", "fullName")
      .sort({ createdAt: -1 });

    const stats = {
      total: returns.length,
      today: 0,
      yesterday: 0,
      due: 0,
    };

    const dashboard = returns.map((item) => {
      const returnDate = getISTDate(item.createdAt);

      let tab = "Older";

      if (returnDate === today) {
        tab = "Today";
        stats.today++;
      } else if (returnDate === yesterday) {
        tab = "Yesterday";
        stats.yesterday++;
      }

      // ---- Balance now comes ONLY from handover.payment.billSummary ----
      const billSummary = item.handover?.payment?.billSummary || {};

      const totalAmount = billSummary.totalAmount || 0;
      const amountReceivedNow = billSummary.amountReceivedNow || 0;
      const totalCollected = billSummary.totalCollected || 0;
      const balanceAmount = billSummary.balanceAmount || 0;

      const isDue = balanceAmount > 0;

      if (isDue) stats.due++;

      return {
        _id: item._id,
        handoverId: item.handover?._id,

        tab,
        isDue,

        customerName:
          item.customerName ||
          item.handover?.customer?.fullName ||
          "",

        mobileNumber:
          item.mobileNumber ||
          item.handover?.customer?.mobileNumber ||
          "",

        vehicleName: item.vehicle?.vehicleName || "",
        vehicleNumber: item.vehicle?.vehicleNumber || "",
        manufacturer: item.vehicle?.manufacturer || "",
        model: item.vehicle?.model || "",
        variant: item.vehicle?.variant || "",
        color: item.vehicle?.color || "",

        fuelLevel: item.fuelLevel ?? 0,
        kilometersAtReturn: item.kilometersAtReturn ?? 0,

        returnTime: item.receivingTime,
        scheduledReturnTime: item.scheduledReturnTime,

        timeStatus: item.timeStatus || "On Time",
        delayText: item.delayText || "",

        hasDamage: item.hasDamage || false,
        damageStatus: item.damageCostDetails?.status || "",
        repairEstimate:
          item.damageCostDetails?.repairEstimate || 0,

        // Balance / bill figures — sourced from handover.payment.billSummary
        billSummary,
        totalAmount,
        amountReceivedNow,
        totalCollected,
        pendingAmount: balanceAmount,
        totalBalance: totalAmount,
        amountCollected: totalCollected || amountReceivedNow,
        finalBalance: balanceAmount,
        settlementStatus: balanceAmount > 0 ? "pending" : "paid",

        receivedBy: item.receivedBy?.fullName || "",

        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    return res.status(200).json({
      success: true,
      stats,
      returns: dashboard,
    });
  } catch (error) {
    console.error("Vehicle Returns Dashboard Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch dashboard",
    });
  }
};