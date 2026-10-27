// Mirrors the customer backend's src/config/membership-plans.js and
// src/modules/bookings/booking.money.js (membershipDiscountFor).
// Keep the catalogue on the server; the booking preview receives these terms
// from the authenticated lookup instead of maintaining separate percentages.
export const MEMBERSHIP_DISCOUNT_PLANS = Object.freeze({
  starter: Object.freeze({ discountRate: 0.05, tripCap: 499, annualCap: 10000 }),
  plus: Object.freeze({ discountRate: 0.10, tripCap: 799, annualCap: 15000 }),
  pro: Object.freeze({ discountRate: 0.125, tripCap: 999, annualCap: 20000 }),
});

export function membershipDiscountTerms(membership, now = new Date()) {
  const plan = membership && Object.hasOwn(MEMBERSHIP_DISCOUNT_PLANS, membership.plan)
    ? MEMBERSHIP_DISCOUNT_PLANS[membership.plan]
    : null;
  if (!plan || !membership.expiresAt || !(new Date(membership.expiresAt) > now)) return null;
  const saved = Number(membership.totalSaved || 0);
  if (!Number.isFinite(saved)) return null;
  return {
    ...plan,
    remainingAnnualCap: Math.max(0, plan.annualCap - saved),
  };
}

export function membershipDiscountFor(base, membership, now = new Date()) {
  const terms = membershipDiscountTerms(membership, now);
  if (!terms || !Number.isFinite(base) || base <= 0) return 0;
  return Math.min(
    Math.round(base * terms.discountRate),
    terms.tripCap,
    terms.remainingAnnualCap,
  );
}
