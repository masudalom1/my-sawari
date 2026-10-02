import mongoose from "mongoose";
import Maintenance from "../models/maintenance.model.js";
import Vehicle from "../models/vehicle.model.js";
import Booking from "../models/booking.model.js";
import PaymentHistory, {
  toBookingMonth,
} from "../models/paymentHistory.model.js";
import Handover from "../models/handover.model.js";
import VehicleReturn from "../models/vehicleReturn.model.js";
import {
  parseRevenueRange,
  daysBetweenKeys,
  emptyRevenueTotals,
  finalizeRevenueTotals,
  sumRevenueTotals,
  applyPayments,
  applyBookings,
  applyFleetDays,
  toRevenueRow,
} from "../utils/revenue.utils.js";

import {
  loadRevenueVehicles,
  loadRevenuePayments,
  loadRevenueBookings,
  loadRevenueServiceDays,
} from "../services/revenue.service.js";

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
        ...(linkedPaymentIds.length
          ? [{ _id: { $in: linkedPaymentIds } }]
          : []),
        { "vehicle.vehicleId": { $in: activeVehicleIds } },
      ],
    };

    if (from || to) {
      filter.createdAt = {};

      if (from) {
        const fromDate = new Date(`${from}T00:00:00.000+05:30`);
        if (Number.isNaN(fromDate.getTime())) {
          return res
            .status(400)
            .json({
              success: false,
              message: "Invalid 'from' date. Use YYYY-MM-DD.",
            });
        }
        filter.createdAt.$gte = fromDate;
      }

      if (to) {
        const toDate = new Date(`${to}T23:59:59.999+05:30`);
        if (Number.isNaN(toDate.getTime())) {
          return res
            .status(400)
            .json({
              success: false,
              message: "Invalid 'to' date. Use YYYY-MM-DD.",
            });
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
      const snapshotVehicleId = payment.vehicle?.vehicleId
        ? String(payment.vehicle.vehicleId)
        : null;
      const linkedVehicleId = paymentToVehicle.get(String(payment._id));

      const vehicleId =
        linkedVehicleId ||
        (snapshotVehicleId && activeVehicleSet.has(snapshotVehicleId)
          ? snapshotVehicleId
          : null);

      if (!vehicleId) continue;
      if (!linkedVehicleId) unlinkedCount++;

      const breakdown = {
        cash: Number(payment.paymentBreakdown?.cash) || 0,
        phonePe: Number(payment.paymentBreakdown?.phonePe) || 0,
        razorpay: Number(payment.paymentBreakdown?.razorpay) || 0,
      };
      const breakdownTotal =
        breakdown.cash + breakdown.phonePe + breakdown.razorpay;
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
    const populatedMaintenance = await Maintenance.findById(maintenance._id)
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

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+05:30
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const BUSINESS_DAY_START_HOUR = 8;
const OVERDUE_GRACE_HOURS = 24;

const HANDED_OVER_STATUSES = ["vehicle_handover", "active"];

// Same fallback the frontend uses for legacy vehicles with no category.
const BIKE_KEYWORDS = [
  "hunter",
  "avenis",
  "ntorq",
  "activa",
  "splendor",
  "pulsar",
  "classic",
  "scooty",
  "jupiter",
];

function resolveCategory(vehicle) {
  if (vehicle.category === "car" || vehicle.category === "bike") {
    return vehicle.category;
  }
  const name = (vehicle.vehicleName || "").toLowerCase();
  return BIKE_KEYWORDS.some((k) => name.includes(k)) ? "bike" : "car";
}

// Calendar parts of a Date as seen in IST (works whatever TZ the server uses).
function getISTParts(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

// Real Date for an IST wall-clock time.
function makeISTDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MS);
}

// Accepts "09:00 AM", "9:00am", "14:30".
function parseTimeString(value) {
  if (!value || typeof value !== "string") return null;
  const text = value.trim();

  let match = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = match[3].toUpperCase();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return { hour, minute };
  }

  match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  return null;
}

// fromDate/toDate carry the day, pickupTime/dropTime carry the time.
function combineISTDateAndTime(dateValue, timeValue, fallback) {
  const base = new Date(dateValue);
  if (Number.isNaN(base.getTime())) return null;
  const { year, month, day } = getISTParts(base);
  const time = parseTimeString(timeValue) || fallback;
  return makeISTDate(year, month, day, time.hour, time.minute);
}

// Today's business window in IST. Before 8 AM we are still in yesterday's
// business day. Optional ?date=YYYY-MM-DD picks a specific day.
function getBusinessDayWindow(dateParam, now) {
  let start;

  if (dateParam) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateParam);
    if (!match) return null;
    start = makeISTDate(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      BUSINESS_DAY_START_HOUR,
    );
  } else {
    const p = getISTParts(now);
    const day = p.hour < BUSINESS_DAY_START_HOUR ? p.day - 1 : p.day;
    start = makeISTDate(p.year, p.month, day, BUSINESS_DAY_START_HOUR);
  }

  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export const getDashboardStats = async (req, res) => {
  try {
    const now = new Date();
    const window = getBusinessDayWindow(req.query.date, now);

    if (!window) {
      return res.status(400).json({
        success: false,
        message: "Invalid 'date'. Use YYYY-MM-DD.",
      });
    }

    const { start: dayStart, end: dayEnd } = window;
    const overdueCutoff = new Date(
      now.getTime() - OVERDUE_GRACE_HOURS * HOUR_MS,
    );

    // -----------------------------------
    // 1. Vehicles (source of truth for total + service)
    // -----------------------------------
    const vehicles = await Vehicle.find({ isDeleted: false })
      .select(
        "_id vehicleName category status maintenance.reason maintenance.estimatedCompletionDate",
      )
      .lean();

    const allIds = vehicles.map((v) => String(v._id));
    const vehicleIdSet = new Set(allIds);
    const categoryById = new Map(
      vehicles.map((v) => [String(v._id), resolveCategory(v)]),
    );

    const serviceSet = new Set(
      vehicles.filter((v) => v.status === "service").map((v) => String(v._id)),
    );

    // Extra info shown in the "In Maintenance" hover list
    const serviceDetails = {};
    for (const v of vehicles) {
      if (v.status !== "service") continue;
      serviceDetails[String(v._id)] = {
        reason: v.maintenance?.reason || "",
        estimatedCompletionDate: v.maintenance?.estimatedCompletionDate || null,
      };
    }

    // -----------------------------------
    // 2. Only bookings whose dates can touch today or "now".
    //    2-day padding because the exact times live in pickupTime/dropTime
    //    strings — the precise check happens in JS below.
    // -----------------------------------
    const PAD_MS = 2 * DAY_MS;
    const earliest = Math.min(dayStart.getTime(), overdueCutoff.getTime());
    const latest = Math.max(dayEnd.getTime(), now.getTime());

    const bookings = await Booking.find({
      isDeleted: false,
      status: { $ne: "cancelled" },
      vehicleId: { $in: vehicles.map((v) => v._id) },
      fromDate: { $lt: new Date(latest + PAD_MS) },
      toDate: { $gt: new Date(earliest - PAD_MS) },
    })
      .select(
        "_id bookingCode customerName mobileNumber vehicleId fromDate toDate pickupTime dropTime status",
      )
      .lean();

    const bookedSet = new Set();
    const onRentSet = new Set();

    // One "most relevant" booking per vehicle for the hover lists.
    // Priority: on rent now > not yet completed (earliest first) > completed.
    const bookingDetails = {};
    const rememberBooking = (vid, booking, start, end, onRent) => {
      const detail = {
        bookingId: String(booking._id),
        bookingCode: booking.bookingCode || "",
        customerName: booking.customerName || "",
        mobileNumber: booking.mobileNumber || "",
        start,
        end,
        status: booking.status,
        onRent,
      };

      const existing = bookingDetails[vid];
      if (!existing) {
        bookingDetails[vid] = detail;
        return;
      }
      if (existing.onRent) return;
      if (onRent) {
        bookingDetails[vid] = detail;
        return;
      }

      const existingDone = existing.status === "completed";
      const newDone = booking.status === "completed";
      if (existingDone && !newDone) {
        bookingDetails[vid] = detail;
        return;
      }
      if (!existingDone && newDone) return;
      if (start < existing.start) bookingDetails[vid] = detail;
    };

    for (const booking of bookings) {
      const vid = String(booking.vehicleId);
      if (!vehicleIdSet.has(vid)) continue;
      if (serviceSet.has(vid)) continue; // service wins over bookings

      const start = combineISTDateAndTime(
        booking.fromDate,
        booking.pickupTime,
        {
          hour: 0,
          minute: 0,
        },
      );
      const end = combineISTDateAndTime(booking.toDate, booking.dropTime, {
        hour: 23,
        minute: 59,
      });
      if (!start || !end || end <= start) continue;

      // Booked today: any non-cancelled booking inside today's window
      // (a booking completed earlier today still counts as booked today).
      const overlapsToday = start < dayEnd && end > dayStart;

      // On rent now: not completed, and running right now or a recent
      // late return that was actually handed over.
      let isOnRentNow = false;
      if (booking.status !== "completed") {
        const runningNow = start <= now && end > now;
        const lateReturn =
          HANDED_OVER_STATUSES.includes(booking.status) &&
          end <= now &&
          end > overdueCutoff;
        isOnRentNow = runningNow || lateReturn;
      }

      if (isOnRentNow) onRentSet.add(vid);
      if (overlapsToday || isOnRentNow) {
        bookedSet.add(vid); // a vehicle that is out is booked today
        rememberBooking(vid, booking, start, end, isOnRentNow);
      }
    }

    // -----------------------------------
    // 3. Unbooked = not booked and not in service
    // -----------------------------------
    const unbookedIds = allIds.filter(
      (id) => !bookedSet.has(id) && !serviceSet.has(id),
    );

    // -----------------------------------
    // 4. Diagnostics: bookings still marked handed over whose drop date is
    //    long past. These are what inflated "On Rent" before — mark them
    //    completed to clean the data.
    // -----------------------------------
    const staleActiveBookings = await Booking.countDocuments({
      isDeleted: false,
      status: { $in: HANDED_OVER_STATUSES },
      toDate: { $lt: new Date(overdueCutoff.getTime() - DAY_MS) },
    });

    const byCategory = (ids) => {
      const out = { car: 0, bike: 0 };
      for (const id of ids) out[categoryById.get(id)]++;
      return out;
    };

    return res.status(200).json({
      success: true,
      window: {
        start: dayStart,
        end: dayEnd,
        timezone: "Asia/Kolkata",
        businessDayStartHour: BUSINESS_DAY_START_HOUR,
      },
      stats: {
        totalVehicles: allIds.length,
        bookedToday: bookedSet.size,
        unbookedToday: unbookedIds.length,
        onRentToday: onRentSet.size,
        maintenanceToday: serviceSet.size,
      },
      breakdown: {
        totalVehicles: byCategory(allIds),
        bookedToday: byCategory(bookedSet),
        unbookedToday: byCategory(unbookedIds),
        onRentToday: byCategory(onRentSet),
        maintenanceToday: byCategory(serviceSet),
      },
      vehicleIds: {
        booked: [...bookedSet],
        unbooked: unbookedIds,
        onRent: [...onRentSet],
        maintenance: [...serviceSet],
      },
      // Per-vehicle details for the card hover lists
      bookingDetails,
      serviceDetails,
      diagnostics: {
        bookingsChecked: bookings.length,
        staleActiveBookings,
      },
    });
  } catch (error) {
    console.error("Get dashboard stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard stats",
      error: error.message,
    });
  }
};

