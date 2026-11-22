import { INTENT_SCORING_CONFIG } from "../config/intentScoring.js";

export function computeIntentScore(signals, config = INTENT_SCORING_CONFIG) {
  const points = config.points;
  const breakdown = {
    vehicleViews: Math.min(
      points.maxVehicleViews,
      Math.max(0, Number(signals.vehicleViews) || 0) * points.perVehicleView,
    ),
    repeatVehicleSession: signals.repeatVehicleSession
      ? points.repeatVehicleSession
      : 0,
    selectedRentalDates: signals.selectedRentalDates
      ? points.selectedRentalDates
      : 0,
    appliedSearchFilters: signals.appliedSearchFilters
      ? points.appliedSearchFilters
      : 0,
    checkedAvailability: signals.checkedAvailability
      ? points.checkedAvailability
      : 0,
    startedCheckout: signals.startedCheckout ? points.startedCheckout : 0,
    activeLast24Hours: signals.activeLast24Hours
      ? points.activeLast24Hours
      : 0,
  };
  const score = Math.min(
    config.maxScore,
    Object.values(breakdown).reduce((total, value) => total + value, 0),
  );
  const category = score >= config.hotThreshold
    ? "Hot Lead"
    : score >= config.warmThreshold
      ? "Warm Lead"
      : "Cold Lead";
  return { score, category, breakdown };
}
