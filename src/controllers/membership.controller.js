import {
  isValidMembershipDate as isValidDate,
  lookupMembershipByMobile,
  MEMBERSHIP_AMBIGUITY_MESSAGE,
  normalizeMobileNumber,
} from "../services/membershipLookup.js";
import mongoose from "mongoose";
import Vehicle from "../models/vehicle.model.js";
import { lookupMembershipDiscount, membershipQuoteRentalDays } from "../services/membershipPricing.js";
export { normalizeMobileNumber, membershipStatus } from "../services/membershipLookup.js";

// Read-only server quote. Percentages, caps, eligibility and the stored vehicle
// rate are never accepted from the browser.
export const quoteMembershipDiscount = async (req, res) => {
  try {
    const { mobileNumber, vehicleId, fromDate, toDate, pickupCharge = 0, dropCharge = 0 } = req.body || {};
    if (!normalizeMobileNumber(mobileNumber)) return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number." });
    const days = membershipQuoteRentalDays(fromDate, toDate);
    if (!mongoose.isValidObjectId(vehicleId) || !days) return res.status(400).json({ success: false, message: "Select a vehicle and valid booking dates." });
    if (![pickupCharge, dropCharge].every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0)) {
      return res.status(400).json({ success: false, message: "Pickup and drop charges must be valid non-negative amounts." });
    }
    const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false }).select("pricePerDay").lean();
    if (!vehicle) return res.status(404).json({ success: false, message: "Vehicle not found." });
    const eligibleBase = Number(vehicle.pricePerDay || 0) * days + pickupCharge + dropCharge;
    const { discount } = await lookupMembershipDiscount(mobileNumber, eligibleBase);
    return res.json({ success: true, discount });
  } catch (error) {
    if (error?.statusCode === 409) return res.status(409).json({ success: false, message: error.message });
    console.error("Membership discount quote failed");
    return res.status(500).json({ success: false, message: "Unable to calculate membership discount. Please try again." });
  }
};

// POST /api/v1/memberships/check   { mobileNumber }
// Read-only. Returns only what the booking form displays: never payment
// details or other customer data.
export const checkMembership = async (req, res) => {
  try {
    const mobileNumber = normalizeMobileNumber(req.body?.mobileNumber);

    if (!mobileNumber) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 10-digit mobile number.",
      });
    }

    const { status, membership } = await lookupMembershipByMobile(mobileNumber);

    if (status === "customer_not_found") {
      return res.status(200).json({
        success: true,
        status: "customer_not_found",
      });
    }

    // The shared customer collection does not enforce phone uniqueness here.
    // Never choose one person's membership when a number maps to two records.
    if (status === "ambiguous") {
      return res.status(409).json({
        success: false,
        message: MEMBERSHIP_AMBIGUITY_MESSAGE,
      });
    }

    if (status === "none") {
      return res.status(200).json({
        success: true,
        status,
      });
    }

    const result = {
      success: true,
      status,
      membership: {
        membershipId: membership.membershipId || "",
        plan: membership.plan || "",
        activatedAt: isValidDate(membership.activatedAt) ? membership.activatedAt : null,
        expiresAt: isValidDate(membership.expiresAt) ? membership.expiresAt : null,
        totalSaved: Number.isFinite(membership.totalSaved) ? membership.totalSaved : null,
      },
    };

    // A found record must not be presented as missing. Explain why it is not
    // eligible without exposing payment details or relaxing activation rules.
    if (status === "inactive") {
      result.reason = membership.payment?.status !== "completed"
        ? "payment_unverified"
        : !isValidDate(membership.activatedAt) || !isValidDate(membership.expiresAt)
          ? "incomplete_dates"
          : "activation_scheduled";
    }

    return res.status(200).json(result);
  } catch {
    // Database errors can embed query values, including the mobile number.
    console.error("Check Membership Error: lookup failed");

    return res.status(500).json({
      success: false,
      message: "Unable to check membership. Please try again.",
    });
  }
};
