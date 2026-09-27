import mongoose from "mongoose";
import Maintenance from "../models/maintenance.model.js";
import Vehicle from "../models/vehicle.model.js";
import Booking from "../models/booking.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";

export const getVehiclesForImport = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({
      isDeleted: false,
    })
      .select(
        "_id vehicleName vehicleNumber vehicleType category images status pricePerDay",
      )
      .sort({ pricePerDay: 1 })
      .lean();

    const formattedVehicles = vehicles.map((vehicle) => ({
      _id: vehicle._id,
      vehicleName: vehicle.vehicleName,
      vehicleNumber: vehicle.vehicleNumber,
      vehicleType: vehicle.vehicleType,

      // Optional field
      category: vehicle.category || null,

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
export const getPaymentsForImport = async (req, res) => {
  try {
    const { from, to } = req.query;
 
    // ---------------------------------------
    // Step 1: are there any payments at all?
    // ---------------------------------------
    const anyPayment = await PaymentHistory.exists({});
 
    if (!anyPayment) {
      return res.status(200).json({
        success: true,
        hasPayments: false,
        message: "No payments have been recorded yet",
        count: 0,
        payments: [],
      });
    }
 
    // ---------------------------------------
    // Step 2: active vehicles and the payment ids they point to
    // ---------------------------------------
    const vehicles = await Vehicle.find({ isDeleted: false })
      .select("_id payments")
      .lean();
 
    if (vehicles.length === 0) {
      return res.status(200).json({
        success: true,
        hasPayments: false,
        message: "No active vehicles found",
        count: 0,
        payments: [],
      });
    }
 
    const activeVehicleIds = vehicles.map((v) => v._id);
    const activeVehicleSet = new Set(activeVehicleIds.map(String));
 
    const paymentToVehicle = new Map();
    const linkedPaymentIds = [];
 
    for (const vehicle of vehicles) {
      for (const paymentId of vehicle.payments || []) {
        paymentToVehicle.set(String(paymentId), String(vehicle._id));
        linkedPaymentIds.push(paymentId);
      }
    }
 
    // ---------------------------------------
    // Step 3: build the filter
    // ---------------------------------------
    const filter = {
      $or: [
        ...(linkedPaymentIds.length ? [{ _id: { $in: linkedPaymentIds } }] : []),
        { "vehicle.vehicleId": { $in: activeVehicleIds } },
      ],
    };
 
    if (from || to) {
      filter.createdAt = {};
 
      if (from) {
        const fromDate = new Date(`${from}T00:00:00.000+05:30`);
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({ success: false, message: "Invalid 'from' date. Use YYYY-MM-DD." });
        }
        filter.createdAt.$gte = fromDate;
      }
 
      if (to) {
        const toDate = new Date(`${to}T23:59:59.999+05:30`);
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({ success: false, message: "Invalid 'to' date. Use YYYY-MM-DD." });
        }
        filter.createdAt.$lte = toDate;
      }
    }
 
    // ---------------------------------------
    // Step 4: fetch
    // ---------------------------------------
    const payments = await PaymentHistory.find(filter)
      .select(
        `
        _id
        amount
        type
        paymentMethod
        paymentBreakdown
        upiLast4
        isCollected
        collectedAmount
        collectedPhonePe
        collectionHistory.amount
        collectionHistory.channel
        bookingId
        booking
        customer
        vehicle
        note
        createdAt
      `,
      )
      .sort({ createdAt: 1 })
      .lean();
 
    const formattedPayments = [];
    let unlinkedCount = 0;
 
    for (const payment of payments) {
      const snapshotVehicleId = payment.vehicle?.vehicleId ? String(payment.vehicle.vehicleId) : null;
      const linkedVehicleId = paymentToVehicle.get(String(payment._id));
 
      const vehicleId =
        linkedVehicleId ||
        (snapshotVehicleId && activeVehicleSet.has(snapshotVehicleId) ? snapshotVehicleId : null);
 
      if (!vehicleId) continue;
      if (!linkedVehicleId) unlinkedCount++;
 
      const breakdown = {
        cash: Number(payment.paymentBreakdown?.cash) || 0,
        phonePe: Number(payment.paymentBreakdown?.phonePe) || 0,
        razorpay: Number(payment.paymentBreakdown?.razorpay) || 0,
      };
      const breakdownTotal = breakdown.cash + breakdown.phonePe + breakdown.razorpay;
      const amount = Number(payment.amount) || 0;
 
      formattedPayments.push({
        _id: payment._id,
        vehicleId,
 
        // snapshot of the vehicle at the time of payment
        vehicle: {
          vehicleName: payment.vehicle?.vehicleName || "",
          vehicleNumber: payment.vehicle?.vehicleNumber || "",
        },
 
        // Mixed payments sometimes store only the breakdown; fall back to its total.
        amount: amount > 0 ? amount : breakdownTotal,
        type: payment.type,
        paymentMethod: payment.paymentMethod || "cash",
        paymentBreakdown: breakdown,
        upiLast4: payment.upiLast4 || [],
 
        isCollected: !!payment.isCollected,
        collectedAmount: payment.collectedAmount || 0,
        collectedPhonePe: payment.collectedPhonePe || 0,
        collectionHistory: payment.collectionHistory || [],
 
        bookingId: payment.bookingId || null,
        booking: {
          fromDate: payment.booking?.fromDate || null,
          toDate: payment.booking?.toDate || null,
          bookingAmount: payment.booking?.bookingAmount || 0,
        },
 
        customer: {
          fullName: payment.customer?.fullName || "",
          mobileNumber: payment.customer?.mobileNumber || "",
        },
 
        note: payment.note || "",
        createdAt: payment.createdAt,
      });
    }
 
    if (unlinkedCount > 0) {
      console.warn(
        `getPaymentsForImport: ${unlinkedCount} payment(s) found only via vehicle snapshot — ` +
          "their ids are missing from vehicle.payments. Push the id when creating these payments.",
      );
    }
 
    return res.status(200).json({
      success: true,
      hasPayments: formattedPayments.length > 0,
      message:
        formattedPayments.length === 0
          ? from || to
            ? "No payments in the selected date range"
            : "Payments exist, but none belong to an active vehicle"
          : "Payments fetched successfully",
      count: formattedPayments.length,
      unlinkedCount,
      payments: formattedPayments,
    });
  } catch (error) {
    console.error("Get payments for import error:", error);
 
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment details",
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
