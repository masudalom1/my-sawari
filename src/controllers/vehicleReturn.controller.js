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

    /* ==========================
       VALIDATIONS
    ========================== */

    if (!fuelLevel || !kilometersAtReturn) {
      return res.status(400).json({
        success: false,
        message: "Fuel level and kilometers are required",
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
        message: "All vehicle images are required",
      });
    }

    /* ==========================
       FIND HANDOVER
    ========================== */

    const handover = await Handover.findOne({
      _id: handoverId,
      company: req.user.company || req.user._id,
      isDeleted: false,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    if (handover.handoverStatus === "returned") {
      return res.status(400).json({
        success: false,
        message: "Vehicle already received",
      });
    }

    /* ==========================
       FIND VEHICLE
    ========================== */

    const vehicle = await Vehicle.findById(
      handover.vehicle.vehicleId
    );

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
       CHECK EXISTING RETURN
    ========================== */

    const existingReturn =
      await VehicleReturn.findOne({
        handover: handoverId,
      });

    if (existingReturn) {
      return res.status(400).json({
        success: false,
        message: "Return already submitted",
      });
    }

    /* ==========================
       PARSE INSPECTION
    ========================== */

    let parsedInspection = [];

    if (inspection) {
      try {
        parsedInspection =
          typeof inspection === "string"
            ? JSON.parse(inspection)
            : inspection;
      } catch {
        parsedInspection = [];
      }
    }

    /* ==========================
       DAMAGE IMAGES
    ========================== */

    const damageImages =
      files.damageImages?.map(
        (file) => file.path
      ) || [];

    /* ==========================
       DAMAGE COST DETAILS
    ========================== */

    const isDamaged =
      hasDamage === true ||
      hasDamage === "true";

    const estimate =
      Number(repairEstimate) || 0;

    const collected =
      Number(amountCollected) || 0;

    let collectionStatus = "Pending";

    if (isDamaged) {
      if (collected > 0) {
        collectionStatus =
          collected >= estimate
            ? "Collected"
            : "Partially Collected";
      }
    }

    /* ==========================
       CREATE RETURN ENTRY
    ========================== */

    const vehicleReturn =
      await VehicleReturn.create({
        company:
          req.user.company ||
          req.user._id,

        createdBy: req.user._id,

        handover: handover._id,

        vehicle: vehicle._id,

        customerName:
          handover.customer.fullName,

        fuelLevel: Number(fuelLevel),

        kilometersAtReturn: Number(
          kilometersAtReturn
        ),

        hasDamage: isDamaged,

        damageNotes: damageNotes || "",

        inspection: parsedInspection,

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

        damageCostDetails: isDamaged
          ? {
              repairEstimate:
                estimate,

              repairDays:
                Number(repairDays) ||
                0,

              amountCollected:
                collected,

              paymentMode:
                paymentMode ||
                "Cash",

              status:
                collectionStatus,
            }
          : undefined,
      });

    /* ==========================
       UPDATE VEHICLE STATUS
    ========================== */

    vehicle.status = "available";

    await vehicle.save();

    /* ==========================
       UPDATE HANDOVER STATUS
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