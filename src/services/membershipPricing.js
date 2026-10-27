import ApiError from "../utils/ApiError.js";
import { membershipDiscountFor, membershipDiscountTerms } from "../../shared/membershipDiscount.mjs";
import { lookupMembershipByMobile, membershipStatus, MEMBERSHIP_AMBIGUITY_MESSAGE } from "./membershipLookup.js";

export function priceMembershipDiscount(eligibleBase, membership, now = new Date()) {
  const terms = membershipStatus(membership, now) === "active"
    ? membershipDiscountTerms(membership, now)
    : null;
  if (!terms) return { eligible: false, amount: 0, eligibleBase };
  return {
    eligible: true,
    amount: membershipDiscountFor(eligibleBase, membership, now),
    eligibleBase,
    plan: membership.plan,
    ...terms,
    expiresAt: membership.expiresAt,
  };
}

export async function lookupMembershipDiscount(mobileNumber, eligibleBase, options = {}) {
  const result = await lookupMembershipByMobile(mobileNumber, options);
  if (result.status === "ambiguous") throw new ApiError(409, MEMBERSHIP_AMBIGUITY_MESSAGE);
  return { ...result, discount: priceMembershipDiscount(eligibleBase, result.membership) };
}

// Same calendar-day rule as Operations createBookings and the existing preview.
export function membershipQuoteRentalDays(fromDate, toDate) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
  };
  const from = parse(fromDate);
  const to = parse(toDate);
  if (!from || !to || to < from) return 0;
  return Math.max(1, Math.round((to - from) / 86400000));
}
