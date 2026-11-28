import { bookingTimestamp } from "./bookingDuration.mjs";

// A vehicle's deactivation date is its LAST bookable calendar day in the
// business timezone (India). The blocked period starts at 12:00 AM India time
// on the following day and never ends. The date is stored as a UTC day key,
// like booking fromDate/toDate.
// Keep in sync with the Operations frontend's utils/vehicleDeactivation.mjs.

// Reasons staff choose from when deactivating. "other" needs notes.
export const DEACTIVATION_REASONS = Object.freeze([
  { code: "vehicle_sold", label: "Vehicle sold" },
  { code: "temporarily_unavailable", label: "Temporarily unavailable" },
  { code: "ownership_changed", label: "Ownership changed" },
  { code: "long_term_maintenance", label: "Long-term maintenance" },
  { code: "removed_from_fleet", label: "Removed from fleet" },
  { code: "other", label: "Other" },
]);
export const DEACTIVATION_NOTES_MAX_LENGTH = 500;

export function isDeactivationReason(code) {
  return DEACTIVATION_REASONS.some((reason) => reason.code === code);
}

function dayKey(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const key = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

function nextDayKey(key) {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// "YYYY-MM-DD" of the last bookable day, or null when not deactivated.
export function vehicleDeactivationDate(vehicle) {
  return dayKey(vehicle?.deactivation?.date);
}

// Start of the blocked period for a deactivation date (YYYY-MM-DD or Date).
export function deactivationBlockStart(deactivationDate) {
  const key = dayKey(deactivationDate);
  if (!key) return null;
  const startsAt = bookingTimestamp(nextDayKey(key), "12:00 AM");
  return Number.isNaN(startsAt) ? null : startsAt;
}

export function vehicleDeactivationStartsAt(vehicle) {
  return deactivationBlockStart(vehicleDeactivationDate(vehicle));
}

// The blocked period is open-ended, so an interval overlaps it exactly when
// it ends after the block starts. A booking that ends at that midnight does
// not overlap (the same exact-boundary rule as booking overlaps); one that
// starts before the cutoff and continues past it does.
export function isBlockedByVehicleDeactivation(vehicle, intervalEnd) {
  const startsAt = vehicleDeactivationStartsAt(vehicle);
  const end = intervalEnd instanceof Date ? intervalEnd.getTime() : Number(intervalEnd);
  return startsAt !== null && end > startsAt;
}

const DAY_LABEL = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

// "28 Nov 2026" for a UTC day key, YYYY-MM-DD string, or Date.
export function deactivationDateLabel(value) {
  const key = dayKey(value);
  return key ? DAY_LABEL.format(new Date(`${key}T00:00:00.000Z`)) : String(value);
}

export function vehicleDeactivatedMessage(vehicle) {
  const label = deactivationDateLabel(vehicleDeactivationDate(vehicle));
  return `This vehicle is deactivated after ${label}. Choose dates that end by midnight at the end of ${label}, or another vehicle.`;
}

export function vehicleDeactivatedResponse(vehicle) {
  return {
    success: false,
    code: "VEHICLE_DEACTIVATED",
    message: vehicleDeactivatedMessage(vehicle),
    conflict: { deactivationDate: vehicleDeactivationDate(vehicle) },
  };
}
