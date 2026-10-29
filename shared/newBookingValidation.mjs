// Validate form-backed fields before coercion, lookups or transactional writes.
// Date/time, availability, membership and payment-method rules remain in their
// existing validators and controller flow.
export function validateNewBookingFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Invalid booking payload.";
  for (const field of ["customerName", "mobileNumber", "alternateMobileNumber", "occupation", "aadhaarNumber", "drivingLicenseNumber", "destination", "pickupDropNotes", "upiLast4"]) {
    if (body[field] != null && typeof body[field] !== "string") return `Invalid ${field}: expected text.`;
  }
  if (body.tripType !== undefined && !["local", "outstation"].includes(body.tripType)) return "Invalid trip type.";
  if (body.pickupDropRequired !== undefined && typeof body.pickupDropRequired !== "boolean") return "Pickup/drop required must be a boolean.";
  if (body.serviceType !== undefined && !["pickup", "drop", "pickup_drop"].includes(body.serviceType)) return "Select a valid pickup/drop service type.";
  if (body.residents != null && body.residents !== "" && (
    !["string", "number"].includes(typeof body.residents) || !Number.isInteger(Number(body.residents)) || Number(body.residents) < 1
  )) return "Passengers / residents must be a positive integer.";

  const validAmount = value => value == null || value === "" || (
    ["number", "string"].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0
  );
  for (const [field, label] of [["bookingAmount", "Booking advance"], ["discountAmount", "Discount amount"], ["securityDeposit", "Security deposit"], ["fastagBalance", "FASTag amount"]]) {
    if (!validAmount(body[field])) return `${label} must be a finite, non-negative amount.`;
  }
  for (const leg of ["pickup", "drop"]) {
    const details = body[leg];
    if (details === undefined) continue;
    if (!details || typeof details !== "object" || Array.isArray(details)) return `Invalid ${leg} details.`;
    for (const field of ["location", "landmark", "mapLink"]) {
      if (details[field] != null && typeof details[field] !== "string") return `Invalid ${leg} ${field}: expected text.`;
    }
    if (!validAmount(details.charge)) return `${leg === "pickup" ? "Pickup" : "Drop"} charge must be a finite, non-negative amount.`;
    if (details.mapLink?.trim()) {
      try {
        if (!["https:", "http:"].includes(new URL(details.mapLink.trim()).protocol)) throw new Error("Invalid protocol");
      } catch {
        return `Enter a valid ${leg} map URL (http or https).`;
      }
    }
  }
  if (body.paymentBreakdown !== undefined) {
    const split = body.paymentBreakdown;
    if (!split || typeof split !== "object" || Array.isArray(split)) return "Invalid payment breakdown.";
    for (const channel of ["cash", "phonePe", "gpay", "razorpay"]) {
      if (!validAmount(split[channel])) return "Mixed payment amounts must be finite and non-negative.";
    }
  }
  return "";
}
