import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import Booking from "../models/booking.model.js";
import Handover from "../models/handover.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";
import RefundRequest from "../models/refundRequest.model.js";
import { createRefundRequest } from "../services/createRefundRequest.js";
import { refundRequestView as requestView } from "../services/refundRequestView.js";
import { refundActionScope, refundActionView, refundCompanyFor as companyFor } from "../services/refundAccess.js";
import { resolveRequestPermissions } from "../services/permissionResolver.js";
import axios from "axios";
import cloudinary from "../config/cloudinary.js";
import { getCurrentRefundableBalance } from "../services/refundBalance.js";
import {
  addDayKeys,
  dayStartIST,
  isValidDayKey,
  monthEndKey,
  toDayKey,
} from "../utils/revenue.utils.js";

const REFUND_METHODS = new Set(["cash", "phonepe", "razorpay", "gpay", "bank_transfer"]);
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

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

function populatedRequests(query) {
  return query.populate({
    path: "bookingId",
    select: "bookingCode customerName mobileNumber vehicleName vehicleNumber bookingAmount payment.bookingAmountPaid status fromDate toDate",
    transform: (booking, id) => booking || id,
  }).populate(["requestedBy", "approvedBy", "rejectedBy", "refundedBy", "statusHistory.by"].map((path) => ({
    path, select: "fullName", transform: (actor, id) => actor || id,
  })));
}

function parseRequestFilters(query) {
  const { q = "", status = "All", page = "1", limit = "20" } = query;
  const { period = "all", startDate, endDate } = query;
  if (typeof period !== "string" || !["all", "today", "yesterday", "month", "custom"].includes(period)) {
    throw new ApiError(400, "Invalid request date selection.");
  }
  let from;
  let to;
  const today = toDayKey(new Date());
  if (period === "custom") {
    if (!isValidDayKey(startDate) || !isValidDayKey(endDate)) {
      throw new ApiError(400, "Select valid From and To request dates.");
    }
    if (startDate > endDate) throw new ApiError(400, "From date must be on or before To date.");
    from = startDate;
    to = endDate;
  } else {
    if (startDate !== undefined || endDate !== undefined) {
      throw new ApiError(400, "From and To dates require Custom Range.");
    }
    if (period === "today") from = to = today;
    if (period === "yesterday") from = to = addDayKeys(today, -1);
    if (period === "month") { from = `${today.slice(0, 7)}-01`; to = monthEndKey(today); }
  }
  if (typeof q !== "string" || q.length > 120 || typeof status !== "string" ||
    !["all", "pending", "approved", "refunded", "rejected"].includes(status.toLowerCase())) {
    throw new ApiError(400, "Invalid refund request filters.");
  }
  if (typeof page !== "string" || typeof limit !== "string" ||
    !/^[1-9]\d*$/.test(page) || !/^[1-9]\d*$/.test(limit) ||
    !Number.isSafeInteger(Number(page) * Number(limit)) || Number(limit) > 100) {
    throw new ApiError(400, "Invalid refund request pagination.");
  }
  return { search: q.trim(), status: status.toLowerCase(), page: Number(page), limit: Number(limit),
    createdAt: from ? { $gte: dayStartIST(from), $lt: dayStartIST(addDayKeys(to, 1)) } : null };
}

