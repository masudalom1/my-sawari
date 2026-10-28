// Keep in sync with the Operations frontend's utils/bookingDuration.mjs.
// Derive the effective return date once from the original calendar selection.
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

export function effectiveBookingEndDate(originalEndDate, flexibleTime, dropTime) {
  const original = calendarDay(originalEndDate);
  const drop = bookingTimeMinutes(dropTime);
  if (original === null || drop === null || typeof flexibleTime !== "boolean") return "";
  return new Date(original + (!flexibleTime && drop > 480 ? 86400000 : 0)).toISOString().slice(0, 10);
}

export function bookingDuration({ fromDate, toDate, originalEndDate = toDate, flexibleTime = false, pickupTime = "08:00 AM", dropTime = "08:00 AM" }) {
  const from = calendarDay(fromDate), original = calendarDay(originalEndDate);
  const enteredPickup = bookingTimeMinutes(pickupTime), dropMinutes = bookingTimeMinutes(dropTime);
  if (typeof flexibleTime !== "boolean" || from === null || original === null || original < from || enteredPickup === null || dropMinutes === null) return null;
  const effectiveEndDate = effectiveBookingEndDate(originalEndDate, flexibleTime, dropTime);
  const to = calendarDay(effectiveEndDate);
  if (to === null) return null;
  const pickupMinutes = flexibleTime ? enteredPickup : 8 * 60;
  if (to + dropMinutes * 60000 < from + pickupMinutes * 60000) return null;
  const baseDays = Math.max(1, Math.round((original - from) / 86400000));
  const days = Math.max(1, Math.round((to - from) / 86400000));
  return { baseDays, extraDays: days - baseDays, extensionDays: to > original ? 1 : 0, days, pickupMinutes, dropMinutes,
    originalEndDate: new Date(original).toISOString().slice(0, 10), effectiveEndDate };
}
