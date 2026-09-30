// utils/revenue.utils.js
// Pure helpers for revenue by vehicle. No database access here.
// Same definitions as the frontend engine.js:
//
//   Earned          non-refund payment amounts recorded (createdAt) in the range
//   Refunds         payments with type "refund"
//   Net revenue     earned - refunds
//   Collected       money actually collected against those payments
//   To collect      earned - collected, per payment, never below zero
//   Days on fleet   days the vehicle existed in the range, up to today
//   Service days    days touched by a maintenance record (not cancelled)
//   Target          pricePerDay x days on fleet (optionally without service days)
//   Profit / loss   net revenue - target
//   Booked days     booking days in range up to today; later ones are "upcoming"
//   Booking value   booking amount spread evenly over the booking's days
//   Utilisation     booked days / (days on fleet - service days)
//
// Every "day" is an IST calendar day ("YYYY-MM-DD"), whatever timezone the server runs in.

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+05:30
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_REVENUE_RANGE_DAYS = 6 * 366; // matches the "All years" preset

const pad = (n) => String(n).padStart(2, "0");
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- IST day keys
export function toDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

const keyToUtc = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

const utcToKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const addDayKeys = (key, n) => utcToKey(keyToUtc(key) + n * DAY_MS);

export const daysBetweenKeys = (a, b) => Math.round((keyToUtc(b) - keyToUtc(a)) / DAY_MS);

export const isValidDayKey = (key) =>
  typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key) && utcToKey(keyToUtc(key)) === key;

export const monthStartKey = (key) => `${key.slice(0, 7)}-01`;

export const monthEndKey = (key) => {
  const [y, m] = key.split("-").map(Number);
  return utcToKey(Date.UTC(y, m, 0));
};

export function* eachDayKey(fromKey, toKeyInclusive) {
  for (let t = keyToUtc(fromKey), end = keyToUtc(toKeyInclusive); t <= end; t += DAY_MS) yield utcToKey(t);
}

/** Real instant for 00:00:00.000 IST of a day key. */
export const dayStartIST = (key) => new Date(keyToUtc(key) - IST_OFFSET_MS);

/** Real instant for 23:59:59.999 IST of a day key. */
export const dayEndIST = (key) => new Date(keyToUtc(key) + DAY_MS - 1 - IST_OFFSET_MS);

