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
    } = req.body;

    const files = req.files || {};

    // validations
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

    if (handover.handoverStatus === "completed") {
      return res.status(400).json({
        success: false,
        message: "Vehicle already received",
      });
    }

    const vehicle = await Vehicle.findById(
      handover.vehicle.vehicleId
    );

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    // must be rented
    if (vehicle.status !== "rent") {
      return res.status(400).json({
        success: false,
        message: "Vehicle is not currently on rent",
      });
    }

    const existingReturn = await VehicleReturn.findOne({
      handover: handoverId,
    });

    if (existingReturn) {
      return res.status(400).json({
        success: false,
        message: "Return already submitted",
      });
    }

    let parsedInspection = [];

    if (inspection) {
      try {
        parsedInspection = JSON.parse(inspection);
      } catch {
        parsedInspection = [];
      }
    }

    const vehicleReturn = await VehicleReturn.create({
      company: req.user.company || req.user._id,
      createdBy: req.user._id,

      handover: handover._id,
      vehicle: vehicle._id,

      customerName: handover.customer.fullName,

      fuelLevel: Number(fuelLevel),
      kilometersAtReturn: Number(kilometersAtReturn),

      hasDamage:
        hasDamage === true ||
        hasDamage === "true",

      damageNotes: damageNotes || "",

      inspection: parsedInspection,

      images: {
        vehicleFront:
          files.vehicleFront?.[0]?.path || "",
        vehicleRear:
          files.vehicleRear?.[0]?.path || "",
        vehicleLeft:
          files.vehicleLeft?.[0]?.path || "",
        vehicleRight:
          files.vehicleRight?.[0]?.path || "",
        damageImage:
          files.damageImage?.[0]?.path || "",
      },
    });

    // AVAILABLE AGAIN
    vehicle.status = "available";
    await vehicle.save();

    // COMPLETE HANDOVER
   handover.handoverStatus = "returned";
    await handover.save();

    res.status(201).json({
      success: true,
      message: "Vehicle received successfully",
      data: vehicleReturn,
    });
  } catch (error) {
    console.log("RECEIVE VEHICLE ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};