import mongoose from "mongoose";
import Booking from "../models/booking.model.js";
import User from "../models/user.model.js";
import Refund from "../models/refundRequest.model.js";

export const refundCompanyFor = user => user.company || user.createdBy || user._id;

// Match the existing protected SUPER_ADMIN policy; other users retain their
// record ownership restrictions in addition to route-level RBAC grants.
export const refundActionScope = (user, options) => user.role === "SUPER_ADMIN"
  ? Promise.resolve({}) : refundAccessMatch(refundCompanyFor(user), options);

export function refundActionView(request, permissions, inScope) {
  const canManage = Boolean(inScope && permissions["page.paymentsHistory.view"] && permissions["page.bookings.edit"]);
  const status = String(request.status || "pending").toLowerCase();
  const canRefund = Boolean(
    permissions["page.paymentsHistory.view"] &&
    permissions["page.bookings.edit"] &&
    permissions["page.dashboard.edit"]
  );
  return { canManage, allowedActions: {
    approve: canManage && status === "pending",
    reject: canManage && ["pending", "approved"].includes(status),
    refund: canRefund && status === "approved",
  } };
}

// An explicit refund company is authoritative. Historical null-company rows
// inherit a saved booking's company, including archives. Only when that booking
// is absent may a persisted creator's existing membership establish ownership.
// Actor names and later approval history never grant access.
export async function refundAccessMatch(company, { id, session = null } = {}) {
  company = new mongoose.Types.ObjectId(String(company));
  const legacy = await Refund.find({ company: null, ...(id && { _id: id }) })
    .select("bookingId createdBy").session(session).lean();
  if (!legacy.length) return { company };
  const validId = value => mongoose.isObjectIdOrHexString(value);
  const bookings = await Booking.find({ _id: { $in: legacy.map(row => row.bookingId).filter(validId) } })
    .select("company").session(session).lean();
  const creators = await User.find({ _id: { $in: legacy.map(row => row.createdBy).filter(validId) } })
    .select("company createdBy").session(session).lean();
  const bookingById = new Map(bookings.map(row => [String(row._id), row]));
  const creatorById = new Map(creators.map(row => [String(row._id), row]));
  const ids = legacy.filter(row => {
    const booking = bookingById.get(String(row.bookingId));
    if (booking) return String(booking.company) === String(company);
    const creator = creatorById.get(String(row.createdBy));
    return creator && String(refundCompanyFor(creator)) === String(company);
  }).map(row => row._id);
  return ids.length ? { $or: [{ company }, { company: null, _id: { $in: ids } }] } : { company };
}
