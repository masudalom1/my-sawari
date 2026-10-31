// Keep in sync with the Operations frontend's utils/bookingDuration.mjs.
// Late return adds a billing day, never a day of vehicle occupancy.
export function bookingTimeMinutes(value) {
  const match = typeof value === "string" && value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return hour * 60 + minute;
}

function calendarDay(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) value = value.toISOString().slice(0, 10);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : null;
}

// Booking dates are UTC day keys; pickup/drop wall-clock times are in India.
export function bookingTimestamp(date, time) {
  const day = calendarDay(date), minutes = bookingTimeMinutes(time);
  return day === null || minutes === null ? NaN : day + (minutes - 330) * 60000;
}

export function hasExtraRentalDay({ flexibleTime, dropTime }) {
  const drop = bookingTimeMinutes(dropTime);
  return flexibleTime === false && drop !== null && drop > 8 * 60;
}

// Keep edit adjustments tied to the agreed rental rate, not today's fleet price.
export function extraRentalDayChange(booking, proposed) {
  const days = Number(hasExtraRentalDay(proposed)) - Number(hasExtraRentalDay(booking));
  const rent = Number(booking.payment?.vehicleRent);
  const billedDays = Number(booking.totalDays);
  const savedRate = booking.payment?.rentalRate;
  const rate = savedRate != null && Number.isFinite(Number(savedRate)) && Number(savedRate) >= 0
    ? Number(savedRate)
    : booking.payment?.vehicleRent != null && Number.isFinite(rent) && rent >= 0 &&
      Number.isInteger(billedDays) && billedDays > 0 ? rent / billedDays : null;
  return { days, rate, amount: rate === null ? null : Math.round(days * rate * 100) / 100 };
}

export function bookingDuration({ fromDate, toDate, flexibleTime = false, pickupTime = "08:00 AM", dropTime = "08:00 AM" }) {
  const from = calendarDay(fromDate), to = calendarDay(toDate);
  const pickupMinutes = bookingTimeMinutes(pickupTime), dropMinutes = bookingTimeMinutes(dropTime);
  if (typeof flexibleTime !== "boolean" || from === null || to === null || to < from || pickupMinutes === null || dropMinutes === null) return null;
  if (to + dropMinutes * 60000 < from + pickupMinutes * 60000) return null;
  const baseDays = Math.max(1, Math.round((to - from) / 86400000));
  const extraDays = hasExtraRentalDay({ flexibleTime, dropTime }) ? 1 : 0;
  return { baseDays, extraDays, days: baseDays + extraDays, pickupMinutes, dropMinutes };
}
