import Customer from "../models/customer.model.js";
import Lead from "../models/lead.model.js";
import Vehicle from "../models/vehicle.model.js";
import RefundRequest from "../models/refundRequest.model.js";
import { normalizeMobileNumber } from "./membershipLookup.js";

// Both cancellation and Payments use the Refund model and the same write path.
export async function createRefundRequest({ booking, actor, details, session }) {
  let customer = null;
  let customerId = booking?.customerId || null;
  if (!customerId && booking?.lead) {
    const lead = await Lead.findOne({ _id: booking.lead, company: booking.company })
      .select("customerId").session(session).lean();
    customerId = lead?.customerId || null;
  }
  if (customerId) {
    customer = await Customer.findById(customerId).session(session).lean();
  } else {
    const mobile = normalizeMobileNumber(booking?.mobileNumber || details.customerMobile);
    if (mobile) {
      const matches = await Customer.find({
        mobileNumber: { $in: [mobile, `91${mobile}`, `+91${mobile}`, `+91 ${mobile}`, `${mobile.slice(0, 5)} ${mobile.slice(5)}`] },
      }).limit(2).session(session).lean();
      // Do not attach an ambiguous profile or invent a customer identity.
      if (matches.length === 1) {
        customer = matches[0];
        customerId = customer._id;
      }
    }
  }
  const vehicle = booking?.vehicleId && !booking.vehicleName
    ? await Vehicle.findOne({ _id: booking.vehicleId, company: booking.company })
      .select("vehicleName").session(session).lean()
    : null;
  const [request] = await RefundRequest.create([{
    ...details,
    company: booking?.company || details.company,
    bookingId: booking?._id || null,
    customerId,
    customerName: booking?.customerName || customer?.customerName || details.customerName || "",
    customerMobile: booking?.mobileNumber || customer?.mobileNumber || details.customerMobile || "",
    vehicleName: booking?.vehicleName || vehicle?.vehicleName || details.vehicleName || "",
    bookingAmount: booking ? Number(booking.bookingAmount) || 0 : details.bookingAmount || 0,
    refundSource: details.source === "Manual" ? "manual" : "cancellation",
    refundType: ["phonepe", "gpay"].includes(details.method) ? "upi" : details.method,
    upiId: details.customerUpiId || "",
    status: "pending",
    requestedBy: actor._id,
    statusHistory: [{
      status: "pending",
      by: actor._id,
      byName: actor.fullName || actor.name || "",
      note: details.reason || "",
      at: new Date(),
    }],
  }], { session });
  return request;
}
