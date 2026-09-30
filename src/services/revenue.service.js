// services/revenue.service.js
// Database reads for revenue by vehicle. Each loader only fetches records that touch the range.

import Vehicle from "../models/vehicle.model.js";
import Booking from "../models/booking.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";
import Maintenance from "../models/maintenance.model.js";
import {
  DAY_MS,
  toDayKey,
  dayStartIST,
  dayEndIST,
  eachDayKey,
  combineDayAndTimeIST,
  bookingAmountFromBooking,
} from "../utils/revenue.utils.js";

const BOOKING_PAD_MS = 2 * DAY_MS;

/** All active vehicles, with the fields revenue needs. */
export function loadRevenueVehicles() {
  return Vehicle.find({ isDeleted: false })
    .select("_id vehicleName vehicleNumber vehicleType category images status pricePerDay createdAt payments")
    .lean();
}

/** Payments in the range, each tied to an active vehicle (same linking rules as getPaymentsForImport). */
export async function loadRevenuePayments(vehicles, from, to) {
  const activeIds = vehicles.map((v) => v._id);
  const activeSet = new Set(activeIds.map(String));
  const paymentToVehicle = new Map();
  const linkedIds = [];
  for (const v of vehicles) {
    for (const pid of v.payments || []) {
      paymentToVehicle.set(String(pid), String(v._id));
      linkedIds.push(pid);
    }
  }

  const payments = await PaymentHistory.find({
    createdAt: { $gte: dayStartIST(from), $lte: dayEndIST(to) },
    $or: [
      ...(linkedIds.length ? [{ _id: { $in: linkedIds } }] : []),
      { "vehicle.vehicleId": { $in: activeIds } },
    ],
  })
    .select(
      "_id amount type paymentBreakdown isCollected collectedAmount collectedPhonePe collectionHistory.amount vehicle.vehicleId createdAt",
    )
    .lean();

  const out = [];
  for (const p of payments) {
    const snap = p.vehicle?.vehicleId ? String(p.vehicle.vehicleId) : null;
    const vehicleId = paymentToVehicle.get(String(p._id)) || (snap && activeSet.has(snap) ? snap : null);
    if (vehicleId) out.push({ ...p, vehicleId });
  }
  return out;
}

/** Non-cancelled bookings that can touch the range, as { vehicleId, startKey, totalDays, amount }. */
export async function loadRevenueBookings(vehicleIds, from, to) {
  const bookings = await Booking.find({
    isDeleted: false,
    status: { $ne: "cancelled" },
    vehicleId: { $in: vehicleIds },
    fromDate: { $lte: new Date(dayEndIST(to).getTime() + BOOKING_PAD_MS) },
    $or: [{ toDate: { $gte: new Date(dayStartIST(from).getTime() - BOOKING_PAD_MS) } }, { toDate: null }],
  })
    .select("_id vehicleId fromDate toDate pickupTime dropTime totalDays payment")
    .lean();

  if (!bookings.length) return [];

  // Latest bookingAmount snapshot per booking, from ALL its payments (not only those in range).
  const ids = bookings.map((b) => b._id);
  const snapshots = await PaymentHistory.aggregate([
    { $match: { bookingId: { $in: [...ids, ...ids.map(String)] } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { $toString: "$bookingId" }, amount: { $first: "$booking.bookingAmount" } } },
  ]);
  const snapshotById = new Map(snapshots.map((s) => [s._id, Number(s.amount) || 0]));

  const out = [];
  for (const b of bookings) {
    const start = combineDayAndTimeIST(b.fromDate, b.pickupTime);
    const end = combineDayAndTimeIST(b.toDate, b.dropTime);
    if (Number.isNaN(start.getTime())) continue;
    const totalDays =
      Number(b.totalDays) > 0
        ? Math.round(Number(b.totalDays))
        : Number.isNaN(end.getTime())
          ? 1
          : Math.max(1, Math.ceil((end - start) / DAY_MS));
    out.push({
      vehicleId: String(b.vehicleId),
      startKey: toDayKey(start),
      totalDays,
      amount: snapshotById.get(String(b._id)) || bookingAmountFromBooking(b),
    });
  }
  return out;
}

/** Map vehicleId -> Set of IST day keys (inside the range) covered by maintenance. */
export async function loadRevenueServiceDays(vehicleIds, from, to) {
  const records = await Maintenance.find({
    isDeleted: false,
    status: { $ne: "Cancelled" },
    vehicle: { $in: vehicleIds },
    startDate: { $lte: dayEndIST(to) },
    endDate: { $gt: dayStartIST(from) },
  })
    .select("vehicle startDate endDate")
    .lean();

  const map = new Map();
  for (const m of records) {
    const vid = String(m.vehicle || "");
    const start = new Date(m.startDate);
    const end = new Date(m.endDate);
    if (!vid || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    if (!map.has(vid)) map.set(vid, new Set());
    const set = map.get(vid);
    for (const d of eachDayKey(toDayKey(start), toDayKey(new Date(end.getTime() - 1)))) {
      if (d > to) break;
      if (d >= from) set.add(d);
    }
  }
  return map;
}