export const getVehicleRevenue = async (req, res) => {
  try {
    // ---------------------------------------
    // Step 1: validate the range
    // ---------------------------------------
    const range = parseRevenueRange(req.query);
    if (range.error) {
      return res.status(400).json({ success: false, message: range.error });
    }
    const { from, to, today, excludeService } = range;

    // ---------------------------------------
    // Step 2: vehicles. Only ones with a price per day have a target.
    // ---------------------------------------
    const allVehicles = await loadRevenueVehicles();
    const rated = allVehicles.filter((v) => Number(v.pricePerDay) > 0);
    const ratedIds = rated.map((v) => v._id);
    const stats = new Map(
      rated.map((v) => [String(v._id), emptyRevenueTotals()]),
    );

    // ---------------------------------------
    // Step 3: only the records that touch the range
    // ---------------------------------------
    const [payments, bookings, serviceDays] = await Promise.all([
      loadRevenuePayments(allVehicles, from, to),
      loadRevenueBookings(ratedIds, from, to),
      loadRevenueServiceDays(ratedIds, from, to),
    ]);

    // ---------------------------------------
    // Step 4: add everything up
    // ---------------------------------------
    applyPayments(stats, payments, range);
    applyBookings(stats, bookings, range);
    applyFleetDays(stats, rated, serviceDays, range);

    // ---------------------------------------
    // Step 5: response
    // ---------------------------------------
    const vehicles = rated
      .map((v) => toRevenueRow(v, stats.get(String(v._id))))
      .sort((a, b) => b.net - a.net);

    return res.status(200).json({
      success: true,
      count: vehicles.length,
      generatedAt: new Date(),
      range: { from, to, today, days: daysBetweenKeys(from, to) + 1 },
      excludeService,
      totals: finalizeRevenueTotals(sumRevenueTotals(stats)),
      unratedCount: allVehicles.length - rated.length,
      vehicles,
    });
  } catch (error) {
    console.error("Get vehicle revenue error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to build revenue by vehicle",
      error: error.message,
    });
  }
};

// ============================================================
// ============================================================
// BOOKING REVENUE DASHBOARD
//
// Source: PaymentHistory only, and only payments with type "booking"
// (the advance taken when a booking is created). Handover, rental,
// extension, additional_charge, receive and refund payments are ignored.
// The Booking collection is not read at all.
//
// Two views (the "tab" on the frontend):
//
//   basis=booking  (default)   ?month=YYYY-MM
//     A payment belongs to its booking month:
//       payment.bookingMonth
//       -> else month of payment.booking.fromDate
//     e.g. advance paid 30 Sep for a 02-05 Oct trip => October.
//     Payments with neither are "unassigned": they are counted in the
//     all-time totals and reported, but never guessed into a month.
//
//   basis=created              ?range=today | 7d | month
//     Booking payments made in that window (payment createdAt, IST),
//     whatever month the trip is in. Compared with the same elapsed
//     time of the previous period.
//
// Counts:
//   bookings = distinct bookingId among the booking payments
//   summary  = fixed quick numbers, independent of the selected tab:
//                today      -> advances paid today (created date, IST)
//                last7Days  -> advances paid in the last 7 days (created date)
//                thisMonth  -> booking month = current month
//                nextMonth  -> booking month = next month
//   allTime  = every booking payment ever, for the company
// ============================================================
// ============================================================

const PR_PAYMENT_TYPE = "booking";
const PR_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const PR_BASES = ["booking", "created"];
const PR_RANGES = ["today", "7d", "month"];
const PR_PAYMENT_METHODS = ["cash", "phonepe", "razorpay", "mixed"];
const PR_IST_TZ = "+05:30";

const prPad = (n) => String(n).padStart(2, "0");

