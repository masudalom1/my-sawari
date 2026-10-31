import Customer from "../models/customer.model.js";
import Membership from "../models/membership.model.js";

export const MEMBERSHIP_AMBIGUITY_MESSAGE = "More than one customer matches this mobile number. Please resolve the duplicate customer records before checking membership.";

export function normalizeMobileNumber(value) {
  if (typeof value !== "string" || !/^\+?[\d\s()-]+$/.test(value.trim())) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : "";
}

export const isValidMembershipDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

export function membershipStatus(membership, now = new Date()) {
  if (!membership) return "none";
  if (membership.payment?.status !== "completed") return "inactive";
  if (!isValidMembershipDate(membership.activatedAt) || !isValidMembershipDate(membership.expiresAt)) return "inactive";
  if (membership.activatedAt > now) return "inactive";
  return membership.expiresAt > now ? "active" : "expired";
}

// Shared by the read-only lookup and booking creation. Always resolves the
// actual Customer ObjectId first, with the same normalization/ambiguity guard.
export async function lookupMembershipByMobile(value, { session = null } = {}) {
  const mobileNumber = normalizeMobileNumber(value);
  if (!mobileNumber) return { status: "customer_not_found", membership: null };
  const customers = await Customer.find({ mobileNumber }).select("_id").limit(2).session(session).lean();
  if (!customers.length) return { status: "customer_not_found", membership: null };
  if (customers.length > 1) return { status: "ambiguous", membership: null };
  const membership = await Membership.findOne({ customerId: customers[0]._id })
    .select("membershipId plan activatedAt expiresAt totalSaved payment.status")
    .session(session)
    .lean();
  return { status: membershipStatus(membership), membership };
}
