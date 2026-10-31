// Keep validateBookingPaymentTime in sync with the Operations frontend's utils/bookingPaymentTime.mjs.
// HTML date/time controls contain India wall-clock time, never the browser's timezone.
export function validateBookingPaymentTime({ paymentMethod, bookingAmount, paymentDate, paymentTime }, now = new Date()) {
  const hasDate = paymentDate !== "" && paymentDate != null;
  const hasTime = paymentTime !== "" && paymentTime != null;
  if (!["phonepe", "gpay"].includes(paymentMethod) || (!(Number(bookingAmount) > 0) && !hasDate && !hasTime)) {
    return { error: "", collectedAt: null };
  }
  if (paymentDate === "" || paymentDate == null) {
    return { error: "Payment Date is required for PhonePe or GPay.", collectedAt: null };
  }
  const day = typeof paymentDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
    ? new Date(`${paymentDate}T00:00:00.000Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.getUTCFullYear() < 1 || day.toISOString().slice(0, 10) !== paymentDate) {
    return { error: "Enter a valid Payment Date (YYYY-MM-DD).", collectedAt: null };
  }
  if (paymentTime === "" || paymentTime == null) {
    return { error: "Payment Time is required for PhonePe or GPay.", collectedAt: null };
  }
  if (typeof paymentTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(paymentTime)) {
    return { error: "Enter a valid Payment Time (HH:MM).", collectedAt: null };
  }
  const collectedAt = new Date(`${paymentDate}T${paymentTime}:00+05:30`);
  if (collectedAt.getTime() > now.getTime()) {
    return { error: "Payment collection date and time cannot be in the future.", collectedAt: null };
  }
  return { error: "", collectedAt };
}

// Existing booking/payment fields store a 12-hour IST display string.
export function formatBookingPaymentTime(collectedAt) {
  return collectedAt.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace(/\s+/g, " ").toLowerCase();
}