/** Same "10:30 AM" rule as the frontend combineDateAndTime, built in IST. */
export function combineDayAndTimeIST(dateValue, timeValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return date;
  const match = String(timeValue || "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return date;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const period = match[3].toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return new Date(keyToUtc(toDayKey(date)) - IST_OFFSET_MS + (hours * 60 + minutes) * 60 * 1000);
}

/** Validates ?from=&to= and falls back to the current IST month. */
export function parseRevenueRange(query = {}) {
  const today = toDayKey(new Date());
  let from = query.from || monthStartKey(today);
  let to = query.to || monthEndKey(today);

  if (!isValidDayKey(from) || !isValidDayKey(to)) {
    return { error: "Invalid 'from' or 'to'. Use YYYY-MM-DD." };
  }
  if (from > to) [from, to] = [to, from];
  if (daysBetweenKeys(from, to) + 1 > MAX_REVENUE_RANGE_DAYS) {
    return { error: `Pick a range of ${MAX_REVENUE_RANGE_DAYS} days or less.` };
  }

  const excludeService = ["1", "true", "yes"].includes(String(query.excludeService || "").toLowerCase());
  return { from, to, today, excludeService };
}

// ---------------------------------------------------------------- payment / booking helpers
/** Mixed payments sometimes store only the breakdown, so fall back to its total. */
export function paymentAmount(p) {
  const amount = Number(p.amount) || 0;
  if (amount > 0) return amount;
  const b = p.paymentBreakdown || {};
  return (Number(b.cash) || 0) + (Number(b.phonePe) || 0) + (Number(b.razorpay) || 0);
}

/** Money actually collected for one payment. */
export function collectedOf(p, amount) {
  if (Array.isArray(p.collectionHistory) && p.collectionHistory.length) {
    return Math.min(p.collectionHistory.reduce((s, e) => s + (Number(e.amount) || 0), 0), amount);
  }
  if (p.isCollected) return amount;
  return Math.min((Number(p.collectedAmount) || 0) + (Number(p.collectedPhonePe) || 0), amount);
}

/** Fallback when no payment snapshot exists. Change the field names to match booking.payment. */
export function bookingAmountFromBooking(b) {
  const p = b.payment || {};
  return Number(p.totalAmount ?? p.total ?? p.bookingAmount ?? p.amount ?? 0) || 0;
}

const BIKE_RE = /hunter|avenis|ntorq|activa|splendor|pulsar|classic|scooty|jupiter/i;
export const vehicleCategory = (v) =>
  v.category === "car" || v.category === "bike" ? v.category : BIKE_RE.test(v.vehicleName || "") ? "bike" : "car";

// ---------------------------------------------------------------- totals
export const emptyRevenueTotals = () => ({
  gross: 0,
  refunds: 0,
  collected: 0,
  pending: 0,
  expected: 0,
  fleetDays: 0,
  serviceDays: 0,
  bookedDays: 0,
  upcomingDays: 0,
  bookingValue: 0,
  bookingsCount: 0,
  paymentsCount: 0,
});

export function finalizeRevenueTotals(t) {
  const net = t.gross - t.refunds;
  const profitLoss = net - t.expected;
  const availableDays = Math.max(t.fleetDays - t.serviceDays, 0);
  return {
    gross: r2(t.gross),
    refunds: r2(t.refunds),
    net: r2(net),
    collected: r2(t.collected),
    pending: r2(t.pending),
    collectionRate: t.gross > 0 ? r2((t.collected / t.gross) * 100) : null,
    expected: r2(t.expected),
    profitLoss: r2(profitLoss),
    achievement: t.expected > 0 ? r2((net / t.expected) * 100) : null,
    status: t.expected <= 0 ? "no_target" : profitLoss >= 0 ? "profit" : "loss",
    fleetDays: t.fleetDays,
    serviceDays: t.serviceDays,
    availableDays,
    bookedDays: t.bookedDays,
    upcomingDays: t.upcomingDays,
    idleDays: Math.max(availableDays - t.bookedDays, 0),
    utilization: availableDays > 0 ? r2(Math.min((t.bookedDays / availableDays) * 100, 100)) : 0,
    avgPerDay: t.fleetDays > 0 ? r2(net / t.fleetDays) : 0,
    bookingValue: r2(t.bookingValue),
    bookingsCount: t.bookingsCount,
    paymentsCount: t.paymentsCount,
  };
}

/** Sums totals across every vehicle. */
export function sumRevenueTotals(statsMap) {
  const grand = emptyRevenueTotals();
  for (const t of statsMap.values()) for (const k of Object.keys(grand)) grand[k] += t[k];
  return grand;
}

// ---------------------------------------------------------------- calculators
// Each one adds into `stats` (Map vehicleId -> totals) for the range { from, to, today }.

export function applyPayments(stats, payments, { from, to }) {
  for (const p of payments) {
    const s = stats.get(p.vehicleId);
    if (!s) continue; // vehicle has no rate
    const key = toDayKey(p.createdAt);
    if (!key || key < from || key > to) continue;

    const amount = paymentAmount(p);
    s.paymentsCount++;
    if (p.type === "refund") {
      s.refunds += amount;
    } else {
      const collected = collectedOf(p, amount);
      s.gross += amount;
      s.collected += collected;
      s.pending += Math.max(amount - collected, 0);
    }
  }
}

export function applyBookings(stats, bookings, { from, to, today }) {
  for (const bk of bookings) {
    const s = stats.get(bk.vehicleId);
    if (!s) continue;
    const lastKey = addDayKeys(bk.startKey, bk.totalDays - 1);
    if (lastKey < from || bk.startKey > to) continue;

    const perDay = bk.totalDays ? bk.amount / bk.totalDays : 0;
    const first = bk.startKey < from ? from : bk.startKey;
    const last = lastKey > to ? to : lastKey;
    for (const d of eachDayKey(first, last)) {
      if (d > today) s.upcomingDays++;
      else s.bookedDays++;
      s.bookingValue += perDay;
    }
    s.bookingsCount++;
  }
}

/** Target + days on fleet + service days. Never counts future days or days before the vehicle was added. */
export function applyFleetDays(stats, vehicles, serviceDays, { from, to, today, excludeService }) {
  const lastCountable = to < today ? to : today;
  if (from > lastCountable) return;

  for (const v of vehicles) {
    const id = String(v._id);
    const s = stats.get(id);
    if (!s) continue;
    const createdKey = v.createdAt ? toDayKey(v.createdAt) : null;
    const first = createdKey && createdKey > from ? createdKey : from;
    if (first > lastCountable) continue;

    const service = serviceDays.get(id);
    const price = Number(v.pricePerDay) || 0;
    for (const d of eachDayKey(first, lastCountable)) {
      const inService = !!service?.has(d);
      s.fleetDays++;
      if (inService) s.serviceDays++;
      if (!(inService && excludeService)) s.expected += price;
    }
  }
}

/** One row for the "Revenue by vehicle" table. */
export const toRevenueRow = (v, totals) => ({
  id: String(v._id),
  name: v.vehicleName || "Unnamed vehicle",
  plate: v.vehicleNumber || "",
  image: v.images?.[0]?.url || null,
  category: vehicleCategory(v),
  vehicleType: v.vehicleType || "",
  pricePerDay: Number(v.pricePerDay) || 0,
  currentStatus: v.status,
  removed: false,
  ...finalizeRevenueTotals(totals),
});