import mongoose from "mongoose";
import Maintenance from "../models/maintenance.model.js";
import Vehicle from "../models/vehicle.model.js";
import Booking from "../models/booking.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";

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
    const overdueCutoff = new Date(now.getTime() - OVERDUE_GRACE_HOURS * HOUR_MS);

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

      const start = combineISTDateAndTime(booking.fromDate, booking.pickupTime, {
        hour: 0,
        minute: 0,
      });
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
    const stats = new Map(rated.map((v) => [String(v._id), emptyRevenueTotals()]));
 
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

const BR_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const BR_BASES = ["booking", "created"];
const BR_RANGES = ["today", "7d", "month"];
const BR_IST_TZ = "+05:30";
 
const brPad = (n) => String(n).padStart(2, "0");
 
function brMonthKey(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${brPad(d.getUTCMonth() + 1)}`;
}
 
function brCurrentMonth(now) {
  const p = getISTParts(now);
  return brMonthKey(p.year, p.month);
}
 
function brPreviousMonth(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return brMonthKey(y, m - 2);
}
 
function brYearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => brMonthKey(year, i));
}
 
// Earliest start / latest end across months (UTC; trip dates are stored at UTC midnight).
function brMonthsDateSpan(months) {
  const starts = months.map((m) => {
    const [y, mo] = m.split("-").map(Number);
    return Date.UTC(y, mo - 1, 1);
  });
  const ends = months.map((m) => {
    const [y, mo] = m.split("-").map(Number);
    return Date.UTC(y, mo, 1);
  });
  return { start: new Date(Math.min(...starts)), end: new Date(Math.max(...ends)) };
}
 
function brISTDayKey(date) {
  const p = getISTParts(date);
  return `${p.year}-${brPad(p.month + 1)}-${brPad(p.day)}`;
}
 
function brGrowth(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
 
function brPct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
 
function brEscapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
 
// ------------------------------------------------------------
// QUERY
// ------------------------------------------------------------
 
// Returns { params } or { error }.
function parseBookingRevenueQuery(query = {}, now = new Date()) {
  const basis = query.basis ? String(query.basis).trim() : "booking";
  if (!BR_BASES.includes(basis)) {
    return { error: "basis must be 'booking' or 'created'." };
  }
 
  const range = query.range ? String(query.range).trim() : "month";
  if (!BR_RANGES.includes(range)) {
    return { error: "range must be 'today', '7d' or 'month'." };
  }
 
  const month = query.month ? String(query.month).trim() : brCurrentMonth(now);
  if (!BR_MONTH_REGEX.test(month)) {
    return { error: "month must be in YYYY-MM format." };
  }
 
  const defaultYear = basis === "booking" ? Number(month.slice(0, 4)) : getISTParts(now).year;
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
      page: Math.max(1, Number(query.page) || 1),
      limit: Math.min(100, Math.max(1, Number(query.limit) || 20)),
      status: query.status ? String(query.status).trim() : null,
      search: query.search ? String(query.search).trim() : null,
    },
  };
}
 
// ------------------------------------------------------------
// PERIODS
// ------------------------------------------------------------
 
// basis=booking: by resolved booking month.
function brBookingMonthPeriod({ month, year }) {
  const previousMonth = brPreviousMonth(month);
  const months = brYearMonths(year);
  const allMonths = [...new Set([month, previousMonth, ...months])];
  const { start, end } = brMonthsDateSpan(allMonths);
 
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
 
  return {
    // Index-friendly pre-filter; the exact month check happens after resolvedMonth is computed.
    prefilter: {
      $or: [
        { bookingMonth: { $in: allMonths } },
        { fromDate: { $gte: start, $lt: end } },
        { fromDate: null, toDate: { $gte: start, $lt: end } },
      ],
    },
    scope: { resolvedMonth: { $in: allMonths } },
    current: { resolvedMonth: month },
    previous: { resolvedMonth: previousMonth },
    trend: {
      granularity: "day",
      keyExpr: { $dateToString: { format: "%Y-%m-%d", date: "$fromDate", timezone: "UTC" } },
      buckets: Array.from({ length: daysInMonth }, (_, i) => `${month}-${brPad(i + 1)}`),
    },
    yearly: {
      months,
      match: { resolvedMonth: { $in: months } },
      keyExpr: "$resolvedMonth",
    },
    listSort: { fromDate: 1, createdAt: -1 },
    meta: { month, previousMonth },
  };
}
 
// basis=created: by createdAt in IST.
function brCreatedPeriod({ range, year }, now) {
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
    Math.min(prevStart.getTime() + (end.getTime() - start.getTime()), start.getTime()),
  );
 
  const yearStart = makeISTDate(year, 0, 1);
  const yearEnd = makeISTDate(year + 1, 0, 1);
 
  const lo = new Date(Math.min(prevStart.getTime(), yearStart.getTime()));
  const hi = new Date(Math.max(end.getTime(), yearEnd.getTime()));
 
  const todayKey = brISTDayKey(now);
 
  const buckets =
    granularity === "hour"
      ? Array.from({ length: p.hour + 1 }, (_, h) => `${todayKey}T${brPad(h)}`)
      : Array.from({ length: dayCount }, (_, i) =>
          brISTDayKey(new Date(start.getTime() + i * DAY_MS)),
        );
 
  return {
    prefilter: { createdAt: { $gte: lo, $lte: hi } },
    scope: null,
    current: { createdAt: { $gte: start, $lte: end } },
    previous: { createdAt: { $gte: prevStart, $lt: prevEnd } },
    trend: {
      granularity,
      keyExpr: {
        $dateToString: {
          format: granularity === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d",
          date: "$createdAt",
          timezone: BR_IST_TZ,
        },
      },
      buckets,
    },
    yearly: {
      months: brYearMonths(year),
      match: { createdAt: { $gte: yearStart, $lt: yearEnd } },
      keyExpr: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: BR_IST_TZ } },
    },
    listSort: { createdAt: -1 },
    meta: {
      range,
      month: brMonthKey(p.year, p.month),
      window: { start, end },
      previousWindow: { start: prevStart, end: prevEnd },
    },
  };
}
 
// ------------------------------------------------------------
// AGGREGATION EXPRESSIONS
// ------------------------------------------------------------
 
const BR_RESOLVED_MONTH = {
  $cond: [
    { $ne: [{ $ifNull: ["$bookingMonth", ""] }, ""] },
    "$bookingMonth",
    {
      $ifNull: [
        { $dateToString: { format: "%Y-%m", date: "$fromDate", timezone: "UTC" } },
        { $dateToString: { format: "%Y-%m", date: "$toDate", timezone: "UTC" } },
      ],
    },
  ],
};
 
const brNum = (expr) => ({ $ifNull: [expr, 0] });
 
// Breakdown total of one payment ("$$p").
const brBreakdownTotal = (v) => ({
  $add: [
    brNum(`${v}.paymentBreakdown.cash`),
    brNum(`${v}.paymentBreakdown.phonePe`),
    brNum(`${v}.paymentBreakdown.razorpay`),
  ],
});
 
// Amount of one payment: `amount`, or its breakdown total when amount is missing.
const brPaymentAmount = (v) => ({
  $cond: [{ $gt: [brNum(`${v}.amount`), 0] }, brNum(`${v}.amount`), brBreakdownTotal(v)],
});
 
// Channel share of one payment: breakdown when present, otherwise the whole
// amount goes to the payment method's channel.
const brPaymentChannel = (v, key, method) => ({
  $cond: [
    { $gt: [brBreakdownTotal(v), 0] },
    brNum(`${v}.paymentBreakdown.${key}`),
    { $cond: [{ $eq: [`${v}.paymentMethod`, method] }, brPaymentAmount(v), 0] },
  ],
});
 
const brPaymentOther = (v) => ({
  $cond: [
    {
      $and: [
        { $eq: [brBreakdownTotal(v), 0] },
        { $not: [{ $in: [`${v}.paymentMethod`, ["cash", "phonepe", "razorpay"]] }] },
      ],
    },
    brPaymentAmount(v),
    0,
  ],
});
 
const brSumOver = (input, expr) => ({
  $sum: { $map: { input, as: "p", in: expr } },
});
 
// Stage 1: raw booking money fields (with fallbacks for older documents).
function brBookingFieldsStage() {
  return {
    $addFields: {
      resolvedMonth: BR_RESOLVED_MONTH,
      _gross: { $ifNull: ["$payment.totalAmount", { $ifNull: ["$quotationAmount", 0] }] },
      _discount: { $ifNull: ["$payment.discountAmount", { $ifNull: ["$discountAmount", 0] }] },
      _advance: { $ifNull: ["$payment.bookingAmountPaid", { $ifNull: ["$bookingAmount", 0] }] },
      _deposit: { $ifNull: ["$payment.securityDeposit", { $ifNull: ["$securityDeposit", 0] }] },
      _days: { $ifNull: ["$totalDays", 1] },
      _isCancelled: { $eq: ["$status", "cancelled"] },
    },
  };
}
 
// Stage 2: every payment recorded against the booking.
function brPaymentsLookupStage() {
  return {
    $lookup: {
      from: PaymentHistory.collection.name,
      let: { bid: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$bookingId", "$$bid"] } } },
        { $project: { _id: 0, amount: 1, type: 1, paymentMethod: 1, paymentBreakdown: 1 } },
      ],
      as: "_payments",
    },
  };
}
 
// Stage 3: split payments into money in / refunds.
function brPaymentSplitStage() {
  return {
    $addFields: {
      _hasPayments: { $gt: [{ $size: "$_payments" }, 0] },
      _paymentsIn: {
        $filter: { input: "$_payments", as: "p", cond: { $ne: ["$$p.type", "refund"] } },
      },
      _paymentsOut: {
        $filter: { input: "$_payments", as: "p", cond: { $eq: ["$$p.type", "refund"] } },
      },
    },
  };
}
 
// Stage 4: received, refunded and channel totals per booking.
function brPaymentTotalsStage() {
  const bookingBreakdown = (key) => brNum(`$payment.paymentBreakdown.${key}`);
 
  return {
    $addFields: {
      _net: { $subtract: ["$_gross", "$_discount"] },
 
      // Bookings with no PaymentHistory records fall back to their advance.
      _received: {
        $cond: ["$_hasPayments", brSumOver("$_paymentsIn", brPaymentAmount("$$p")), "$_advance"],
      },
      _refunded: brSumOver("$_paymentsOut", brPaymentAmount("$$p")),
 
      _chCash: {
        $cond: [
          "$_hasPayments",
          brSumOver("$_paymentsIn", brPaymentChannel("$$p", "cash", "cash")),
          bookingBreakdown("cash"),
        ],
      },
      _chPhonePe: {
        $cond: [
          "$_hasPayments",
          brSumOver("$_paymentsIn", brPaymentChannel("$$p", "phonePe", "phonepe")),
          bookingBreakdown("phonePe"),
        ],
      },
      _chRazorpay: {
        $cond: [
          "$_hasPayments",
          brSumOver("$_paymentsIn", brPaymentChannel("$$p", "razorpay", "razorpay")),
          bookingBreakdown("razorpay"),
        ],
      },
      _chOther: {
        $cond: ["$_hasPayments", brSumOver("$_paymentsIn", brPaymentOther("$$p")), 0],
      },
    },
  };
}
 
// Stage 5: financial position per booking.
function brPositionStage() {
  const collected = { $subtract: ["$_received", "$_refunded"] };
 
  return {
    $addFields: {
      _collected: collected,
      _outstanding: {
        $cond: ["$_isCancelled", 0, { $max: [0, { $subtract: ["$_net", collected] }] }],
      },
      _extra: {
        $cond: ["$_isCancelled", 0, { $max: [0, { $subtract: [collected, "$_net"] }] }],
      },
      _retained: { $cond: ["$_isCancelled", { $max: [0, collected] }, 0] },
    },
  };
}
 
const BR_BILLABLE = { $not: ["$_isCancelled"] };
 
const brSumIfBillable = (field) => ({ $sum: { $cond: [BR_BILLABLE, field, 0] } });
const brCountIfStatus = (statuses) => ({
  $sum: { $cond: [{ $in: ["$status", statuses] }, 1, 0] },
});
 
const BR_KPI_GROUP = {
  totalBookings: { $sum: 1 },
  cancelledBookings: brCountIfStatus(["cancelled"]),
  completedBookings: brCountIfStatus(["completed"]),
  activeBookings: brCountIfStatus(HANDED_OVER_STATUSES),
  upcomingBookings: brCountIfStatus(["confirmed", "handover_pending"]),
 
  // Booked revenue (non-cancelled only)
  grossValue: brSumIfBillable("$_gross"),
  totalDiscount: brSumIfBillable("$_discount"),
  netRevenue: brSumIfBillable("$_net"),
 
  // Money position
  collected: brSumIfBillable("$_collected"),
  outstanding: { $sum: "$_outstanding" },
  extraCollected: { $sum: "$_extra" },
  cancellationRetained: { $sum: "$_retained" },
  refunded: { $sum: "$_refunded" },
 
  // Not revenue
  securityDeposits: brSumIfBillable("$_deposit"),
 
  rentalDays: brSumIfBillable("$_days"),
 
  // Money received by channel (all bookings, before refunds)
  channelCash: { $sum: "$_chCash" },
  channelPhonePe: { $sum: "$_chPhonePe" },
  channelRazorpay: { $sum: "$_chRazorpay" },
  channelOther: { $sum: "$_chOther" },
};
 
const BR_EMPTY_KPIS = Object.fromEntries(Object.keys(BR_KPI_GROUP).map((k) => [k, 0]));
 
function brListMatch(currentMatch, { status, search }) {
  const match = { ...currentMatch };
 
  if (status) match.status = status;
 
  if (search) {
    const regex = new RegExp(brEscapeRegex(search), "i");
    match.$or = [
      { customerName: regex },
      { mobileNumber: regex },
      { bookingCode: regex },
      { vehicleName: regex },
      { vehicleNumber: regex },
    ];
  }
 
  return match;
}
 
// ------------------------------------------------------------
// FACETS (one per dashboard section)
// ------------------------------------------------------------
 
const brKpiFacet = (match) => [{ $match: match }, { $group: { _id: null, ...BR_KPI_GROUP } }];
 
const brStatusFacet = (match) => [
  { $match: match },
  {
    $group: {
      _id: "$status",
      count: { $sum: 1 },
      revenue: brSumIfBillable("$_net"),
      collected: { $sum: "$_collected" },
    },
  },
  { $project: { _id: 0, status: "$_id", count: 1, revenue: 1, collected: 1 } },
  { $sort: { count: -1 } },
];
 
const brTopVehiclesFacet = (match, limit = 5) => [
  { $match: { ...match, status: { $ne: "cancelled" } } },
  {
    $group: {
      _id: "$vehicleId",
      vehicleName: { $first: "$vehicleName" },
      vehicleNumber: { $first: "$vehicleNumber" },
      bookings: { $sum: 1 },
      rentalDays: { $sum: "$_days" },
      revenue: { $sum: "$_net" },
      collected: { $sum: "$_collected" },
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
      bookings: 1,
      rentalDays: 1,
      revenue: 1,
      collected: 1,
    },
  },
];
 
const brTrendFacet = (match, keyExpr) => [
  { $match: { ...match, status: { $ne: "cancelled" } } },
  {
    $group: {
      _id: keyExpr,
      bookings: { $sum: 1 },
      revenue: { $sum: "$_net" },
      collected: { $sum: "$_collected" },
    },
  },
];
 
const brYearlyFacet = (match, keyExpr) => [
  { $match: match },
  { $group: { _id: keyExpr, ...BR_KPI_GROUP } },
];
 
const brListTotalFacet = (listMatch) => [{ $match: listMatch }, { $count: "count" }];
 
const brBookingsFacet = (listMatch, sort, page, limit) => [
  { $match: listMatch },
  { $sort: sort },
  { $skip: (page - 1) * limit },
  { $limit: limit },
  {
    $project: {
      bookingCode: 1,
      customerName: 1,
      mobileNumber: 1,
      vehicleId: 1,
      vehicleName: 1,
      vehicleNumber: 1,
      fromDate: 1,
      toDate: 1,
      pickupTime: 1,
      dropTime: 1,
      totalDays: 1,
      status: 1,
      bookingMonth: "$resolvedMonth",
      bookingMonthSource: {
        $cond: [{ $ne: [{ $ifNull: ["$bookingMonth", ""] }, ""] }, "field", "fromDate"],
      },
      grossAmount: "$_gross",
      discountAmount: "$_discount",
      netAmount: "$_net",
      collected: "$_collected",
      refunded: "$_refunded",
      outstanding: "$_outstanding",
      extraCollected: "$_extra",
      retained: "$_retained",
      securityDeposit: "$_deposit",
      paymentMethod: "$payment.paymentMethod",
      createdAt: 1,
    },
  },
];
 
// ------------------------------------------------------------
// RESULT SHAPERS
// ------------------------------------------------------------
 
function brFinalizeKpis(raw) {
  const k = { ...BR_EMPTY_KPIS, ...(raw || {}) };
  delete k._id;
 
  const billable = k.totalBookings - k.cancelledBookings;
 
  k.billableBookings = billable;
  k.avgBookingValue = billable ? Math.round(k.netRevenue / billable) : 0;
  k.avgRentalDays = billable ? Math.round((k.rentalDays / billable) * 10) / 10 : 0;
  k.collectionRate = brPct(k.collected, k.netRevenue);
  k.cancellationRate = brPct(k.cancelledBookings, k.totalBookings);
 
  // Everything actually kept: collected on live bookings + kept on cancellations.
  k.totalReceived = k.collected + k.cancellationRetained;
 
  return k;
}
 
function brPaymentMethods(k) {
  return {
    cash: k.channelCash,
    phonePe: k.channelPhonePe,
    razorpay: k.channelRazorpay,
    other: k.channelOther,
  };
}
 
function brBuildGrowth(current, previous) {
  return {
    totalBookings: brGrowth(current.totalBookings, previous.totalBookings),
    netRevenue: brGrowth(current.netRevenue, previous.netRevenue),
    collected: brGrowth(current.collected, previous.collected),
    avgBookingValue: brGrowth(current.avgBookingValue, previous.avgBookingValue),
    rentalDays: brGrowth(current.rentalDays, previous.rentalDays),
  };
}
 
// Zero-filled trend points.
function brBuildTrend(buckets, rows = []) {
  const byKey = new Map(rows.map((r) => [r._id, r]));
  return buckets.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      bookings: row?.bookings || 0,
      revenue: row?.revenue || 0,
      collected: row?.collected || 0,
    };
  });
}
 
function brBuildMonthlyTrend(months, rows = []) {
  const byMonth = new Map(rows.map((r) => [r._id, r]));
  return months.map((m) => ({ month: m, ...brFinalizeKpis(byMonth.get(m)) }));
}
 
function brBuildYearTotals(monthlyTrend) {
  return brFinalizeKpis(
    monthlyTrend.reduce((acc, m) => {
      Object.keys(BR_EMPTY_KPIS).forEach((key) => {
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
    basis === "created" ? brCreatedPeriod(params, now) : brBookingMonthPeriod(params);
 
  const listMatch = brListMatch(period.current, params);
 
  const pipeline = [
    {
      $match: {
        isDeleted: false,
        ...(companyId ? { company: companyId } : {}),
        ...period.prefilter,
      },
    },
    brBookingFieldsStage(),
  ];
 
  // Narrow to the needed months before joining payments.
  if (period.scope) pipeline.push({ $match: period.scope });
 
  pipeline.push(
    brPaymentsLookupStage(),
    brPaymentSplitStage(),
    brPaymentTotalsStage(),
    brPositionStage(),
    { $unset: ["_payments", "_paymentsIn", "_paymentsOut"] },
    {
      $facet: {
        current: brKpiFacet(period.current),
        previous: brKpiFacet(period.previous),
        statusBreakdown: brStatusFacet(period.current),
        topVehicles: brTopVehiclesFacet(period.current),
        trend: brTrendFacet(period.current, period.trend.keyExpr),
        yearly: brYearlyFacet(period.yearly.match, period.yearly.keyExpr),
        listTotal: brListTotalFacet(listMatch),
        bookings: brBookingsFacet(listMatch, period.listSort, page, limit),
      },
    },
  );
 
  const [result = {}] = await Booking.aggregate(pipeline);
 
  const kpis = brFinalizeKpis(result.current?.[0]);
  const previousKpis = brFinalizeKpis(result.previous?.[0]);
  const monthlyTrend = brBuildMonthlyTrend(period.yearly.months, result.yearly);
  const total = result.listTotal?.[0]?.count || 0;
 
  return {
    filters: {
      basis,
      year,
      status: params.status,
      search: params.search,
      timezone: "Asia/Kolkata",
      ...period.meta,
    },
    kpis,
    previousKpis,
    growth: brBuildGrowth(kpis, previousKpis),
    paymentMethods: brPaymentMethods(kpis),
    statusBreakdown: result.statusBreakdown || [],
    topVehicles: result.topVehicles || [],
    trend: {
      granularity: period.trend.granularity,
      points: brBuildTrend(period.trend.buckets, result.trend),
    },
    monthlyTrend,
    yearTotals: brBuildYearTotals(monthlyTrend),
    bookings: result.bookings || [],
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
 
// ============================================================
// GET /api/v1/dashboard/bookings
//
// ?basis=booking&month=2026-10
// ?basis=created&range=today|7d|month
// + &status=&search=&page=1&limit=20&year=
// ============================================================
 
export const getBookingDashboardRevenue = async (req, res) => {
  try {
    const now = new Date();
    const { params, error } = parseBookingRevenueQuery(req.query, now);
 
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }
 
    // Same company scoping as createBookings (company || user id).
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