import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import Booking from "../models/booking.model.js";
import Handover from "../models/handover.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";
import RefundRequest from "../models/refundRequest.model.js";
import { createRefundRequest } from "../services/createRefundRequest.js";
import { getCurrentRefundableBalance } from "../services/refundBalance.js";
import {
  addDayKeys,
  dayStartIST,
  toDayKey,
} from "../utils/revenue.utils.js";

const REFUND_METHODS = new Set(["cash", "phonepe", "razorpay", "gpay"]);
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const companyFor = (user) => user.company || user.createdBy || user._id;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireObjectId(value, label) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
}

function validateHttpsImage(value, label, required = false) {
  const imageUrl = String(value || "").trim();
  if (!imageUrl && required) {
    throw new ApiError(400, `${label} is required.`);
  }
  if (!imageUrl) return "";
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    throw new ApiError(400, `${label} must be a valid HTTPS image URL.`);
  }
  if (imageUrl.length > 2048 || parsedUrl.protocol !== "https:") {
    throw new ApiError(400, `${label} must be a valid HTTPS image URL.`);
  }
  return imageUrl;
}

function summaryExpressions(today, monthStart, nextMonthStart) {
  const todayStart = dayStartIST(today);
  const tomorrowStart = dayStartIST(addDayKeys(today, 1));
  const monthStartDate = dayStartIST(monthStart);
  const nextMonthStartDate = dayStartIST(nextMonthStart);
  const refundedIn = (start, end) => ({
    $and: [
      { $in: ["$status", ["refunded", "Refunded"]] },
      { $gte: ["$refundedAt", start] },
      { $lt: ["$refundedAt", end] },
    ],
  });
  const amountWhen = (condition) => ({
    $sum: { $cond: [condition, "$amount", 0] },
  });
  const countWhen = (condition) => ({
    $sum: { $cond: [condition, 1, 0] },
  });
  const refundableRequests = {
    $in: ["$status", ["pending", "approved", "Pending", "Approved"]],
  };
  return {
      $group: {
        _id: null,
        refundedTodayAmount: amountWhen(refundedIn(todayStart, tomorrowStart)),
        refundedTodayCount: countWhen(refundedIn(todayStart, tomorrowStart)),
        refundedMonthAmount: amountWhen(
          refundedIn(monthStartDate, nextMonthStartDate),
        ),
        refundedMonthCount: countWhen(
          refundedIn(monthStartDate, nextMonthStartDate),
        ),
        toBePaidAmount: amountWhen(refundableRequests),
        toBePaidCount: countWhen(refundableRequests),
      },
    };
}

function requestView(request) {
  const booking =
    request.bookingId && typeof request.bookingId === "object" &&
      !mongoose.isObjectIdOrHexString(request.bookingId)
      ? request.bookingId
      : null;
  return {
    ...request,
    status: request.status?.charAt(0).toUpperCase() + request.status?.slice(1).toLowerCase(),
    bookingId: booking?._id || request.bookingId || null,
    booking: booking
      ? {
          _id: booking._id,
          bookingCode: booking.bookingCode || "",
          status: booking.status || "",
          fromDate: booking.fromDate || null,
          toDate: booking.toDate || null,
        }
      : null,
    customerName: request.customerName || booking?.customerName || "",
    customerMobile: request.customerMobile || booking?.mobileNumber || "",
    vehicleName: request.vehicleName || booking?.vehicleName || "",
    vehicleNumber: request.vehicleNumber || booking?.vehicleNumber || "",
    bookingAmount: request.bookingAmount || booking?.bookingAmount || 0,
    requestedAt: request.requestedAt || request.createdAt,
  };
}

