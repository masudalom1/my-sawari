function readInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const hotThreshold = readInteger("BOOKING_INTENT_HOT_THRESHOLD", 75, 1, 100);
const warmThreshold = readInteger("BOOKING_INTENT_WARM_THRESHOLD", 40, 0, 99);
if (warmThreshold >= hotThreshold) {
  throw new Error("BOOKING_INTENT_WARM_THRESHOLD must be lower than the hot threshold");
}

export const INTENT_SCORING_CONFIG = Object.freeze({
  windowDays: readInteger("BOOKING_INTENT_WINDOW_DAYS", 30, 1, 365),
  maxScore: 100,
  hotThreshold,
  warmThreshold,
  points: Object.freeze({
    perVehicleView: readInteger("BOOKING_INTENT_VIEW_POINTS", 5, 0, 100),
    maxVehicleViews: readInteger("BOOKING_INTENT_VIEW_CAP", 20, 0, 100),
    repeatVehicleSession: readInteger("BOOKING_INTENT_REPEAT_SESSION_POINTS", 15, 0, 100),
    selectedRentalDates: readInteger("BOOKING_INTENT_DATES_POINTS", 15, 0, 100),
    appliedSearchFilters: readInteger("BOOKING_INTENT_FILTER_POINTS", 5, 0, 100),
    checkedAvailability: readInteger("BOOKING_INTENT_AVAILABILITY_POINTS", 15, 0, 100),
    startedCheckout: readInteger("BOOKING_INTENT_CHECKOUT_POINTS", 25, 0, 100),
    activeLast24Hours: readInteger("BOOKING_INTENT_ACTIVE_POINTS", 5, 0, 100),
  }),
});