function refundListPipeline(filters) {
  const pipeline = [{ $match: { ...(filters.createdAt && { createdAt: filters.createdAt }), ...(filters.status !== "all" && {
    status: { $in: [filters.status, filters.status[0].toUpperCase() + filters.status.slice(1)] },
  }) } }];
  if (filters.search) {
    // The route grants global finance read access; joins only enrich refunds.
    // Lookups happen before skip/limit so matches on later pages are retained.
    const firstText = (...fields) => fields.reduceRight((fallback, field) => ({
      $cond: [{ $ne: [{ $ifNull: [field, ""] }, ""] }, field, fallback],
    }), "");
    pipeline.push(
      { $set: { _requester: { $arrayElemAt: [{ $filter: {
        input: { $cond: [{ $isArray: "$statusHistory" }, "$statusHistory", []] }, as: "entry",
        cond: { $in: [{ $toLower: "$$entry.status" }, ["pending", "requested"]] },
      } }, 0] } } },
      { $lookup: { from: Booking.collection.name, let: { bookingId: "$bookingId" }, pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$bookingId"] } } },
        { $project: { customerName: 1, mobileNumber: 1, vehicleName: 1, vehicleNumber: 1, bookingCode: 1 } },
      ], as: "_booking" } },
      { $set: { _booking: { $arrayElemAt: ["$_booking", 0] } } },
      { $lookup: { from: "users", let: { initial: "$_requester.by", legacy: "$requestedBy" }, pipeline: [
        { $match: { $expr: { $in: ["$_id", [{ $ifNull: ["$$initial", null] }, { $ifNull: ["$$legacy", null] }]] } } },
        { $project: { fullName: 1 } },
      ], as: "_actors" } },
      { $set: {
        _initialActor: { $arrayElemAt: [{ $filter: { input: "$_actors", as: "actor", cond: { $eq: ["$$actor._id", "$_requester.by"] } } }, 0] },
        _legacyActor: { $arrayElemAt: [{ $filter: { input: "$_actors", as: "actor", cond: { $eq: ["$$actor._id", "$requestedBy"] } } }, 0] },
      } },
      { $set: { _search: [
        firstText("$customerName", "$_booking.customerName"), firstText("$customerMobile", "$_booking.mobileNumber"),
        "$upiId", "$customerUpiId", "$transactionReference", "$utr",
        firstText("$_requester.byName", "$_initialActor.fullName", "$_legacyActor.fullName"),
        { $ifNull: ["$reason", "$_requester.note"] }, firstText("$vehicleName", "$_booking.vehicleName"),
        firstText("$vehicleNumber", "$_booking.vehicleNumber"), "$_booking.bookingCode",
      ] } },
      { $match: { _search: new RegExp(escapeRegex(filters.search), "i") } },
    );
  }
  pipeline.push({ $sort: { createdAt: -1, _id: -1 } }, { $facet: {
    rows: [{ $skip: (filters.page - 1) * filters.limit }, { $limit: filters.limit }, { $project: { _id: 1 } }],
    count: [{ $count: "total" }],
  } });
  return pipeline;
}

