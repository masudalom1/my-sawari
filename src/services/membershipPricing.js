import ApiError from "../utils/ApiError.js";
import { bookingDuration } from "../../shared/bookingDuration.mjs";
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

// Use the same billable duration as booking creation, including late-drop days.
export function membershipQuoteRentalDays(fromDate, toDate, times = {}) {
  return bookingDuration({ ...times, fromDate, toDate })?.days || 0;
}
