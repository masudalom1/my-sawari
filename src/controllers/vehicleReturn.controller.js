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
      amountCollected,
      paymentMode,
    } = req.body;

    const files = req.files || {};

    const companyId =
      req.user.company || req.user._id;

    /* ==========================
       BASIC VALIDATION
    ========================== */

    if (!fuelLevel || !kilometersAtReturn) {
      return res.status(400).json({
        success: false,
        message:
          "Fuel level and kilometers at return are required",
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
        message:
          "Front, Rear, Left and Right vehicle images are required",
      });
    }

    /* ==========================
       FIND HANDOVER
    ========================== */

    const handover =
      await Handover.findOne({
        _id: handoverId,
        company: companyId,
        isDeleted: false,
      });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    if (
      handover.handoverStatus ===
      "returned"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Vehicle already received",
      });
    }

    /* ==========================
       FIND VEHICLE
    ========================== */

    const vehicleId =
      handover.vehicle?.vehicleId ||
      handover.vehicle;

    const vehicle =
      await Vehicle.findById(vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    if (vehicle.status !== "rent") {
      return res.status(400).json({
        success: false,
        message:
          "Vehicle is not currently on rent",
      });
    }

    /* ==========================
       EXISTING RETURN CHECK
    ========================== */

    const existingReturn =
      await VehicleReturn.findOne({
        handover: handoverId,
      });

    if (existingReturn) {
      return res.status(400).json({
        success: false,
        message:
          "Return already submitted",
      });
    }

    /* ==========================
       INSPECTION PARSE
    ========================== */

    let parsedInspection = [];

    try {
      if (inspection) {
        parsedInspection =
          typeof inspection ===
          "string"
            ? JSON.parse(inspection)
            : inspection;
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid inspection data format",
      });
    }

    /* ==========================
       DAMAGE DATA
    ========================== */

    const isDamaged =
      hasDamage === true ||
      hasDamage === "true";

    const damageImages =
      files.damageImages?.map(
        (file) => file.path
      ) || [];

    if (
      isDamaged &&
      damageImages.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Damage images are required when damage is reported",
      });
    }

    const estimate =
      Number(repairEstimate) || 0;

    const collected =
      Number(amountCollected) || 0;

    const days =
      Number(repairDays) || 0;

    const balanceAmount =
      Math.max(
        estimate - collected,
        0
      );

    let collectionStatus =
      "Pending Collection";

    if (estimate > 0) {
      if (collected >= estimate) {
        collectionStatus =
          "Collected";
      } else if (collected > 0) {
        collectionStatus =
          "Partially Collected";
      }
    }

    /* ==========================
       CREATE RETURN
    ========================== */

    const vehicleReturn =
      await VehicleReturn.create({
        company: companyId,

        createdBy: req.user._id,

        handover: handover._id,

        vehicle: vehicle._id,

        customerName:
          handover.customer?.fullName ||
          "",

        fuelLevel:
          Number(fuelLevel),

        kilometersAtReturn:
          Number(
            kilometersAtReturn
          ),

        hasDamage: isDamaged,

        damageNotes:
          damageNotes || "",

        inspection:
          parsedInspection,

        images: {
          vehicleFront:
            files.vehicleFront?.[0]
              ?.path || "",

          vehicleRear:
            files.vehicleRear?.[0]
              ?.path || "",

          vehicleLeft:
            files.vehicleLeft?.[0]
              ?.path || "",

          vehicleRight:
            files.vehicleRight?.[0]
              ?.path || "",
        },

        damageImages,

        damageCostDetails:
          isDamaged
            ? {
                repairEstimate:
                  estimate,

                repairDays:
                  days,

                amountCollected:
                  collected,

                balanceAmount,

                paymentMode:
                  paymentMode ||
                  "Cash",

                status:
                  collectionStatus,
              }
            : undefined,
      });

    /* ==========================
       UPDATE VEHICLE
    ========================== */

    vehicle.status = "available";

    await vehicle.save();

    /* ==========================
       UPDATE HANDOVER
    ========================== */

    handover.handoverStatus =
      "returned";

    await handover.save();

    /* ==========================
       RESPONSE
    ========================== */

    return res.status(201).json({
      success: true,
      message:
        "Vehicle received successfully",
      data: vehicleReturn,
    });
  } catch (error) {
    console.error(
      "RECEIVE VEHICLE ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        "Internal Server Error",
    });
  }
};