export const getRefundRequests = async (req, res, next) => {
  try {
    const company = companyFor(req.user);
    const today = toDayKey(new Date());
    const [year, month] = today.slice(0, 7).split("-").map(Number);
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonthStart = new Date(Date.UTC(year, month, 1))
      .toISOString()
      .slice(0, 10);

    const [requests, summaryResult] = await Promise.all([
      RefundRequest.find({ company })
        .sort({ createdAt: -1, _id: -1 })
        .populate({
          path: "bookingId",
          select:
            "bookingCode customerName mobileNumber vehicleName vehicleNumber bookingAmount status fromDate toDate",
        })
        .populate("requestedBy", "fullName mobileNumber")
        .populate("approvedBy", "fullName")
        .populate("rejectedBy", "fullName")
        .populate("refundedBy", "fullName")
        .lean(),
      RefundRequest.aggregate([
        { $match: { company: new mongoose.Types.ObjectId(String(company)) } },
        summaryExpressions(today, monthStart, nextMonthStart),
      ]),
    ]);

    const summary = summaryResult[0] || {};
    return res.status(200).json({
      success: true,
      data: requests.map(requestView),
      summary: {
        refundedToday: {
          amount: summary.refundedTodayAmount || 0,
          count: summary.refundedTodayCount || 0,
        },
        thisMonth: {
          amount: summary.refundedMonthAmount || 0,
          count: summary.refundedMonthCount || 0,
        },
        toBePaid: {
          amount: summary.toBePaidAmount || 0,
          count: summary.toBePaidCount || 0,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getRefundRequestOptions = async (req, res, next) => {
  try {
    const company = companyFor(req.user);
    const search =
      typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    const query = search ? new RegExp(escapeRegex(search), "i") : null;
    const bookingFilter = {
      company,
      isDeleted: { $ne: true },
      ...(query && {
        $or: [
          { customerName: query },
          { mobileNumber: query },
          { vehicleName: query },
          { vehicleNumber: query },
          { bookingCode: query },
        ],
      }),
    };
    const handoverFilter = {
      company,
      isDeleted: { $ne: true },
      ...(query && {
        $or: [
          { "customer.fullName": query },
          { "customer.mobileNumber": query },
        ],
      }),
    };
    const [bookings, handovers] = await Promise.all([
      Booking.find(bookingFilter)
        .select(
          "bookingCode customerName mobileNumber vehicleName vehicleNumber bookingAmount fromDate toDate",
        )
        .sort({ createdAt: -1 })
        .limit(250)
        .lean(),
      Handover.find(handoverFilter)
        .select("customer.fullName customer.mobileNumber createdAt")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean(),
    ]);

    const customerMap = new Map();
    for (const booking of bookings) {
      const mobile = String(booking.mobileNumber || "").trim();
      if (!mobile) continue;
      if (!customerMap.has(mobile)) {
        customerMap.set(mobile, {
          mobileNumber: mobile,
          customerName: booking.customerName || "",
        });
      }
    }
    for (const handover of handovers) {
      const mobile = String(handover.customer?.mobileNumber || "").trim();
      if (!mobile) continue;
      if (!customerMap.has(mobile)) {
        customerMap.set(mobile, {
          mobileNumber: mobile,
          customerName: handover.customer?.fullName || "",
        });
      }
    }

    return res.status(200).json({
      success: true,
      customers: [...customerMap.values()],
      bookings: bookings.map((booking) => ({
        _id: booking._id,
        bookingCode: booking.bookingCode || "",
        customerName: booking.customerName || "",
        mobileNumber: booking.mobileNumber || "",
        vehicleName: booking.vehicleName || "",
        vehicleNumber: booking.vehicleNumber || "",
        bookingAmount: booking.bookingAmount || 0,
        fromDate: booking.fromDate || null,
        toDate: booking.toDate || null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const getBookingRefundBalance = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    requireObjectId(bookingId, "booking id");
    const company = companyFor(req.user);
    const booking = await Booking.findOne({
      _id: bookingId,
      company,
      isDeleted: { $ne: true },
    });
    if (!booking) throw new ApiError(404, "Booking not found.");
    const balance = await getCurrentRefundableBalance(booking, company);
    return res.status(200).json({ success: true, bookingId, ...balance });
  } catch (error) {
    next(error);
  }
};

function normalizeManualRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Invalid refund request details.");
  }
  if (
    typeof body.customerMobile !== "string" ||
    (body.bookingId !== undefined &&
      body.bookingId !== null &&
      typeof body.bookingId !== "string") ||
    (typeof body.amount !== "number" && typeof body.amount !== "string") ||
    typeof body.method !== "string" ||
    typeof body.reason !== "string" ||
    typeof body.idempotencyKey !== "string" ||
    (body.customerUpiId !== undefined &&
      body.customerUpiId !== null &&
      typeof body.customerUpiId !== "string") ||
    (body.proofImageUrl !== undefined &&
      body.proofImageUrl !== null &&
      typeof body.proofImageUrl !== "string")
  ) {
    throw new ApiError(400, "Refund request fields have invalid types.");
  }
  const customerMobile = String(body.customerMobile || "").trim();
  const bookingId = body.bookingId ? String(body.bookingId).trim() : "";
  const amount = Number(body.amount);
  const method = String(body.method || "").trim().toLowerCase();
  const customerUpiId = String(body.customerUpiId || "").trim();
  const reason = String(body.reason || "").trim();
  const idempotencyKey = String(body.idempotencyKey || "").trim();

  if (!/^[6-9]\d{9}$/.test(customerMobile)) {
    throw new ApiError(400, "Select a valid customer.");
  }
  if (bookingId) requireObjectId(bookingId, "booking id");
  if (!Number.isFinite(amount) || amount <= 0 || roundMoney(amount) !== amount) {
    throw new ApiError(
      400,
      "Refund amount must be positive with up to two decimals.",
    );
  }
  if (!REFUND_METHODS.has(method)) {
    throw new ApiError(400, "Select a valid refund method.");
  }
  if (
    customerUpiId &&
    (method === "cash" ||
      customerUpiId.length > 256 ||
      !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(customerUpiId))
  ) {
    throw new ApiError(400, "Enter a valid UPI ID for a digital refund method.");
  }
  if (!reason || reason.length > 500) {
    throw new ApiError(400, "Enter a refund reason (maximum 500 characters).");
  }
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
    throw new ApiError(400, "A valid request idempotency key is required.");
  }

  return {
    customerMobile,
    bookingId,
    amount: roundMoney(amount),
    method,
    customerUpiId,
    reason,
    idempotencyKey,
    proofImageUrl: validateHttpsImage(
      body.proofImageUrl,
      "Attachment",
      false,
    ),
  };
}

export const createManualRefundRequest = async (req, res, next) => {
  const company = companyFor(req.user);
  const session = await mongoose.startSession();
  let result;
  let requestKey;
  try {
    const input = normalizeManualRequest(req.body);
    requestKey = `manual:${company}:${input.idempotencyKey}`;

    await session.withTransaction(async () => {
      const existing = await RefundRequest.findOne({
        company,
        requestKey,
      }).session(session);
      if (existing) {
        result = { request: existing, replayed: true };
        return;
      }

      let customerName = "";
      let vehicleName = "";
      let vehicleNumber = "";
      let bookingAmount = 0;
      let booking = null;

      if (input.bookingId) {
        booking = await Booking.findOne({
          _id: input.bookingId,
          company,
          isDeleted: { $ne: true },
        }).session(session);
        if (!booking) throw new ApiError(404, "Booking not found.");
        if (String(booking.mobileNumber) !== input.customerMobile) {
          throw new ApiError(
            400,
            "The selected booking does not belong to this customer.",
          );
        }

        const lock = await Booking.updateOne(
          { _id: booking._id, company },
          { $inc: { __v: 1 } },
          { session, timestamps: false },
        );
        if (!lock.matchedCount) throw new ApiError(404, "Booking not found.");

        const balance = await getCurrentRefundableBalance(
          booking,
          company,
          session,
        );
        if (input.amount > balance.refundableAmount) {
          throw new ApiError(
            400,
            `Refund amount exceeds the current refundable balance of ₹${balance.refundableAmount.toLocaleString("en-IN")}.`,
          );
        }
        customerName = booking.customerName || "";
        vehicleName = booking.vehicleName || "";
        vehicleNumber = booking.vehicleNumber || "";
        bookingAmount = Number(booking.bookingAmount) || 0;
      } else {
        const customerBooking = await Booking.findOne({
          company,
          mobileNumber: input.customerMobile,
          isDeleted: { $ne: true },
        })
          .sort({ createdAt: -1 })
          .select("customerName")
          .session(session)
          .lean();
        const handover = await Handover.findOne({
          company,
          "customer.mobileNumber": input.customerMobile,
          isDeleted: { $ne: true },
        })
          .sort({ createdAt: -1 })
          .select("customer.fullName")
          .session(session)
          .lean();
        customerName =
          customerBooking?.customerName || handover?.customer?.fullName || "";
        if (!customerName) {
          throw new ApiError(
            400,
            "Select a customer with a booking or handover in this account.",
          );
        }
      }

      const request = await createRefundRequest({
        booking,
        actor: req.user,
        session,
        details: {
          company,
          requestKey,
          source: "Manual",
          customerName,
          customerMobile: input.customerMobile,
          vehicleName,
          vehicleNumber,
          bookingAmount,
          amount: input.amount,
          method: input.method,
          customerUpiId: input.customerUpiId,
          proofImageUrl: input.proofImageUrl,
          reason: input.reason,
        },
      });
      result = { request, replayed: false };
    });

    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: requestView(result.request.toObject()),
    });
  } catch (error) {
    if (error?.code === 11000 && requestKey) {
      try {
        const existing = await RefundRequest.findOne({
          company,
          requestKey,
        }).lean();
        if (existing) {
          return res.status(200).json({
            success: true,
            replayed: true,
            data: requestView(existing),
          });
        }
      } catch (lookupError) {
        return next(lookupError);
      }
      return next(new ApiError(409, "This refund request was already submitted."));
    }
    return next(error);
  } finally {
    await session.endSession();
  }
};

async function updateRequest(req, res, next, action) {
  const { id } = req.params;
  const company = companyFor(req.user);
  requireObjectId(id, "refund request id");
  const session = await mongoose.startSession();
  let result;
  try {
    const reason =
      action === "reject" ? String(req.body?.reason || "").trim() : "";
    if (
      action === "reject" &&
      req.body?.reason !== undefined &&
      typeof req.body.reason !== "string"
    ) {
      throw new ApiError(400, "Rejection reason must be text.");
    }
    if (action === "reject" && (!reason || reason.length > 500)) {
      throw new ApiError(400, "Enter a rejection reason (maximum 500 characters).");
    }
    const completionProofImageUrl =
      action === "refund"
        ? validateHttpsImage(
            req.body?.completionProofImageUrl,
            "Refund proof image",
            true,
          )
        : "";
    const utr =
      action === "refund" ? String(req.body?.utr || "").trim() : "";
    if (
      action === "refund" &&
      req.body?.utr !== undefined &&
      typeof req.body.utr !== "string"
    ) {
      throw new ApiError(400, "UTR/reference must be text.");
    }
    if (
      action === "refund" &&
      req.body?.completionProofImageUrl !== undefined &&
      typeof req.body.completionProofImageUrl !== "string"
    ) {
      throw new ApiError(400, "Refund proof image URL must be text.");
    }
    if (utr.length > 120) throw new ApiError(400, "UTR/reference is too long.");

    await session.withTransaction(async () => {
      const request = await RefundRequest.findOne({
        _id: id,
        company,
      }).session(session);
      if (!request) throw new ApiError(404, "Refund request not found.");

      // Existing screens use title case; accept both historical and contract statuses.
      request.status = request.status.charAt(0).toUpperCase() + request.status.slice(1).toLowerCase();

      if (action === "approve") {
        if (request.status === "Approved") {
          result = { request, replayed: true };
          return;
        }
        if (request.status !== "Pending") {
          throw new ApiError(409, "Only pending requests can be approved.");
        }
        request.status = "Approved";
        request.approvedBy = req.user._id;
        request.approvedAt = new Date();
      } else if (action === "reject") {
        if (request.status === "Rejected") {
          result = { request, replayed: true };
          return;
        }
        if (!["Pending", "Approved"].includes(request.status)) {
          throw new ApiError(409, "This refund request can no longer be rejected.");
        }
        request.status = "Rejected";
        request.rejectedBy = req.user._id;
        request.rejectedAt = new Date();
        request.rejectionReason = reason;
      } else {
        if (request.status === "Refunded") {
          result = { request, replayed: true };
          return;
        }
        if (request.status !== "Approved") {
          throw new ApiError(409, "Only approved requests can be marked refunded.");
        }
        if (
          request.proofImageUrl &&
          completionProofImageUrl === request.proofImageUrl
        ) {
          throw new ApiError(
            400,
            "Upload separate proof that the refund payment was completed.",
          );
        }
        const refundedAt = new Date();
        request.status = "Refunded";
        request.refundedBy = req.user._id;
        request.refundedAt = refundedAt;
        request.completionProofImageUrl = completionProofImageUrl;
        request.utr = utr;
        request.transactionReference = utr;

        if (request.bookingId) {
          const booking = await Booking.findOne({
            _id: request.bookingId,
            company,
            isDeleted: { $ne: true },
          }).session(session);
          if (!booking) {
            throw new ApiError(
              409,
              "The linked booking is no longer available; the refund was not recorded.",
            );
          }
          await PaymentHistory.create(
            [
              {
                company,
                bookingId: booking._id,
                refundRequestId: request._id,
                customer: {
                  fullName: request.customerName || booking.customerName,
                  mobileNumber: request.customerMobile || booking.mobileNumber,
                },
                vehicle: {
                  vehicleId: booking.vehicleId,
                  vehicleName: request.vehicleName || booking.vehicleName,
                  vehicleNumber: request.vehicleNumber || booking.vehicleNumber,
                },
                booking: {
                  fromDate: booking.fromDate,
                  toDate: booking.toDate,
                  bookingAmount: request.bookingAmount || booking.bookingAmount || 0,
                },
                amount: request.amount,
                paymentMethod: request.method,
                transactionId: utr,
                type: "refund",
                note: `Refund request ${request._id} completed`,
                createdBy: req.user._id,
                paymentDate: refundedAt,
                customPaymentDate: refundedAt,
              },
            ],
            { session },
          );
        }
      }

      request.statusHistory.push({
        status: request.status.toLowerCase(),
        by: req.user._id,
        byName: req.user.fullName || req.user.name || "",
        note: reason,
        at: new Date(),
      });
      await request.save({ session });
      result = { request, replayed: false };
    });

    return res.status(200).json({
      success: true,
      replayed: result.replayed,
      data: result.request,
      message:
        action === "refund"
          ? "Refund completion recorded."
          : action === "approve"
            ? "Refund request approved."
            : "Refund request rejected.",
    });
  } catch (error) {
    return next(error);
  } finally {
    await session.endSession();
  }
}

export const approveRefundRequest = (req, res, next) =>
  updateRequest(req, res, next, "approve");

export const rejectRefundRequest = (req, res, next) =>
  updateRequest(req, res, next, "reject");

export const markRefundRequestPaid = (req, res, next) =>
  updateRequest(req, res, next, "refund");