function prMonthKey(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${prPad(d.getUTCMonth() + 1)}`;
}

function prCurrentMonth(now) {
  const p = getISTParts(now);
  return prMonthKey(p.year, p.month);
}

function prPreviousMonth(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return prMonthKey(y, m - 2);
}

function prYearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => prMonthKey(year, i));
}

// UTC span covering all months (trip dates are stored at UTC midnight).
function prMonthsUTCSpan(months) {
  const starts = months.map((m) => {
    const [y, mo] = m.split("-").map(Number);
    return Date.UTC(y, mo - 1, 1);
  });
  const ends = months.map((m) => {
    const [y, mo] = m.split("-").map(Number);
    return Date.UTC(y, mo, 1);
  });
  return {
    start: new Date(Math.min(...starts)),
    end: new Date(Math.max(...ends)),
  };
}

function prISTDayKey(date) {
  const p = getISTParts(date);
  return `${p.year}-${prPad(p.month + 1)}-${prPad(p.day)}`;
}

function prGrowth(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function prPct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function prEscapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------
// QUERY
// ------------------------------------------------------------

// Returns { params } or { error }.
function parseBookingRevenueQuery(query = {}, now = new Date()) {
  const basis = query.basis ? String(query.basis).trim() : "booking";
  if (!PR_BASES.includes(basis)) {
    return { error: "basis must be 'booking' or 'created'." };
  }

  const range = query.range ? String(query.range).trim() : "month";
  if (!PR_RANGES.includes(range)) {
    return { error: "range must be 'today', '7d' or 'month'." };
  }

  const month = query.month ? String(query.month).trim() : prCurrentMonth(now);
  if (!PR_MONTH_REGEX.test(month)) {
    return { error: "month must be in YYYY-MM format." };
  }

  const method = query.method ? String(query.method).trim() : null;
  if (method && !PR_PAYMENT_METHODS.includes(method)) {
    return {
      error: `method must be one of: ${PR_PAYMENT_METHODS.join(", ")}.`,
    };
  }

  const defaultYear =
    basis === "booking" ? Number(month.slice(0, 4)) : getISTParts(now).year;
  const year = Number(query.year) || defaultYear;

  if (year < 2000 || year > 2100) {
    return { error: "Invalid year." };
  }

  return {
    params: {
      basis,
      range,
      month,
      year,
      method,
      page: Math.max(1, Number(query.page) || 1),
      limit: Math.min(100, Math.max(1, Number(query.limit) || 20)),
      search: query.search ? String(query.search).trim() : null,
    },
  };
}

// ------------------------------------------------------------
// PERIODS
// ------------------------------------------------------------

// basis=booking: by resolved booking month of each payment.
function prBookingMonthPeriod({ month, year }) {
  const previousMonth = prPreviousMonth(month);
  const months = prYearMonths(year);
  const allMonths = [...new Set([month, previousMonth, ...months])];
  const { start, end } = prMonthsUTCSpan(allMonths);

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  return {
    prefilter: {
      $or: [
        { bookingMonth: { $in: allMonths } },
        { "booking.fromDate": { $gte: start, $lt: end } },
      ],
    },
    scope: { resolvedMonth: { $in: allMonths } },
    current: { resolvedMonth: month },
    previous: { resolvedMonth: previousMonth },
    trend: {
      granularity: "day",
      groupedBy: "trip start date",
      // Trip start day; null when the payment has no fromDate (shown separately).
      keyExpr: {
        $dateToString: {
          format: "%Y-%m-%d",
          date: "$booking.fromDate",
          timezone: "UTC",
        },
      },
      buckets: Array.from(
        { length: daysInMonth },
        (_, i) => `${month}-${prPad(i + 1)}`,
      ),
    },
    yearly: {
      months,
      match: { resolvedMonth: { $in: months } },
      keyExpr: "$resolvedMonth",
    },
    meta: { month, previousMonth },
  };
}

// basis=created: by payment createdAt in IST.
function prCreatedPeriod({ range, year }, now) {
  const p = getISTParts(now);

  let start;
  let prevStart;
  let granularity = "day";
  let dayCount = 0;

  if (range === "today") {
    start = makeISTDate(p.year, p.month, p.day);
    prevStart = new Date(start.getTime() - DAY_MS);
    granularity = "hour";
  } else if (range === "7d") {
    start = makeISTDate(p.year, p.month, p.day - 6);
    prevStart = new Date(start.getTime() - 7 * DAY_MS);
    dayCount = 7;
  } else {
    start = makeISTDate(p.year, p.month, 1);
    prevStart = makeISTDate(p.year, p.month - 1, 1);
    dayCount = p.day;
  }

  const end = now;

  // Same elapsed time in the previous period -> fair comparison.
  const prevEnd = new Date(
    Math.min(
      prevStart.getTime() + (end.getTime() - start.getTime()),
      start.getTime(),
    ),
  );

  const yearStart = makeISTDate(year, 0, 1);
  const yearEnd = makeISTDate(year + 1, 0, 1);

  const lo = new Date(Math.min(prevStart.getTime(), yearStart.getTime()));
  const hi = new Date(Math.max(end.getTime(), yearEnd.getTime()));

  const todayKey = prISTDayKey(now);

  const buckets =
    granularity === "hour"
      ? Array.from({ length: p.hour + 1 }, (_, h) => `${todayKey}T${prPad(h)}`)
      : Array.from({ length: dayCount }, (_, i) =>
          prISTDayKey(new Date(start.getTime() + i * DAY_MS)),
        );

  return {
    prefilter: { createdAt: { $gte: lo, $lte: hi } },
    scope: null,
    current: { createdAt: { $gte: start, $lte: end } },
    previous: { createdAt: { $gte: prevStart, $lt: prevEnd } },
    trend: {
      granularity,
      groupedBy: "payment date",
      keyExpr: {
        $dateToString: {
          format: granularity === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d",
          date: "$createdAt",
          timezone: PR_IST_TZ,
        },
      },
      buckets,
    },
    yearly: {
      months: prYearMonths(year),
      match: { createdAt: { $gte: yearStart, $lt: yearEnd } },
      keyExpr: {
        $dateToString: {
          format: "%Y-%m",
          date: "$createdAt",
          timezone: PR_IST_TZ,
        },
      },
    },
    meta: {
      range,
      month: prMonthKey(p.year, p.month),
      window: { start, end },
      previousWindow: { start: prevStart, end: prevEnd },
    },
  };
}

// ------------------------------------------------------------
// AGGREGATION EXPRESSIONS
// ------------------------------------------------------------

const prNum = (expr) => ({ $ifNull: [expr, 0] });

const PR_BREAKDOWN_TOTAL = {
  $add: [
    prNum("$paymentBreakdown.cash"),
    prNum("$paymentBreakdown.phonePe"),
    prNum("$paymentBreakdown.razorpay"),
  ],
};

const PR_HAS_BOOKING_MONTH = { $ne: [{ $ifNull: ["$bookingMonth", ""] }, ""] };
const PR_HAS_FROM_DATE = {
  $ne: [{ $ifNull: ["$booking.fromDate", null] }, null],
};

// bookingMonth -> month of booking.fromDate -> null (unassigned)
const PR_RESOLVED_MONTH = {
  $cond: [
    PR_HAS_BOOKING_MONTH,
    "$bookingMonth",
    {
      $cond: [
        PR_HAS_FROM_DATE,
        {
          $dateToString: {
            format: "%Y-%m",
            date: "$booking.fromDate",
            timezone: "UTC",
          },
        },
        null,
      ],
    },
  ],
};

const PR_MONTH_SOURCE = {
  $cond: [
    PR_HAS_BOOKING_MONTH,
    "field",
    { $cond: [PR_HAS_FROM_DATE, "fromDate", "none"] },
  ],
};

// Base filter shared by every query: company + booking payments only.
function prBaseMatch(companyId) {
  return {
    type: PR_PAYMENT_TYPE,
    ...(companyId ? { company: companyId } : {}),
  };
}

// Stage 1: resolved month + amount.
function prFieldsStage() {
  return {
    $addFields: {
      resolvedMonth: PR_RESOLVED_MONTH,
      monthSource: PR_MONTH_SOURCE,
      _breakdownTotal: PR_BREAKDOWN_TOTAL,
      // Mixed payments sometimes store only the breakdown.
      _amount: {
        $cond: [
          { $gt: [prNum("$amount"), 0] },
          prNum("$amount"),
          PR_BREAKDOWN_TOTAL,
        ],
      },
    },
  };
}

// Stage 2: channel split and office hand-in per payment.
function prMoneyStage() {
  // Breakdown when present, otherwise the whole amount goes to the method's channel.
  const channel = (key, method) => ({
    $cond: [
      { $gt: ["$_breakdownTotal", 0] },
      prNum(`$paymentBreakdown.${key}`),
      { $cond: [{ $eq: ["$paymentMethod", method] }, "$_amount", 0] },
    ],
  });

  return {
    $addFields: {
      _chCash: channel("cash", "cash"),
      _chPhonePe: channel("phonePe", "phonepe"),
      _chRazorpay: channel("razorpay", "razorpay"),
      _chOther: {
        $cond: [
          {
            $and: [
              { $eq: ["$_breakdownTotal", 0] },
              {
                $not: [
                  { $in: ["$paymentMethod", ["cash", "phonepe", "razorpay"]] },
                ],
              },
            ],
          },
          "$_amount",
          0,
        ],
      },
      _settled: {
        $cond: [
          { $eq: ["$isCollected", true] },
          "$_amount",
          { $min: ["$_amount", prNum("$collectedAmount")] },
        ],
      },
    },
  };
}

const PR_SUMS_GROUP = {
  paymentsCount: { $sum: 1 },
  revenue: { $sum: "$_amount" },
  settled: { $sum: "$_settled" },
  channelCash: { $sum: "$_chCash" },
  channelPhonePe: { $sum: "$_chPhonePe" },
  channelRazorpay: { $sum: "$_chRazorpay" },
  channelOther: { $sum: "$_chOther" },
};

const PR_EMPTY_SUMS = Object.fromEntries(
  Object.keys(PR_SUMS_GROUP).map((k) => [k, 0]),
);

// Distinct counts, dropping null / empty values.
const prDistinctCount = (field) => ({
  $size: { $setDifference: [field, [null, ""]] },
});

function prListMatch(currentMatch, { method, search }) {
  const match = { ...currentMatch };

  if (method) match.paymentMethod = method;

  if (search) {
    const regex = new RegExp(prEscapeRegex(search), "i");
    match.$or = [
      { "customer.fullName": regex },
      { "customer.mobileNumber": regex },
      { "vehicle.vehicleName": regex },
      { "vehicle.vehicleNumber": regex },
      { upiLast4: regex },
      { note: regex },
    ];
  }

  return match;
}

// ------------------------------------------------------------
// FACETS (one per dashboard section)
// ------------------------------------------------------------

const prKpiFacet = (match) => [
  { $match: match },
  {
    $group: {
      _id: null,
      ...PR_SUMS_GROUP,
      _bookings: { $addToSet: "$bookingId" },
      _customers: { $addToSet: "$customer.mobileNumber" },
      _vehicles: { $addToSet: "$vehicle.vehicleId" },
    },
  },
  {
    $addFields: {
      bookingsCount: prDistinctCount("$_bookings"),
      customersCount: prDistinctCount("$_customers"),
      vehiclesCount: prDistinctCount("$_vehicles"),
    },
  },
  { $project: { _bookings: 0, _customers: 0, _vehicles: 0 } },
];

const prTopVehiclesFacet = (match, limit = 5) => [
  { $match: match },
  {
    $group: {
      _id: { $ifNull: ["$vehicle.vehicleId", "$vehicle.vehicleNumber"] },
      vehicleName: { $last: "$vehicle.vehicleName" },
      vehicleNumber: { $last: "$vehicle.vehicleNumber" },
      _bookings: { $addToSet: "$bookingId" },
      revenue: { $sum: "$_amount" },
    },
  },
  { $sort: { revenue: -1 } },
  { $limit: limit },
  {
    $project: {
      _id: 0,
      vehicleId: "$_id",
      vehicleName: 1,
      vehicleNumber: 1,
      bookings: prDistinctCount("$_bookings"),
      revenue: 1,
    },
  },
];

const prTrendFacet = (match, keyExpr) => [
  { $match: match },
  {
    $group: {
      _id: keyExpr,
      payments: { $sum: 1 },
      revenue: { $sum: "$_amount" },
      _bookings: { $addToSet: "$bookingId" },
    },
  },
  { $addFields: { bookings: prDistinctCount("$_bookings") } },
  { $project: { _bookings: 0 } },
];

const prYearlyFacet = (match, keyExpr) => [
  { $match: match },
  {
    $group: {
      _id: keyExpr,
      ...PR_SUMS_GROUP,
      _bookings: { $addToSet: "$bookingId" },
    },
  },
  { $addFields: { bookingsCount: prDistinctCount("$_bookings") } },
  { $project: { _bookings: 0 } },
];

const prListTotalFacet = (listMatch) => [
  { $match: listMatch },
  { $count: "count" },
];

const prPaymentsFacet = (listMatch, page, limit) => [
  { $match: listMatch },
  { $sort: { createdAt: -1, _id: -1 } },
  { $skip: (page - 1) * limit },
  { $limit: limit },
  {
    $project: {
      bookingId: 1,
      paymentMethod: 1,
      paymentBreakdown: 1,
      upiLast4: 1,
      amount: "$_amount",
      customer: 1,
      vehicle: 1,
      booking: 1,
      bookingMonth: "$resolvedMonth",
      monthSource: 1,
      isCollected: 1,
      settled: "$_settled",
      note: 1,
      createdAt: 1,
    },
  },
];

// All-time totals for the company (no period filter).
async function prLoadAllTime(companyId) {
  const [row] = await PaymentHistory.aggregate([
    { $match: prBaseMatch(companyId) },
    prFieldsStage(),
    {
      $group: {
        _id: null,
        paymentsCount: { $sum: 1 },
        revenue: { $sum: "$_amount" },
        _bookings: { $addToSet: "$bookingId" },
        firstPaymentAt: { $min: "$createdAt" },
        lastPaymentAt: { $max: "$createdAt" },
        unassignedPayments: {
          $sum: { $cond: [{ $eq: ["$resolvedMonth", null] }, 1, 0] },
        },
        unassignedRevenue: {
          $sum: { $cond: [{ $eq: ["$resolvedMonth", null] }, "$_amount", 0] },
        },
      },
    },
    { $addFields: { bookingsCount: prDistinctCount("$_bookings") } },
    { $project: { _id: 0, _bookings: 0 } },
  ]);

  return {
    bookingsCount: row?.bookingsCount || 0,
    paymentsCount: row?.paymentsCount || 0,
    revenue: row?.revenue || 0,
    avgPerBooking: row?.bookingsCount
      ? Math.round(row.revenue / row.bookingsCount)
      : 0,
    firstPaymentAt: row?.firstPaymentAt || null,
    lastPaymentAt: row?.lastPaymentAt || null,
    // Payments with no bookingMonth and no fromDate: not placed in any month.
    unassignedPayments: row?.unassignedPayments || 0,
    unassignedRevenue: row?.unassignedRevenue || 0,
  };
}

// Quick numbers shown on every tab:
//   today / last7Days     -> by payment createdAt (IST)
//   thisMonth / nextMonth -> by booking month (bookingMonth -> fromDate)
async function prLoadSummary(companyId, now) {
  const p = getISTParts(now);

  const thisMonth = prMonthKey(p.year, p.month);
  const nextMonth = prMonthKey(p.year, p.month + 1);
  const todayStart = makeISTDate(p.year, p.month, p.day);
  const weekStart = makeISTDate(p.year, p.month, p.day - 6);
  const { start: monthsStart, end: monthsEnd } = prMonthsUTCSpan([
    thisMonth,
    nextMonth,
  ]);

  const totals = [
    {
      $group: {
        _id: null,
        paymentsCount: { $sum: 1 },
        revenue: { $sum: "$_amount" },
        _bookings: { $addToSet: "$bookingId" },
      },
    },
    { $addFields: { bookingsCount: prDistinctCount("$_bookings") } },
    { $project: { _id: 0, _bookings: 0 } },
  ];

  const [result = {}] = await PaymentHistory.aggregate([
    {
      $match: {
        ...prBaseMatch(companyId),
        $or: [
          { bookingMonth: { $in: [thisMonth, nextMonth] } },
          { "booking.fromDate": { $gte: monthsStart, $lt: monthsEnd } },
          { createdAt: { $gte: weekStart, $lte: now } },
        ],
      },
    },
    prFieldsStage(),
    {
      $facet: {
        today: [
          { $match: { createdAt: { $gte: todayStart, $lte: now } } },
          ...totals,
        ],
        last7Days: [
          { $match: { createdAt: { $gte: weekStart, $lte: now } } },
          ...totals,
        ],
        thisMonth: [{ $match: { resolvedMonth: thisMonth } }, ...totals],
        nextMonth: [{ $match: { resolvedMonth: nextMonth } }, ...totals],
      },
    },
  ]);

  const pick = (key) => {
    const row = result[key]?.[0];
    const bookingsCount = row?.bookingsCount || 0;
    const revenue = row?.revenue || 0;
    return {
      bookingsCount,
      paymentsCount: row?.paymentsCount || 0,
      revenue,
      avgPerBooking: bookingsCount ? Math.round(revenue / bookingsCount) : 0,
    };
  };

  return {
    today: {
      basis: "created",
      range: "today",
      from: todayStart,
      to: now,
      ...pick("today"),
    },
    last7Days: {
      basis: "created",
      range: "7d",
      from: weekStart,
      to: now,
      ...pick("last7Days"),
    },
    thisMonth: { basis: "booking", month: thisMonth, ...pick("thisMonth") },
    nextMonth: { basis: "booking", month: nextMonth, ...pick("nextMonth") },
  };
}

// ------------------------------------------------------------
// RESULT SHAPERS
// ------------------------------------------------------------

function prFinalizeKpis(raw) {
  const k = {
    ...PR_EMPTY_SUMS,
    bookingsCount: 0,
    customersCount: 0,
    vehiclesCount: 0,
    ...(raw || {}),
  };
  delete k._id;

  k.avgPerBooking = k.bookingsCount
    ? Math.round(k.revenue / k.bookingsCount)
    : 0;
  k.unsettled = Math.max(0, k.revenue - k.settled);
  k.settledRate = prPct(k.settled, k.revenue);

  return k;
}

function prChannels(k) {
  return {
    cash: k.channelCash,
    phonePe: k.channelPhonePe,
    razorpay: k.channelRazorpay,
    other: k.channelOther,
  };
}

function prBuildGrowth(current, previous) {
  return {
    revenue: prGrowth(current.revenue, previous.revenue),
    bookingsCount: prGrowth(current.bookingsCount, previous.bookingsCount),
    avgPerBooking: prGrowth(current.avgPerBooking, previous.avgPerBooking),
    customersCount: prGrowth(current.customersCount, previous.customersCount),
  };
}

// Zero-filled trend. Keys outside the buckets are returned separately
// so their money is never hidden.
function prBuildTrend(buckets, rows = []) {
  const byKey = new Map(rows.map((r) => [r._id, r]));
  const point = (key) => {
    const row = byKey.get(key);
    return {
      key,
      payments: row?.payments || 0,
      bookings: row?.bookings || 0,
      revenue: row?.revenue || 0,
    };
  };

  const bucketSet = new Set(buckets);
  const outside = rows
    .map((r) => r._id ?? null)
    .filter((key) => !bucketSet.has(key))
    .sort((a, b) => String(a).localeCompare(String(b)));

  return { points: buckets.map(point), outside: outside.map(point) };
}

function prBuildMonthlyTrend(months, rows = []) {
  const byMonth = new Map(rows.map((r) => [r._id, r]));
  return months.map((m) => ({ month: m, ...prFinalizeKpis(byMonth.get(m)) }));
}

function prBuildYearTotals(monthlyTrend) {
  const keys = [...Object.keys(PR_EMPTY_SUMS), "bookingsCount"];
  return prFinalizeKpis(
    monthlyTrend.reduce((acc, m) => {
      keys.forEach((key) => {
        acc[key] = (acc[key] || 0) + (m[key] || 0);
      });
      return acc;
    }, {}),
  );
}

// ------------------------------------------------------------
// LOADER
// ------------------------------------------------------------

async function loadBookingRevenue(params, companyId, now) {
  const { basis, year, page, limit } = params;

  const period =
    basis === "created"
      ? prCreatedPeriod(params, now)
      : prBookingMonthPeriod(params);

  const listMatch = prListMatch(period.current, params);

  const pipeline = [
    { $match: { ...prBaseMatch(companyId), ...period.prefilter } },
    prFieldsStage(),
  ];

  if (period.scope) pipeline.push({ $match: period.scope });

  pipeline.push(prMoneyStage(), {
    $facet: {
      current: prKpiFacet(period.current),
      previous: prKpiFacet(period.previous),
      topVehicles: prTopVehiclesFacet(period.current),
      trend: prTrendFacet(period.current, period.trend.keyExpr),
      yearly: prYearlyFacet(period.yearly.match, period.yearly.keyExpr),
      listTotal: prListTotalFacet(listMatch),
      payments: prPaymentsFacet(listMatch, page, limit),
    },
  });

  const [[result = {}], allTime, summary] = await Promise.all([
    PaymentHistory.aggregate(pipeline),
    prLoadAllTime(companyId),
    prLoadSummary(companyId, now),
  ]);

  const kpis = prFinalizeKpis(result.current?.[0]);
  const previousKpis = prFinalizeKpis(result.previous?.[0]);
  const monthlyTrend = prBuildMonthlyTrend(period.yearly.months, result.yearly);
  const trend = prBuildTrend(period.trend.buckets, result.trend);
  const total = result.listTotal?.[0]?.count || 0;

  return {
    source: "paymentHistory:booking",
    filters: {
      basis,
      year,
      paymentType: PR_PAYMENT_TYPE,
      method: params.method,
      search: params.search,
      timezone: "Asia/Kolkata",
      ...period.meta,
    },
    kpis,
    previousKpis,
    growth: prBuildGrowth(kpis, previousKpis),
    channels: prChannels(kpis),
    topVehicles: result.topVehicles || [],
    trend: {
      granularity: period.trend.granularity,
      groupedBy: period.trend.groupedBy,
      points: trend.points,
      outside: trend.outside,
    },
    monthlyTrend,
    yearTotals: prBuildYearTotals(monthlyTrend),
    summary,
    allTime,
    payments: result.payments || [],
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ============================================================
// GET /api/v1/dashboard/bookings
//
// ?basis=booking&month=2026-10
// ?basis=created&range=today|7d|month
// + &method=&search=&page=1&limit=20&year=
// ============================================================

export const getBookingDashboardRevenue = async (req, res) => {
  try {
    const now = new Date();
    const { params, error } = parseBookingRevenueQuery(req.query, now);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    // Payments are saved with company = req.user.company || req.user._id.
    const rawCompany = req.user?.company || req.user?._id;
    const companyId =
      rawCompany && mongoose.Types.ObjectId.isValid(String(rawCompany))
        ? new mongoose.Types.ObjectId(String(rawCompany))
        : null;

    const data = await loadBookingRevenue(params, companyId, now);

    return res.status(200).json({ success: true, generatedAt: now, ...data });
  } catch (error) {
    console.error("Get booking revenue error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to build booking revenue",
      error: error.message,
    });
  }
};

const BOOKING_PAYMENT_COLUMNS = [
  { key: "paymentDate", label: "Payment Date" },
  { key: "bookingMonth", label: "Booking Month" },
  { key: "customerName", label: "Customer Name" },
  { key: "mobileNumber", label: "Mobile" },
  { key: "vehicleName", label: "Vehicle" },
  { key: "vehicleNumber", label: "Vehicle No." },
  { key: "fromDate", label: "From" },
  { key: "toDate", label: "To" },
  { key: "bookingAmount", label: "Booking Amount" },
  { key: "amount", label: "Paid Amount" },
  { key: "paymentMethod", label: "Method" },
  { key: "cash", label: "Cash" },
  { key: "phonePe", label: "PhonePe" },
  { key: "razorpay", label: "Razorpay" },
  { key: "upiLast4", label: "UPI Last 4" },
  { key: "isCollected", label: "Collected" },
  { key: "collectedAmount", label: "Collected Amount" },
  { key: "collectedPhonePe", label: "Collected PhonePe" },
  { key: "lastCollectedAt", label: "Last Collected At" },
  { key: "createdByName", label: "Created By" },
  { key: "note", label: "Note" },
];

// Booking-level ledger columns: the full bill (what the customer owes)
// and every payment (what the customer paid), for the same booking.
const BOOKING_LEDGER_COLUMNS = [
  { key: "bookingCode", label: "Booking Code", group: "ledger" },
  { key: "bookingStatus", label: "Booking Status", group: "ledger" },
  { key: "dueSource", label: "Stage", group: "ledger" },
  { key: "tripDays", label: "Days", group: "ledger" },
  { key: "currentDropAt", label: "Current Drop", group: "ledger" },

  // ---- BILL (charges) ----
  { key: "rentCharge", label: "Rent", group: "ledger" },
  { key: "fastagCharge", label: "FASTag", group: "ledger" },
  { key: "pickupDropCharge", label: "Pickup / Drop", group: "ledger" },
  { key: "extraCharge", label: "Extra Charges", group: "ledger" },
  { key: "returnCharges", label: "Return Charges", group: "ledger" },
  { key: "depositCharge", label: "Deposit", group: "ledger" },
  { key: "discountGiven", label: "Discount", group: "ledger" },
  { key: "totalBill", label: "Total Bill", group: "ledger" },

  // ---- PAYMENTS (by type) ----
  { key: "allBookingPaid", label: "Booking (All)", group: "ledger" },
  { key: "handoverPaid", label: "Handover", group: "ledger" },
  { key: "rentalPaid", label: "Rental", group: "ledger" },
  { key: "extensionPaid", label: "Extension", group: "ledger" },
  { key: "additionalChargePaid", label: "Additional Charge", group: "ledger" },
  { key: "receivePaid", label: "Receive", group: "ledger" },
  { key: "refundPaid", label: "Refund", group: "ledger" },
  { key: "totalReceived", label: "Total Received", group: "ledger" },
  { key: "netReceived", label: "Net Received", group: "ledger" },
  {
    key: "returnCollectedUnlogged",
    label: "Return Collected (not in payments)",
    group: "ledger",
  },
  { key: "totalPaid", label: "Total Paid", group: "ledger" },

  // ---- RESULT ----
  { key: "currentDue", label: "Current Due", group: "ledger" },
  { key: "refundDue", label: "Refund Due", group: "ledger" },

  // ---- CHANNELS ----
  { key: "netCash", label: "Net Cash", group: "ledger" },
  { key: "netPhonePe", label: "Net PhonePe", group: "ledger" },
  { key: "netRazorpay", label: "Net Razorpay", group: "ledger" },
  { key: "splitDiff", label: "Unsplit Amount", group: "ledger" },

  // ---- SYSTEM VALUES (for comparison only) ----
  { key: "handoverStatus", label: "Handover Status", group: "ledger" },
  { key: "handoverBill", label: "Handover Total (system)", group: "ledger" },
  {
    key: "handoverBalance",
    label: "Handover Balance (system)",
    group: "ledger",
  },
  { key: "returnStatus", label: "Settlement Status", group: "ledger" },
  {
    key: "returnFinalBalance",
    label: "Return Balance (system)",
    group: "ledger",
  },
  {
    key: "returnCollected",
    label: "Return Collected (system)",
    group: "ledger",
  },
  { key: "returnedAt", label: "Returned At", group: "ledger" },

  { key: "paymentCount", label: "Txns", group: "ledger" },
  { key: "lastPaymentAt", label: "Last Txn At", group: "ledger" },
];

const ALL_BOOKING_PAYMENT_COLUMNS = [
  ...BOOKING_PAYMENT_COLUMNS,
  ...BOOKING_LEDGER_COLUMNS,
];

const SORTABLE_FIELDS = [
  "createdAt",
  "amount",
  "booking.fromDate",
  "bookingMonth",
];

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ============================================================
// LEDGER CONFIG & HELPERS
// ============================================================
const PAYMENT_TYPES = [
  "booking",
  "handover",
  "rental",
  "extension",
  "additional_charge",
  "receive",
  "refund",
];

const TYPE_TO_FIELD = {
  booking: "allBookingPaid",
  handover: "handoverPaid",
  rental: "rentalPaid",
  extension: "extensionPaid",
  additional_charge: "additionalChargePaid",
  receive: "receivePaid",
  refund: "refundPaid",
};

// Money coming IN (everything except refund)
const INFLOW_FIELDS = PAYMENT_TYPES.filter((t) => t !== "refund").map(
  (t) => TYPE_TO_FIELD[t],
);

// Money fields summed in the footer (per distinct booking, never per row)
const LEDGER_MONEY_FIELDS = [
  "rentCharge",
  "fastagCharge",
  "pickupDropCharge",
  "extraCharge",
  "returnCharges",
  "depositCharge",
  "discountGiven",
  "totalBill",
  "allBookingPaid",
  "handoverPaid",
  "rentalPaid",
  "extensionPaid",
  "additionalChargePaid",
  "receivePaid",
  "refundPaid",
  "totalReceived",
  "netReceived",
  "returnCollectedUnlogged",
  "totalPaid",
  "currentDue",
  "refundDue",
  "netCash",
  "netPhonePe",
  "netRazorpay",
  "splitDiff",
  "handoverBill",
  "handoverBalance",
  "returnFinalBalance",
  "returnCollected",
];

// Round to paise to avoid floating point noise (e.g. 0.1 + 0.2)
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const numOrNull = (v) => (v === null || v === undefined ? null : round2(v));
const num = (v) => Number(v) || 0;

const emptyLedger = () => ({
  bookingCode: "",
  bookingStatus: "",
  dueSource: "",
  tripDays: null,
  currentDropAt: null,

  rentCharge: 0,
  fastagCharge: 0,
  pickupDropCharge: 0,
  extraCharge: 0,
  returnCharges: 0,
  depositCharge: 0,
  discountGiven: 0,
  totalBill: 0,

  allBookingPaid: 0,
  handoverPaid: 0,
  rentalPaid: 0,
  extensionPaid: 0,
  additionalChargePaid: 0,
  receivePaid: 0,
  refundPaid: 0,
  totalReceived: 0,
  netReceived: 0,
  returnCollectedUnlogged: 0,
  totalPaid: 0,

  currentDue: 0,
  refundDue: 0,

  netCash: 0,
  netPhonePe: 0,
  netRazorpay: 0,
  splitDiff: 0,

  handoverStatus: "",
  handoverBill: null, // null = no handover yet
  handoverBalance: null,
  returnStatus: "",
  returnFinalBalance: null, // null = not returned yet
  returnCollected: null,
  returnedAt: null,

  // Trip dates from the handover (used only when the payment has no From/To)
  handoverPickupAt: null,
  handoverDropAt: null,

  paymentCount: 0,
  lastPaymentAt: null,
});

/**
 * Work out the customer's bill (charges) for one booking.
 *
 *   Total Bill = Rent + FASTag + Pickup/Drop + Extra Charges
 *              + Return Charges + Deposit (only while vehicle is out)
 *              − Discount
 *
 * Handover values are used once a handover exists (they include
 * extensions); before that, the booking's values are used. Missing
 * handover values fall back to the booking's values.
 */
const computeBill = ({ bk, ho, ret, additionalChargePaid }) => {
  const bp = bk?.payment || {};
  const bookingPickupDrop = num(bp.pickupCharge) + num(bp.dropCharge);

  let rent = 0;
  let fastag = 0;
  let pickupDrop = 0;
  let extra = 0;
  let deposit = 0;
  let discount = 0;

  if (ho) {
    const hp = ho.payment || {};

    // Extensions: if totalFare was already updated to the last bill's
    // "totalFareAfterThisBill", it includes them. Otherwise add them.
    const bills = [...(ho.extensionBills || [])].sort(
      (a, b) => num(a.billNumber) - num(b.billNumber),
    );
    const lastBill = bills[bills.length - 1];
    const extensionSum = bills.reduce((s, b) => s + num(b.extensionAmount), 0);
    const fareIncludesExtensions =
      !lastBill ||
      Math.abs(num(lastBill.totalFareAfterThisBill) - num(hp.totalFare)) <= 1;

    const hRent =
      num(hp.totalFare) + (fareIncludesExtensions ? 0 : extensionSum);
    const hFastag = num(hp.fastTagPayableAmount);
    const hPickupDrop =
      num(hp.billSummary?.pickupCharge) + num(hp.billSummary?.dropCharge);
    const hExtra = num(hp.extraCharges);
    const hDeposit = num(hp.securityDeposit);
    const hDiscount = num(hp.discountAmount);
    const hTotal = num(hp.totalAmount);

    // Do the handover's own parts add up to its stored totalAmount
    // (either before or after discount)? Then trust them as they are.
    const hGross = hRent + hFastag + hPickupDrop + hExtra + hDeposit;
    const partsMatchTotal =
      hTotal > 0 &&
      (Math.abs(hGross - hTotal) <= 1 ||
        Math.abs(hGross - hDiscount - hTotal) <= 1);

    if (partsMatchTotal) {
      rent = hRent;
      fastag = hFastag;
      pickupDrop = hPickupDrop;
      extra = hExtra;
      deposit = hDeposit;
    } else {
      // Fill gaps from the booking
      fastag = hFastag > 0 ? hFastag : num(bp.fastagAmount);
      pickupDrop = hPickupDrop > 0 ? hPickupDrop : bookingPickupDrop;
      extra = hExtra;
      deposit = hDeposit;
      rent =
        hRent > 0
          ? hRent
          : Math.max(0, hTotal - fastag - pickupDrop - extra - deposit);
    }

    // Discount given at booking carries over unless the handover sets its own
    discount = hDiscount > 0 ? hDiscount : num(bp.discountAmount);
  } else if (bk) {
    rent = num(bp.vehicleRent);
    fastag = num(bp.fastagAmount);
    pickupDrop = bookingPickupDrop;
    deposit = num(bp.securityDeposit);
    discount = num(bp.discountAmount);

    // Old bookings that only stored totalAmount
    if (rent + fastag + pickupDrop === 0) rent = num(bp.totalAmount);
  }

  // Money taken as "additional_charge" proves at least that much was charged
  extra = Math.max(extra, num(additionalChargePaid));

  // Return: fines/fuel/damage are added; the deposit stops being a charge
  // (it is either refunded via a "refund" payment, or kept to cover these).
  let returnCharges = 0;
  if (ret) {
    const s = ret.settlementDetails || {};
    returnCharges =
      num(s.lateReturnFine) +
      num(s.extraKmFine) +
      num(s.fuelUsageAmount) +
      num(s.damageAmount);
    deposit = 0;
  }

  const totalBill = Math.max(
    0,
    rent + fastag + pickupDrop + extra + returnCharges + deposit - discount,
  );

  return {
    rentCharge: round2(rent),
    fastagCharge: round2(fastag),
    pickupDropCharge: round2(pickupDrop),
    extraCharge: round2(extra),
    returnCharges: round2(returnCharges),
    depositCharge: round2(deposit),
    discountGiven: round2(discount),
    totalBill: round2(totalBill),
  };
};

/**
 * Build a booking-level ledger for each bookingId.
 * Payments are linked to a booking by:
 *   1. payment.bookingId = booking._id
 *   2. payment.handoverId (or bookingId) = one of the booking's handovers
 *   3. same mobile + same vehicle number + payment inside the trip window
 * Each payment is counted for one booking only.
 * Returns Map<bookingIdString, ledger>.
 */
const buildBookingLedgers = async (bookingIds, companyId) => {
  const ids = (bookingIds || []).filter(Boolean);
  const ledgers = new Map();
  if (!ids.length) return ledgers;

  const idSet = new Set(ids.map(String));
  const DAY = 24 * 60 * 60 * 1000;
  const toObjId = (v) => new mongoose.Types.ObjectId(String(v));
  const normMobile = (s) =>
    String(s || "")
      .replace(/\D/g, "")
      .slice(-10);
  const normVehicle = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const toMs = (d) => {
    const t = d ? new Date(d).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  };

  // ---------- 1. Bookings ----------
  const bookings = await Booking.find({ _id: { $in: ids } })
    .select(
      "bookingCode status totalDays fromDate toDate isDeleted payment handover mobileNumber vehicleNumber",
    )
    .lean();
  const bookingMap = new Map(bookings.map((b) => [String(b._id), b]));

  const bookingByHandoverRef = new Map();
  for (const b of bookings) {
    if (b.handover) bookingByHandoverRef.set(String(b.handover), String(b._id));
  }

  // ---------- 2. Handovers ----------
  const handovers = await Handover.find({
    isDeleted: { $ne: true },
    $or: [
      { bookingId: { $in: ids } },
      { _id: { $in: [...bookingByHandoverRef.keys()].map(toObjId) } },
    ],
  })
    .select(
      "_id bookingId handoverStatus payment trip createdAt customer.mobileNumber vehicle.vehicleNumber " +
        "extensionBills.billNumber extensionBills.extensionAmount extensionBills.totalFareAfterThisBill",
    )
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  const handoverToBooking = new Map(); // handoverId -> bookingId
  const latestHandover = new Map(); // bookingId -> newest handover
  for (const h of handovers) {
    const bid = h.bookingId
      ? String(h.bookingId)
      : bookingByHandoverRef.get(String(h._id));
    if (!bid || !idSet.has(bid)) continue;
    handoverToBooking.set(String(h._id), bid);
    if (!latestHandover.has(bid)) latestHandover.set(bid, h);
  }

  // ---------- 3. Returns ----------
  // Look at returns of EVERY handover of the booking (not only the newest),
  // so a return saved against an earlier handover is never missed.
  const bookingHandoverIds = [...handoverToBooking.keys()].map(toObjId);
  const returns = bookingHandoverIds.length
    ? await VehicleReturn.find({ handover: { $in: bookingHandoverIds } })
        .select("handover createdAt receivingTime settlementDetails")
        .sort({ createdAt: -1, _id: -1 })
        .lean()
    : [];

  const returnByBooking = new Map(); // bookingId -> newest return
  for (const r of returns) {
    const bid = handoverToBooking.get(String(r.handover));
    if (bid && !returnByBooking.has(bid)) returnByBooking.set(bid, r);
  }

  // ---------- Payment accumulator (same rules for every link type) ----------
  const accs = new Map();
  const usedPaymentIds = new Set();

  const addPayment = (bid, p, how) => {
    const key = String(p._id);
    if (usedPaymentIds.has(key)) return; // never count a payment twice
    usedPaymentIds.add(key);

    const acc = accs.get(bid) || {
      ...Object.fromEntries(Object.values(TYPE_TO_FIELD).map((f) => [f, 0])),
      netCash: 0,
      netPhonePe: 0,
      netRazorpay: 0,
      paymentCount: 0,
      lastPaymentAt: null,
      linkedById: 0,
      linkedByHandover: 0,
      linkedByMatch: 0,
      items: [],
    };

    const amt = num(p.amount);
    const sign = p.type === "refund" ? -1 : 1;
    const bd = p.paymentBreakdown || {};
    let cash = num(bd.cash);
    let phonePe = num(bd.phonePe);
    let razorpay = num(bd.razorpay);

    // Empty breakdown on a single-method payment -> whole amount to that channel
    if (cash + phonePe + razorpay === 0) {
      if (p.paymentMethod === "cash") cash = amt;
      else if (p.paymentMethod === "phonepe") phonePe = amt;
      else if (p.paymentMethod === "razorpay") razorpay = amt;
    }

    const field = TYPE_TO_FIELD[p.type];
    if (field) acc[field] += amt;

    acc.netCash += sign * cash;
    acc.netPhonePe += sign * phonePe;
    acc.netRazorpay += sign * razorpay;
    acc.paymentCount += 1;
    acc[how] += 1;
    acc.items.push({ at: toMs(p.createdAt), amt, type: p.type });

    if (
      p.createdAt &&
      (!acc.lastPaymentAt || p.createdAt > acc.lastPaymentAt)
    ) {
      acc.lastPaymentAt = p.createdAt;
    }
    accs.set(bid, acc);
  };

  const PAYMENT_FIELDS =
    "_id type amount paymentMethod paymentBreakdown bookingId handoverId customer.mobileNumber vehicle.vehicleNumber booking.fromDate booking.toDate createdAt";
  const companyMatch = companyId ? { company: companyId } : {};

  // ---------- 4. Rules 1 + 2: linked by ID ----------
  const allHandoverIds = [...handoverToBooking.keys()].map(toObjId);

  const idLinked = await PaymentHistory.find({
    ...companyMatch,
    $or: [
      { bookingId: { $in: ids } },
      ...(allHandoverIds.length
        ? [
            { handoverId: { $in: allHandoverIds } },
            { bookingId: { $in: allHandoverIds } },
          ]
        : []),
    ],
  })
    .select(PAYMENT_FIELDS)
    .lean();

  for (const p of idLinked) {
    const b = p.bookingId ? String(p.bookingId) : null;
    const h = p.handoverId ? String(p.handoverId) : null;

    if (h && handoverToBooking.has(h))
      addPayment(handoverToBooking.get(h), p, "linkedByHandover");
    else if (b && idSet.has(b)) addPayment(b, p, "linkedById");
    else if (b && handoverToBooking.has(b))
      addPayment(handoverToBooking.get(b), p, "linkedByHandover");
  }

  // ---------- 5. Rule 3: same customer + same vehicle + same trip window ----------
  const windows = [];
  for (const id of ids) {
    const key = String(id);
    const bk = bookingMap.get(key);
    const ho = latestHandover.get(key);

    const mobile = normMobile(ho?.customer?.mobileNumber || bk?.mobileNumber);
    const vehicle = normVehicle(
      ho?.vehicle?.vehicleNumber || bk?.vehicleNumber,
    );
    const start = toMs(ho?.trip?.pickupDateTime) ?? toMs(bk?.fromDate);
    let end = toMs(ho?.trip?.dropDateTime) ?? toMs(bk?.toDate);
    if (!ho?.trip?.dropDateTime && end !== null) end += DAY; // include the whole last day

    if (mobile.length === 10 && vehicle && start !== null && end !== null) {
      windows.push({ bid: key, mobile, vehicle, start, end });
    }
  }

  let fallbackChecked = 0;
  if (windows.length) {
    const byCustomerVehicle = new Map();
    for (const w of windows) {
      const k = `${w.mobile}|${w.vehicle}`;
      if (!byCustomerVehicle.has(k)) byCustomerVehicle.set(k, []);
      byCustomerVehicle.get(k).push(w);
    }

    const mobiles = [...new Set(windows.map((w) => w.mobile))];
    const minStart = Math.min(...windows.map((w) => w.start)) - 2 * DAY;
    const maxEnd = Math.max(...windows.map((w) => w.end)) + 15 * DAY;

    const candidates = [];
    for (let i = 0; i < mobiles.length; i += 300) {
      const chunk = mobiles.slice(i, i + 300);
      const found = await PaymentHistory.find({
        ...companyMatch,
        createdAt: { $gte: new Date(minStart), $lte: new Date(maxEnd) },
        "customer.mobileNumber": { $regex: `(${chunk.join("|")})$` },
      })
        .select(PAYMENT_FIELDS)
        .lean();
      candidates.push(...found);
    }

    const unlinked = candidates.filter(
      (p) => !usedPaymentIds.has(String(p._id)),
    );
    fallbackChecked = unlinked.length;

    // Never take a payment that belongs to another real booking
    const otherIds = [
      ...new Set(
        unlinked
          .map((p) => (p.bookingId ? String(p.bookingId) : null))
          .filter((b) => b && !idSet.has(b)),
      ),
    ];
    const otherExisting = otherIds.length
      ? new Set(
          (
            await Booking.find({ _id: { $in: otherIds.map(toObjId) } })
              .select("_id")
              .lean()
          ).map((b) => String(b._id)),
        )
      : new Set();

    for (const p of unlinked) {
      if (p.bookingId && otherExisting.has(String(p.bookingId))) continue;

      const list = byCustomerVehicle.get(
        `${normMobile(p.customer?.mobileNumber)}|${normVehicle(p.vehicle?.vehicleNumber)}`,
      );
      if (!list) continue;

      const paidAt = toMs(p.createdAt);
      const pFrom = toMs(p.booking?.fromDate);
      const pTo = toMs(p.booking?.toDate) ?? pFrom;

      const fits = list.filter((w) => {
        if (pFrom !== null) return pFrom <= w.end + DAY && pTo >= w.start - DAY;
        return (
          paidAt !== null &&
          paidAt >= w.start - 2 * DAY &&
          paidAt <= w.end + 15 * DAY
        );
      });
      if (!fits.length) continue;

      fits.sort(
        (a, b) =>
          Math.abs((paidAt ?? a.start) - a.start) -
          Math.abs((paidAt ?? b.start) - b.start),
      );
      addPayment(fits[0].bid, p, "linkedByMatch");
    }
  }

  // ---------- Debug summary in the server terminal ----------
  let byId = 0;
  let byHandover = 0;
  let byMatch = 0;
  for (const a of accs.values()) {
    byId += a.linkedById;
    byHandover += a.linkedByHandover;
    byMatch += a.linkedByMatch;
  }
  console.log(
    `[ledger] bookings=${ids.length} handovers=${handovers.length} returns=${returns.length} | ` +
      `payments linked: byId=${byId} byHandover=${byHandover} byCustomerVehicleDates=${byMatch} ` +
      `(fallback candidates checked=${fallbackChecked})`,
  );

  // ---------- 6. Compose ledger per booking ----------
  let returnsWithCollection = 0;
  let returnsNotLogged = 0;

  for (const id of ids) {
    const key = String(id);
    if (ledgers.has(key)) continue;

    const pay = accs.get(key) || { items: [] };
    const bk = bookingMap.get(key) || null;
    const ho = latestHandover.get(key) || null;
    const ret = returnByBooking.get(key) || null;

    const l = emptyLedger();

    // ---- Payments ----
    for (const field of Object.values(TYPE_TO_FIELD))
      l[field] = round2(pay[field]);

    l.totalReceived = round2(INFLOW_FIELDS.reduce((s, f) => s + l[f], 0));
    l.netReceived = round2(l.totalReceived - l.refundPaid);
    l.paymentCount = pay.paymentCount || 0;
    l.lastPaymentAt = pay.lastPaymentAt || null;

    let netCash = num(pay.netCash);
    let netPhonePe = num(pay.netPhonePe);
    let netRazorpay = num(pay.netRazorpay);

    // Time the return happened (payments within 2 h before it count as "at return")
    const RETURN_WINDOW_MS = 2 * 60 * 60 * 1000;
    const retAt = ret ? (toMs(ret.receivingTime) ?? toMs(ret.createdAt)) : null;
    const atOrAfterReturn = (i) =>
      retAt !== null && i.at !== null && i.at >= retAt - RETURN_WINDOW_MS;

    // ---- Return collection ----
    // settlementDetails.amountCollected is what was taken at return.
    // If the return screen did not save it as a PaymentHistory record,
    // add the missing part here (never double counted).
    if (ret) {
      const st = ret.settlementDetails || {};
      const collected = num(st.amountCollected);

      l.returnCollected = round2(collected);
      l.returnedAt = ret.receivingTime || ret.createdAt || null;

      const loggedAtReturn = pay.items
        .filter((i) => i.type !== "refund" && atOrAfterReturn(i))
        .reduce((s, i) => s + i.amt, 0);

      const unlogged = round2(Math.max(0, collected - loggedAtReturn));
      l.returnCollectedUnlogged = unlogged;

      if (collected > 0) returnsWithCollection += 1;
      if (unlogged > 0) {
        returnsNotLogged += 1;

        // Put the unlogged part into the right channels
        const bd = st.paymentBreakdown || {};
        const bdCash = num(bd.cash);
        const bdPhonePe = num(bd.phonePe);
        const bdRazorpay = num(bd.razorpay);
        const bdTotal = bdCash + bdPhonePe + bdRazorpay;

        if (bdTotal > 0) {
          const share = unlogged / bdTotal;
          netCash += bdCash * share;
          netPhonePe += bdPhonePe * share;
          netRazorpay += bdRazorpay * share;
        } else if (st.paymentMode === "Cash") {
          netCash += unlogged;
        } else if (st.paymentMode === "PhonePe") {
          netPhonePe += unlogged;
        } else if (st.paymentMode === "Razorpay") {
          netRazorpay += unlogged;
        }
      }
    }

    l.totalPaid = round2(l.netReceived + l.returnCollectedUnlogged);
    l.netCash = round2(netCash);
    l.netPhonePe = round2(netPhonePe);
    l.netRazorpay = round2(netRazorpay);
    l.splitDiff = round2(
      l.totalPaid - l.netCash - l.netPhonePe - l.netRazorpay,
    );

    // "additional_charge" money taken at return pays the return fines,
    // so only the part paid BEFORE the return proves an extra charge.
    const additionalBeforeReturn = pay.items
      .filter((i) => i.type === "additional_charge" && !atOrAfterReturn(i))
      .reduce((s, i) => s + i.amt, 0);

    // ---- Snapshot info ----
    if (bk) {
      l.bookingCode = bk.bookingCode || "";
      l.bookingStatus = bk.isDeleted ? "deleted" : bk.status || "";
    }
    if (ho) {
      l.handoverStatus = ho.handoverStatus || "";
      l.handoverBill = numOrNull(ho.payment?.totalAmount);
      l.handoverBalance = numOrNull(ho.payment?.balanceAmount);
    }
    if (ret) {
      l.returnStatus = ret.settlementDetails?.status || "";
      l.returnFinalBalance = numOrNull(ret.settlementDetails?.finalBalance);
    }

    l.handoverPickupAt = ho?.trip?.pickupDateTime ?? null;
    l.handoverDropAt = ho?.trip?.dropDateTime ?? null;

    l.tripDays = ho?.trip?.numberOfDays ?? bk?.totalDays ?? null;
    l.currentDropAt = ho?.trip?.dropDateTime ?? bk?.toDate ?? null;

    // ---- Bill and balance ----
    const cancelled =
      (ho && ho.handoverStatus === "cancelled") ||
      (!ho && bk && (bk.isDeleted || bk.status === "cancelled"));

    if (cancelled) {
      l.dueSource = "cancelled";
      // No bill on a cancelled booking; money still held shows as Refund Due
      l.totalBill = 0;
      l.currentDue = 0;
      l.refundDue = round2(Math.max(0, l.totalPaid));
    } else {
      Object.assign(
        l,
        computeBill({
          bk,
          ho,
          ret,
          additionalChargePaid: additionalBeforeReturn,
        }),
      );
      l.dueSource = ret ? "return" : ho ? "handover" : "booking";

      const balance = round2(l.totalBill - l.totalPaid);
      l.currentDue = balance > 0 ? balance : 0;
      l.refundDue = balance < 0 ? round2(-balance) : 0;
    }

    ledgers.set(key, l);
  }

  console.log(
    `[ledger] returns found=${returns.length} withCollection=${returnsWithCollection} ` +
      `collectionNotInPayments=${returnsNotLogged}`,
  );

  return ledgers;
};

// Totals over DISTINCT bookings (no double counting when a booking has
// more than one "booking" type payment row)
const summarizeLedgers = (ledgers) => {
  const s = Object.fromEntries(LEDGER_MONEY_FIELDS.map((f) => [f, 0]));
  s.bookingCount = 0;
  s.paymentCount = 0;
  s.dueBookingCount = 0;
  s.refundBookingCount = 0;

  for (const l of ledgers.values()) {
    s.bookingCount += 1;
    s.paymentCount += l.paymentCount || 0;
    if (num(l.currentDue) > 0) s.dueBookingCount += 1;
    if (num(l.refundDue) > 0) s.refundBookingCount += 1;
    for (const f of LEDGER_MONEY_FIELDS) s[f] += num(l[f]);
  }

  for (const f of LEDGER_MONEY_FIELDS) s[f] = round2(s[f]);
  return s;
};

// ============================================================
// CONTROLLER
// ============================================================
export const getBookingPayments = async (req, res) => {
  try {
    const {
      month, // "YYYY-MM"
      fromDate, // payment created from (ISO date)
      toDate, // payment created to (ISO date)
      paymentMethod, // cash | phonepe | razorpay | mixed
      isCollected, // "true" | "false"
      search, // customer name / mobile / vehicle number
      page = 1,
      limit = 50,
      all, // "true" => no pagination (full export)
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // ---------- Company scope (optional, no auth) ----------
    const { company } = req.query;

    const filter = { type: "booking" };

    if (company) {
      if (!mongoose.Types.ObjectId.isValid(company)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid company id" });
      }
      filter.company = new mongoose.Types.ObjectId(company);
    }

    const and = [];

    // ---------- Month filter: by the booking's FROM date (trip start) ----------
    // The trip start date is taken from, in order:
    //   1. Booking.fromDate (current, even if the trip was rescheduled)
    //   2. the From date saved on the payment (booking.fromDate)
    //   3. the handover's pickup date (trip.pickupDateTime)
    // A source is used only when the ones before it are not available.
    // Month edges are in IST, so a trip starting 1 Oct is always October,
    // whether the date was saved at UTC midnight or IST midnight.
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res
          .status(400)
          .json({ success: false, message: "month must be YYYY-MM" });
      }
      const [y, m] = month.split("-").map(Number);
      const IST_MS = 330 * 60 * 1000;
      const start = new Date(Date.UTC(y, m - 1, 1) - IST_MS); // 1st of month, 00:00 IST
      const end = new Date(Date.UTC(y, m, 1) - IST_MS); // 1st of next month, 00:00 IST
      const fromRange = { $gte: start, $lt: end };
      const toObjectId = (v) => new mongoose.Types.ObjectId(String(v));

      const [monthBookingIds, snapshotBookingIds, handoversInMonth] =
        await Promise.all([
          // 1. Bookings whose trip starts in this month
          Booking.distinct("_id", { fromDate: fromRange }),
          // 2. Booking payments whose saved trip start is in this month
          PaymentHistory.distinct("bookingId", {
            type: "booking",
            "booking.fromDate": fromRange,
          }),
          // 3. Handovers whose pickup is in this month
          Handover.find({
            isDeleted: { $ne: true },
            "trip.pickupDateTime": fromRange,
          })
            .select("_id bookingId")
            .lean(),
        ]);

      // Booking payments with NO saved From date, linked to those handovers
      const hoBookingIds = handoversInMonth
        .map((h) => h.bookingId)
        .filter(Boolean);
      const hoIds = handoversInMonth.map((h) => h._id);
      const handoverBookingIds = hoIds.length
        ? await PaymentHistory.distinct("bookingId", {
            type: "booking",
            "booking.fromDate": null, // missing or empty
            $or: [
              ...(hoBookingIds.length
                ? [{ bookingId: { $in: hoBookingIds } }]
                : []),
              { handoverId: { $in: hoIds } },
              { bookingId: { $in: hoIds } },
            ],
          })
        : [];

      // Sources 2 and 3 apply only when the Booking itself has no From date
      const inMonth = new Set(monthBookingIds.map(String));
      const candidates = [
        ...new Set(
          [...snapshotBookingIds, ...handoverBookingIds]
            .filter(Boolean)
            .map(String),
        ),
      ].filter((bid) => !inMonth.has(bid));

      const haveOwnFromDate = candidates.length
        ? new Set(
            (
              await Booking.distinct("_id", {
                _id: { $in: candidates.map(toObjectId) },
                fromDate: { $ne: null },
              })
            ).map(String),
          )
        : new Set();

      const fallbackIds = candidates
        .filter((bid) => !haveOwnFromDate.has(bid))
        .map(toObjectId);

      and.push({ bookingId: { $in: [...monthBookingIds, ...fallbackIds] } });
    }

    // ---------- Payment date range ----------
    if (fromDate || toDate) {
      const range = {};
      if (fromDate) {
        const d = new Date(fromDate);
        if (!isNaN(d)) range.$gte = d;
      }
      if (toDate) {
        const d = new Date(toDate);
        if (!isNaN(d)) {
          d.setUTCHours(23, 59, 59, 999);
          range.$lte = d;
        }
      }
      if (Object.keys(range).length) filter.createdAt = range;
    }

    // ---------- Other filters ----------
    if (
      paymentMethod &&
      ["cash", "phonepe", "razorpay", "mixed"].includes(paymentMethod)
    ) {
      filter.paymentMethod = paymentMethod;
    }

    if (isCollected === "true" || isCollected === "false") {
      filter.isCollected = isCollected === "true";
    }

    if (search?.trim()) {
      const rx = new RegExp(escapeRegex(search.trim()), "i");
      and.push({
        $or: [
          { "customer.fullName": rx },
          { "customer.mobileNumber": rx },
          { "vehicle.vehicleNumber": rx },
          { "vehicle.vehicleName": rx },
        ],
      });
    }

    if (and.length) filter.$and = and;

    // ---------- Sorting & pagination ----------
    const sortField = SORTABLE_FIELDS.includes(sortBy) ? sortBy : "createdAt";
    const sort = { [sortField]: sortOrder === "asc" ? 1 : -1, _id: -1 };

    const exportAll = all === "true";
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);

    let query = PaymentHistory.find(filter)
      .select("-collectionHistory -__v")
      .populate("createdBy", "name")
      .sort(sort)
      .lean();

    if (!exportAll)
      query = query.skip((pageNum - 1) * limitNum).limit(limitNum);

    const [payments, total, summaryAgg, filteredBookingIds] = await Promise.all(
      [
        query,
        PaymentHistory.countDocuments(filter),
        PaymentHistory.aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              totalCash: { $sum: "$paymentBreakdown.cash" },
              totalPhonePe: { $sum: "$paymentBreakdown.phonePe" },
              totalRazorpay: { $sum: "$paymentBreakdown.razorpay" },
              totalCollected: { $sum: "$collectedAmount" },
              totalCollectedPhonePe: { $sum: "$collectedPhonePe" },
              collectedCount: { $sum: { $cond: ["$isCollected", 1, 0] } },
            },
          },
        ]),
        // Every distinct booking in the filtered set (for ledger + footer totals)
        PaymentHistory.distinct("bookingId", filter),
      ],
    );

    // ---------- Booking ledger (bill + all payment types) ----------
    let ledgers = new Map();
    let ledgerError = false;
    let ledgerErrorMessage = "";
    try {
      ledgers = await buildBookingLedgers(filteredBookingIds, filter.company);
    } catch (err) {
      // Never break the existing sheet if the ledger fails
      console.error("getBookingPayments ledger error:", err);
      ledgerError = true;
      ledgerErrorMessage = err.message;
    }

    // ---------- Flatten for sheet ----------
    const rows = payments.map((p) => {
      const ledger = ledgers.get(String(p.bookingId)) || emptyLedger();

      return {
        _id: p._id,
        bookingId: p.bookingId,
        paymentDate: p.createdAt,
        bookingMonth:
          p.bookingMonth ||
          toBookingMonth(p.booking?.fromDate) ||
          toBookingMonth(p.booking?.toDate) ||
          toBookingMonth(ledger.handoverPickupAt) ||
          toBookingMonth(ledger.handoverDropAt) ||
          "",
        customerName: p.customer?.fullName || "",
        mobileNumber: p.customer?.mobileNumber || "",
        vehicleName: p.vehicle?.vehicleName || "",
        vehicleNumber: p.vehicle?.vehicleNumber || "",
        // From / To: saved on the payment, else taken from the handover
        fromDate: p.booking?.fromDate || ledger.handoverPickupAt || null,
        toDate: p.booking?.toDate || ledger.handoverDropAt || null,
        bookingAmount: p.booking?.bookingAmount || 0,
        amount: p.amount || 0,
        paymentMethod: p.paymentMethod,
        cash: p.paymentBreakdown?.cash || 0,
        phonePe: p.paymentBreakdown?.phonePe || 0,
        razorpay: p.paymentBreakdown?.razorpay || 0,
        upiLast4: (p.upiLast4 || []).join(", "),
        isCollected: !!p.isCollected,
        collectedAmount: p.collectedAmount || 0,
        collectedPhonePe: p.collectedPhonePe || 0,
        lastCollectedAt: p.lastCollectedAt || null,
        createdByName: p.createdBy?.name || "",
        note: p.note || "",

        // Booking-level ledger (same values on every row of the same booking)
        ...ledger,
      };
    });

    const summary = summaryAgg[0] || {
      totalAmount: 0,
      totalCash: 0,
      totalPhonePe: 0,
      totalRazorpay: 0,
      totalCollected: 0,
      totalCollectedPhonePe: 0,
      collectedCount: 0,
    };
    delete summary._id;

    return res.status(200).json({
      success: true,
      columns: ALL_BOOKING_PAYMENT_COLUMNS,
      rows,
      summary: {
        ...summary,
        count: total,
        pendingCount: total - summary.collectedCount,
        // Totals per distinct booking
        ledger: summarizeLedgers(ledgers),
        ledgerError,
        ledgerErrorMessage,
      },
      pagination: exportAll
        ? { total, page: 1, limit: total, totalPages: 1 }
        : {
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
          },
    });
  } catch (error) {
    console.error("getBookingPayments error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch booking payments" });
  }
};
// Aliases so older route imports keep working.
export const getBookingDashboard = getBookingDashboardRevenue;
export const getBookingsDashboard = getBookingDashboardRevenue;
