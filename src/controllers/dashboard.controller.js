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