export const getRefundRequests = async (req, res, next) => {
  try {
    const filters = parseRequestFilters(req.query);
    const today = toDayKey(new Date());
    const [year, month] = today.slice(0, 7).split("-").map(Number);
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonthStart = new Date(Date.UTC(year, month, 1))
      .toISOString()
      .slice(0, 10);

    const [listResult, summaryResult] = await Promise.all([
      RefundRequest.aggregate(refundListPipeline(filters)),
      RefundRequest.aggregate([
        { $set: { refundedAt: { $ifNull: ["$refundedAt", { $max: { $map: {
          input: { $filter: { input: { $cond: [{ $isArray: "$statusHistory" }, "$statusHistory", []] }, as: "event",
            cond: { $eq: [{ $toLower: "$$event.status" }, "refunded"] } } },
          as: "event", in: "$$event.at",
        } } }] } } },
        summaryExpressions(today, monthStart, nextMonthStart),
      ]),
    ]);

    const ids = (listResult[0]?.rows || []).map(row => row._id);
    const total = listResult[0]?.count[0]?.total || 0;
    const requests = await populatedRequests(RefundRequest.find({ _id: { $in: ids } })).lean();
    const { effectivePermissions } = await resolveRequestPermissions(req);
    const actionAccess = await refundActionScope(req.user);
    const actionable = new Set((await RefundRequest.find({ ...actionAccess, _id: { $in: ids } }).select("_id").lean()).map(row => String(row._id)));
    const byId = new Map(requests.map(request => [String(request._id), { ...requestView(request),
      ...refundActionView(request, effectivePermissions, actionable.has(String(request._id))) }]));

    const summary = summaryResult[0] || {};
    return res.status(200).json({
      success: true,
      data: ids.map(id => byId.get(String(id))).filter(Boolean),
      pagination: { page: filters.page, limit: filters.limit, total, totalPages: Math.ceil(total / filters.limit),
        hasNextPage: filters.page * filters.limit < total, hasPreviousPage: filters.page > 1 },
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

export const getRefundRequest = async (req, res, next) => {
  try {
    requireObjectId(req.params.id, "refund request id");
    const request = await populatedRequests(RefundRequest.findById(req.params.id)).lean();
    if (!request) throw new ApiError(404, "Refund request not found.");
    const { effectivePermissions } = await resolveRequestPermissions(req);
    const actionAccess = await refundActionScope(req.user, { id: req.params.id });
    const inScope = Boolean(await RefundRequest.exists({ ...actionAccess, _id: req.params.id }));
    return res.status(200).json({ success: true, data: { ...requestView(request), ...refundActionView(request, effectivePermissions, inScope) } });
  } catch (error) { next(error); }
};

export const getRefundAttachment = async (req, res, next) => {
  try {
    requireObjectId(req.params.id, "refund request id");
    const fields = { customer: "proofImageUrl", completion: "completionProofImageUrl" };
    const field = fields[req.params.kind];
    if (!field) throw new ApiError(404, "Attachment not found.");
    const request = await RefundRequest.findById(req.params.id)
      .select("company proofImageUrl completionProofImageUrl").lean();
    if (!request?.[field]) throw new ApiError(404, "Attachment not found.");
    let url;
    try { url = new URL(request[field]); }
    catch { throw new ApiError(422, "Invalid legacy attachment reference."); }
    const cloudName = cloudinary.config().cloud_name;
    const prefix = `/${cloudName}/image/`;
    if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" ||
      url.port || url.username || url.password || !url.pathname.startsWith(prefix)) {
      throw new ApiError(422, "This legacy attachment needs to be moved to the approved file store.");
    }
    const [delivery, ...segments] = url.pathname.slice(prefix.length).split("/");
    if (!["upload", "authenticated"].includes(delivery)) {
      throw new ApiError(422, "Unsupported attachment storage type.");
    }
    let downloadUrl = url.href;
    if (delivery === "authenticated") {
      if (segments[0]?.startsWith("s--")) segments.shift();
      if (/^v\d+$/.test(segments[0])) segments.shift();
      const publicId = segments.join("/");
      const storedCompany = request.company || publicId.split("/")[2];
      const tenantFolder = `my-sawari/refunds/${storedCompany}/`;
      if (!mongoose.isObjectIdOrHexString(storedCompany) || !publicId.startsWith(tenantFolder) || !/^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/i.test(publicId.slice(tenantFolder.length))) {
        throw new ApiError(422, "Invalid attachment reference.");
      }
      downloadUrl = cloudinary.url(publicId, { secure: true, sign_url: true, type: "authenticated", resource_type: "image" });
    }
    const image = await axios.get(downloadUrl, {
      responseType: "arraybuffer", timeout: 15000, maxContentLength: 10 * 1024 * 1024,
      maxRedirects: 0,
    });
    const contentType = String(image.headers["content-type"] || "").split(";")[0];
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      throw new ApiError(422, "The attachment is not a supported image.");
    }
    res.set({ "Content-Type": contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
    return res.status(200).send(Buffer.from(image.data));
  } catch (error) { next(error); }
};

export const uploadRefundAttachment = (req, res, next) => {
  if (!req.file?.path) return next(new ApiError(400, "An image is required."));
  return res.status(201).json({ success: true, url: req.file.path });
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
          { "vehicle.vehicleName": query },
          { "vehicle.vehicleNumber": query },
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
        .select("bookingId customer.fullName customer.mobileNumber vehicle.vehicleName vehicle.vehicleNumber trip.pickupDateTime trip.dropDateTime bookingStatus handoverStatus createdAt")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
    for (const bookingId of handovers.map((handover) => handover.bookingId).filter(Boolean)) {
      if (!bookingById.has(String(bookingId))) {
        const saved = await Booking.findOne({
          _id: bookingId,
          company,
          isDeleted: { $ne: true },
        }).select("bookingCode customerName mobileNumber vehicleName vehicleNumber bookingAmount fromDate toDate").lean();
        if (saved) bookingById.set(String(saved._id), saved);
      }
    }
    const handoversWithoutBooking = handovers
      .filter((handover) => !handover.bookingId)
      .map((handover) => handover._id);
    if (handoversWithoutBooking.length) {
      const linkedBookings = await Booking.find({
        handover: { $in: handoversWithoutBooking },
        company,
        isDeleted: { $ne: true },
      }).select("bookingCode customerName mobileNumber vehicleName vehicleNumber bookingAmount fromDate toDate handover").lean();
      for (const booking of linkedBookings) {
        bookingById.set(String(booking._id), booking);
        bookingById.set(`handover:${booking.handover}`, booking);
      }
    }

    const balanceByBooking = new Map();
    const handoverRows = [];
    for (const handover of handovers) {
      const booking = handover.bookingId
        ? bookingById.get(String(handover.bookingId))
        : bookingById.get(`handover:${handover._id}`);
      if (!booking) continue;
      if (!balanceByBooking.has(String(booking._id))) {
        const balance = await getCurrentRefundableBalance(booking, company);
        balanceByBooking.set(String(booking._id), balance);
      }
      const balance = balanceByBooking.get(String(booking._id));
      handoverRows.push({
        _id: handover._id,
        bookingId: booking._id,
        bookingCode: booking.bookingCode || "",
        customerName: handover.customer?.fullName || booking.customerName || "",
        mobileNumber: handover.customer?.mobileNumber || booking.mobileNumber || "",
        vehicleName: handover.vehicle?.vehicleName || booking.vehicleName || "",
        vehicleNumber: handover.vehicle?.vehicleNumber || booking.vehicleNumber || "",
        rentalStatus: handover.handoverStatus || handover.bookingStatus || "active",
        bookingStatus: handover.bookingStatus || booking.status || "",
        fromDate: handover.trip?.pickupDateTime || booking.fromDate || null,
        toDate: handover.trip?.dropDateTime || booking.toDate || null,
        bookingAmount: booking.bookingAmount || 0,
        refundableAmount: Number(balance?.refundableAmount) || 0,
        collectedAmount: Number(balance?.collectedAmount) || 0,
        completedRefundAmount: Number(balance?.completedRefundAmount) || 0,
        reservedAmount: Number(balance?.reservedAmount) || 0,
        refundDueAmount: Number(balance?.refundDueAmount) ||
          Math.max(0, Number(balance?.collectedAmount) - Number(balance?.completedRefundAmount)),
      });
    }

    const searchedHandovers = search
      ? handoverRows.filter((handover) =>
          [handover.customerName, handover.mobileNumber, handover.vehicleName, handover.vehicleNumber, handover.bookingCode]
            .some((value) => new RegExp(escapeRegex(search), "i").test(String(value || ""))),
        )
      : handoverRows;

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
      handovers: searchedHandovers,
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
    (body.handoverId !== undefined &&
      body.handoverId !== null &&
      typeof body.handoverId !== "string") ||
    (typeof body.amount !== "number" && typeof body.amount !== "string") ||
    typeof body.method !== "string" ||
    typeof body.reason !== "string" ||
    typeof body.idempotencyKey !== "string" ||
    (body.customerUpiId !== undefined &&
      body.customerUpiId !== null &&
      typeof body.customerUpiId !== "string") ||
    (body.accountDetails !== undefined &&
      body.accountDetails !== null &&
      (typeof body.accountDetails !== "object" || Array.isArray(body.accountDetails))) ||
    (body.proofImageUrl !== undefined &&
      body.proofImageUrl !== null &&
      typeof body.proofImageUrl !== "string")
  ) {
    throw new ApiError(400, "Refund request fields have invalid types.");
  }
  const customerMobile = String(body.customerMobile || "").trim();
  const bookingId = body.bookingId ? String(body.bookingId).trim() : "";
  const handoverId = body.handoverId ? String(body.handoverId).trim() : "";
  const amount = Number(body.amount);
  const method = String(body.method || "").trim().toLowerCase();
  const customerUpiId = String(body.customerUpiId || "").trim();
  const accountDetails = body.accountDetails && typeof body.accountDetails === "object"
    ? body.accountDetails
    : {};
  for (const [key, value] of Object.entries(accountDetails)) {
    if (typeof value !== "string") {
      throw new ApiError(400, "Bank account details must be text.");
    }
  }
  const normalizedAccountDetails = {
    accountHolderName: String(accountDetails.accountHolderName || "").trim(),
    accountNumber: String(accountDetails.accountNumber || "").trim(),
    ifscCode: String(accountDetails.ifscCode || "").trim(),
    bankName: String(accountDetails.bankName || "").trim(),
  };
  const reason = String(body.reason || "").trim();
  const idempotencyKey = String(body.idempotencyKey || "").trim();

  if (!/^[6-9]\d{9}$/.test(customerMobile)) {
    throw new ApiError(400, "Select a valid customer.");
  }
  if (bookingId) requireObjectId(bookingId, "booking id");
  if (handoverId) requireObjectId(handoverId, "handover id");
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
    (["cash", "bank_transfer"].includes(method) ||
      customerUpiId.length > 256 ||
      !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(customerUpiId))
  ) {
    throw new ApiError(400, "Enter a valid UPI ID for a digital refund method.");
  }
  if (method === "bank_transfer") {
    if (
      !normalizedAccountDetails.accountHolderName ||
      !normalizedAccountDetails.accountNumber ||
      !normalizedAccountDetails.ifscCode ||
      !normalizedAccountDetails.bankName
    ) {
      throw new ApiError(400, "Enter all required bank account details.");
    }
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
    handoverId,
    amount: roundMoney(amount),
    method,
    customerUpiId,
    accountDetails: normalizedAccountDetails,
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

      if (input.handoverId) {
        const handover = await Handover.findOne({
          _id: input.handoverId,
          company,
          isDeleted: { $ne: true },
        }).session(session);
        if (!handover) throw new ApiError(404, "Refundable handover not found.");
        if (String(handover.customer?.mobileNumber || "") !== input.customerMobile) {
          throw new ApiError(400, "The selected handover does not belong to this customer.");
        }
        const linkedBooking = handover.bookingId
          ? await Booking.findOne({
              _id: handover.bookingId,
              company,
              isDeleted: { $ne: true },
            }).select("_id").session(session)
          : await Booking.findOne({
              handover: handover._id,
              company,
              isDeleted: { $ne: true },
            }).select("_id").session(session);
        if (!linkedBooking) throw new ApiError(409, "The selected handover has no linked booking.");
        input.bookingId = String(linkedBooking._id);
      }

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
          const balanceError = new ApiError(
            409,
            `Refund amount exceeds the current refundable balance of ₹${balance.refundableAmount.toLocaleString("en-IN")}.`,
          );
          balanceError.balance = { bookingId: booking._id, ...balance };
          throw balanceError;
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
          accountDetails: input.accountDetails,
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
      let access = {};
      if (action !== "refund") {
        access = await refundActionScope(req.user, { id, session });
      } else {
        const { effectivePermissions } = await resolveRequestPermissions(req);
        if (
          effectivePermissions["page.paymentsHistory.view"] !== true ||
          effectivePermissions["page.bookings.edit"] !== true ||
          effectivePermissions["page.dashboard.edit"] !== true
        ) {
          throw new ApiError(403, "You do not have permission to mark this refund as refunded.");
        }
      }
      const request = await RefundRequest.findOne({
        _id: id,
        ...access,
      }).session(session);
      if (!request) throw new ApiError(404, "Refund request not found.");
      // Attribute only a verified legacy record, atomically with its action.
      if (action !== "refund" && !request.company && req.user.role !== "SUPER_ADMIN") {
        request.company = company;
      }

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
        const accountingError = detail => new ApiError(409,
          `Refund reference: ${request._id}. Linked booking: ${request.bookingId || "not saved"}. ` +
          `Refund accounting could not be recorded: ${detail} This request remains Approved; no refund was recorded. ` +
          "Ask an administrator to verify the original cancellation and payment records, restore the verified original booking from history or correct this refund's link, then retry.");
        const unresolvedBooking = () => accountingError(
          "The linked booking is unavailable. The existing refund ledger requires a saved booking and has no standalone accounting path against a refund ID.");
        const cancellation = request.refundSource ? request.refundSource === "cancellation" : request.source === "Booking Cancellation";
        if (!request.bookingId && cancellation) {
          throw unresolvedBooking();
        }
        const refundedAt = new Date();
        request.status = "Refunded";
        request.refundedBy = req.user._id;
        request.refundedAt = refundedAt;
        request.completionProofImageUrl = completionProofImageUrl;
        request.utr = utr;
        request.transactionReference = utr;

        if (request.bookingId) {
          // The refund's action scope was authorized above. Its saved booking
          // reference supplies accounting details, not another ownership gate.
          // Include cancelled and archived bookings without a company filter.
          const booking = await Booking.findById(request.bookingId).session(session);
          if (!booking) {
            throw unresolvedBooking();
          }
          const accountingCompany = request.company || booking.company;
          if (!accountingCompany) throw accountingError("Neither the refund nor its linked booking has an accounting company.");
          await PaymentHistory.create(
            [
              {
                company: accountingCompany,
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
                paymentMethod: request.method || request.refundType || "unknown",
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
        at: action === "refund" ? request.refundedAt : new Date(),
      });
      // Legacy null-company documents may receive status/audit updates without
      // inventing ownership or requiring unrelated historical fields to change.
      await request.save({ session, validateModifiedOnly: !request.company });
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
