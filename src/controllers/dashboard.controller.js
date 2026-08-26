import mongoose from "mongoose";
import Maintenance from "../models/maintenance.model.js";
import Vehicle from "../models/vehicle.model.js";
import Booking from "../models/booking.model.js";

export const getVehiclesForImport = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({
      isDeleted: false,
    })
      .select(
        "_id vehicleName vehicleNumber vehicleType images status pricePerDay",
      )
      .sort({ pricePerDay: 1 })
      .lean();

    const formattedVehicles = vehicles.map((vehicle) => ({
      _id: vehicle._id,
      vehicleName: vehicle.vehicleName,
      vehicleNumber: vehicle.vehicleNumber,
      vehicleType: vehicle.vehicleType,
      image: vehicle.images?.[0]?.url || null,
      status: vehicle.status,
      pricePerDay: vehicle.pricePerDay || 0,
    }));

    return res.status(200).json({
      success: true,
      count: formattedVehicles.length,
      vehicles: formattedVehicles,
    });
  } catch (error) {
    console.error("Get vehicles for import error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch vehicle details",
      error: error.message,
    });
  }
};

export const getBookingsForImport = async (req, res) => {
  try {
    const bookings = await Booking.find({
      isDeleted: false,
      status: {
        $ne: "cancelled",
      },
    })
      .select(
        `
        _id
        bookingCode
        customerName
        mobileNumber
        alternateMobileNumber
        destination
        fromDate
        toDate
        pickupTime
        dropTime
        totalDays
        vehicleId
        vehicleName
        vehicleNumber
        status
        pickup
        drop
        payment
      `,
      )
      .populate({
        path: "vehicleId",
        select: "_id vehicleName vehicleNumber vehicleType images status",
      })
      .sort({ fromDate: 1 })
      .lean();

    const formattedBookings = bookings.map((booking) => ({
      _id: booking._id,
      bookingCode: booking.bookingCode,

      customerName: booking.customerName,
      mobileNumber: booking.mobileNumber,

      destination: booking.destination,

      fromDate: booking.fromDate,
      toDate: booking.toDate,

      pickupTime: booking.pickupTime,
      dropTime: booking.dropTime,

      totalDays: booking.totalDays,

      vehicleId: booking.vehicleId?._id || booking.vehicleId,
      vehicleName: booking.vehicleId?.vehicleName || booking.vehicleName || "",
      vehicleNumber:
        booking.vehicleId?.vehicleNumber || booking.vehicleNumber || "",

      status: booking.status,

      pickup: booking.pickup,
      drop: booking.drop,

      payment: booking.payment,
    }));

    return res.status(200).json({
      success: true,
      count: formattedBookings.length,
      bookings: formattedBookings,
    });
  } catch (error) {
    console.error("Get bookings for import error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch booking details",
      error: error.message,
    });
  }
};
export const createMaintenance = async (req, res, next) => {
  try {
    const { vehicle, startDate, endDate } = req.body;

    // ---------------------------------------
    // Validate required fields
    // ---------------------------------------
    if (!vehicle) {
      return res.status(400).json({
        success: false,
        message: "Vehicle is required",
      });
    }

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: "Maintenance start date is required",
      });
    }

    if (!endDate) {
      return res.status(400).json({
        success: false,
        message: "Maintenance end date is required",
      });
    }

    // ---------------------------------------
    // Validate vehicle ObjectId
    // ---------------------------------------
    if (!mongoose.Types.ObjectId.isValid(vehicle)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vehicle ID",
      });
    }

    // ---------------------------------------
    // Validate dates
    // ---------------------------------------
    const maintenanceStart = new Date(startDate);
    const maintenanceEnd = new Date(endDate);

    if (Number.isNaN(maintenanceStart.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid maintenance start date",
      });
    }

    if (Number.isNaN(maintenanceEnd.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid maintenance end date",
      });
    }

    if (maintenanceEnd <= maintenanceStart) {
      return res.status(400).json({
        success: false,
        message: "Maintenance end date must be after start date",
      });
    }

    // ---------------------------------------
    // Check vehicle exists
    // ---------------------------------------
    const existingVehicle = await Vehicle.findById(vehicle);

    if (!existingVehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    // ---------------------------------------
    // Check overlapping maintenance
    // ---------------------------------------
    const overlappingMaintenance = await Maintenance.findOne({
      vehicle,
      isDeleted: { $ne: true },

      status: {
        $nin: ["Cancelled", "Completed"],
      },

      startDate: {
        $lt: maintenanceEnd,
      },

      endDate: {
        $gt: maintenanceStart,
      },
    }).lean();

    if (overlappingMaintenance) {
      return res.status(409).json({
        success: false,
        message: "Vehicle already has maintenance during this period",
        data: {
          maintenanceId: overlappingMaintenance._id,
          startDate: overlappingMaintenance.startDate,
          endDate: overlappingMaintenance.endDate,
          status: overlappingMaintenance.status,
        },
      });
    }

    // ---------------------------------------
    // Create maintenance
    // ---------------------------------------
    const maintenance = await Maintenance.create({
      vehicle,
      startDate: maintenanceStart,
      endDate: maintenanceEnd,
      status: "Scheduled",
    });

    // ---------------------------------------
    // Update vehicle status
    // ---------------------------------------
    await Vehicle.findByIdAndUpdate(
      vehicle,
      {
        $set: {
          status: "service",
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    // ---------------------------------------
    // Get populated maintenance
    // ---------------------------------------
    const populatedMaintenance = await Maintenance.findById(
      maintenance._id,
    )
      .populate("vehicle")
      .lean();

    // ---------------------------------------
    // Success
    // ---------------------------------------
    return res.status(201).json({
      success: true,
      message: "Maintenance created successfully",
      data: populatedMaintenance,
    });
  } catch (error) {
    console.error("CREATE MAINTENANCE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create maintenance",
    });
  }
};
export const getMaintenances = async (req, res, next) => {
  try {
    const { vehicle, startDate, endDate, status } = req.query;

    const filter = {
      isDeleted: false,
    };

    if (vehicle) {
      filter.vehicle = vehicle;
    }

    if (status) {
      filter.status = status;
    }

    // Optional date filtering
    if (startDate || endDate) {
      filter.startDate = {};

      if (startDate) {
        filter.startDate.$gte = new Date(startDate);
      }

      if (endDate) {
        filter.endDate = {
          $lte: new Date(endDate),
        };
      }
    }

    const maintenances = await Maintenance.find(filter)
      .populate("vehicle")
      .populate("createdBy", "name email")
      .sort({ startDate: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Maintenance records fetched successfully",
      count: maintenances.length,
      data: maintenances,
    });
  } catch (error) {
    next(error);
  }
};
