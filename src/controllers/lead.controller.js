import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import LeadHistory from "../models/leadHistory.model.js";
import Booking from "../models/booking.model.js";
import Vehicle from "../models/vehicle.model.js";
import Maintenance from "../models/maintenance.model.js";
import PaymentHistory,{toBookingMonth} from "../models/paymentHistory.model.js";
import { sendBookingCreatedMessage } from "../services/wati.service.js";

const dashboardCache = new Map();
const CACHE_TTL_MS = 8000;

export const invalidateBookingsCache = () => dashboardCache.clear();

const getISTDateString = (date) =>
  new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const OPEN_STATUSES_EXCLUDED = [
  "completed",
  "cancelled",
  "active",
  "vehicle_handover",
];

const TAB_BUCKETS = {
  All: null,
  Pending: ["pending"],
  "Today's Pickup": ["today"],
  "Tomorrow's Pickup": ["tomorrow"],
  Upcoming: ["today", "tomorrow", "upcoming"],
  "Active Rental": ["active"],
  Completed: ["completed"],
  Cancelled: ["cancelled"],
};

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATS_CACHE_TTL_MS = 8000;
const statsCache = new Map();

const getCachedStats = (key) => {
  const hit = statsCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  return null;
};

const setCachedStats = (key, data) => {
  statsCache.set(key, { data, expiresAt: Date.now() + STATS_CACHE_TTL_MS });
  if (statsCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of statsCache) {
      if (v.expiresAt <= now) statsCache.delete(k);
    }
  }
};

const EMPTY_STATS = {
  totalBookings: 0,
  pendingHandover: 0,
  todayPickup: 0,
  tomorrowPickup: 0,
  upcoming: 0,
  activeRentals: 0,
  completed: 0,
  cancelled: 0,
};

const bucketCountsToStats = (bucketCounts) => {
  const get = (b) => bucketCounts[b] || 0;
  const today = get("today");
  const tomorrow = get("tomorrow");
  const upcomingOnly = get("upcoming");
  return {
    totalBookings: Object.values(bucketCounts).reduce((a, b) => a + b, 0),
    pendingHandover: get("pending"),
    todayPickup: today,
    tomorrowPickup: tomorrow,
    upcoming: today + tomorrow + upcomingOnly,
    activeRentals: get("active"),
    completed: get("completed"),
    cancelled: get("cancelled"),
  };
};

const bucketingStages = (today, tomorrow) => [
  {
    $addFields: {
      pickupDateStr: {
        $cond: [
          { $ifNull: ["$fromDate", false] },
          {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$fromDate",
              timezone: "Asia/Kolkata",
            },
          },
          null,
        ],
      },
    },
  },
  {
    $addFields: {
      bucket: {
        $switch: {
          branches: [
            { case: { $eq: ["$status", "completed"] }, then: "completed" },
            { case: { $eq: ["$status", "cancelled"] }, then: "cancelled" },
            {
              case: { $in: ["$status", ["active", "vehicle_handover"]] },
              then: "active",
            },
            {
              case: {
                $and: [
                  { $not: [{ $in: ["$status", OPEN_STATUSES_EXCLUDED] }] },
                  { $ne: ["$pickupDateStr", null] },
                  { $lt: ["$pickupDateStr", today] },
                ],
              },
              then: "pending",
            },
            {
              case: {
                $and: [
                  { $not: [{ $in: ["$status", OPEN_STATUSES_EXCLUDED] }] },
                  { $eq: ["$pickupDateStr", today] },
                ],
              },
              then: "today",
            },
            {
              case: {
                $and: [
                  { $not: [{ $in: ["$status", OPEN_STATUSES_EXCLUDED] }] },
                  { $eq: ["$pickupDateStr", tomorrow] },
                ],
              },
              then: "tomorrow",
            },
            {
              case: {
                $and: [
                  { $not: [{ $in: ["$status", OPEN_STATUSES_EXCLUDED] }] },
                  { $ne: ["$pickupDateStr", null] },
                ],
              },
              then: "upcoming",
            },
          ],
          default: "confirmed",
        },
      },
      displayStatus: {
        $switch: {
          branches: [
            { case: { $eq: ["$status", "completed"] }, then: "Completed" },
            { case: { $eq: ["$status", "cancelled"] }, then: "Cancelled" },
            {
              case: { $in: ["$status", ["active", "vehicle_handover"]] },
              then: "Active Rental",
            },
          ],
          default: "Booking Confirmed",
        },
      },
    },
  },
];

export const createLead = async (req, res) => {
  try {
    const {
      leadDate,
      leadTime,

      customerName,
      mobileNumber,

      vehicleType,
      vehicleName,

      fromDate,
      toDate,
      residents,

      whatsappSent,

      priority,

      missedCalls,

      cabService,

      source,
      campaignName,
      utmSource,
      utmMedium,

      status,

      conversationSummary,
      detailedConversation,

      lastContactedDate,
      lastFollowupDate,
      nextFollowupDate,
      nextActionItem,

      mondayLead,
      longBookingLead,

      strategyForClosing,
      strategyPreparedBy,

      quotationSent,
      quotationAmount,

      bookingId,

      reasonForDealLoss,

      remarksFeedback,
      feedbackBy,

      notes,
    } = req.body;

    // =============================
    // Validation
    // =============================

    if (!customerName?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Customer name is required.",
      });
    }

    if (!mobileNumber?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required.",
      });
    }

    if (!vehicleType) {
      return res.status(400).json({
        success: false,
        message: "Vehicle type is required.",
      });
    }

    // =============================
    // Duplicate Check
    // =============================

    const companyId = req.user.company || req.user._id;

    const existingLead = await Lead.findOne({
      company: companyId,
      mobileNumber: mobileNumber.trim(),
      isDeleted: false,
      status: {
        $nin: ["Deal lost"],
      },
    });

    if (existingLead) {
      return res.status(409).json({
        success: false,
        message: "Lead already exists with this mobile number.",
        lead: existingLead,
      });
    }

    // =============================
    // Create Lead Instance
    // =============================

    const lead = new Lead({
      leadDate: leadDate || new Date(),
      leadTime,

      customerName: customerName.trim(),
      mobileNumber: mobileNumber.trim(),

      vehicleType,
      vehicleName,

      fromDate: fromDate || null,
      toDate: toDate || null,

      residents: Number(residents) || 1,

      whatsappSent: whatsappSent || false,

      priority: priority || "medium",

      leadOwner: req.user._id,

      missedCalls: Number(missedCalls) || 0,

      cabService: cabService || false,

      source: source || "other",
      campaignName,
      utmSource,
      utmMedium,

      status: status || "Enquiry",

      conversationSummary,
      detailedConversation: [],

      lastContactedDate: lastContactedDate || null,
      lastFollowupDate: lastFollowupDate || null,
      nextFollowupDate: nextFollowupDate || null,
      nextActionItem,

      mondayLead: mondayLead || false,
      longBookingLead: longBookingLead || false,

      strategyForClosing,
      strategyPreparedBy: strategyPreparedBy || "",

      quotationSent: quotationSent || false,
      quotationAmount: Number(quotationAmount) || 0,

      bookingId: bookingId || null,

      reasonForDealLoss: reasonForDealLoss || "",

      remarksFeedback,
      feedbackBy: feedbackBy || "",

      company: companyId,
      createdBy: req.user._id,
    });
    // =============================
    // Detailed Discussion Handling
    // =============================

    if (
      detailedConversation &&
      typeof detailedConversation === "string" &&
      detailedConversation.trim()
    ) {
      lead.detailedConversation.push({
        message: detailedConversation.trim(),
        addedBy: req.user._id,
        createdAt: new Date(),
      });
    }
    // =============================
    // Notes Array Handling
    // =============================

    if (notes && Array.isArray(notes) && notes.length > 0) {
      lead.notes = notes.map((note) => ({
        message: note.message,
        type: note.type || "call",
        addedBy: req.user._id,
      }));
    }

    // =============================
    // Auto Create Summary Note
    // =============================

    if (conversationSummary && conversationSummary.trim() !== "") {
      lead.notes.push({
        message: conversationSummary,
        type: "call",
        addedBy: req.user._id,
      });
    }

    // =============================
    // Database Commit
    // =============================

    await lead.save();

    // =============================
    // Populate Response Fields
    // =============================

    await lead.populate([
      {
        path: "leadOwner",
        select: "fullName email mobileNumber",
      },
      {
        path: "createdBy",
        select: "fullName email mobileNumber",
      },
      {
        path: "notes.addedBy",
        select: "fullName",
      },
      {
        path: "detailedConversation.addedBy",
        select: "fullName profileImage",
      },
    ]);

    // =============================
    // Return Response
    // =============================

    return res.status(201).json({
      success: true,
      message: "Lead created successfully.",
      data: lead,
    });
  } catch (error) {
    console.error("Create Lead Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create lead.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const getLeadDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(today.getDate() + 2);

    const baseQuery = { isDeleted: false };

    const [
      totalLeads,
      newLeads,
      todayFollowups,
      tomorrowFollowups,
      missedFollowups,
      quotationSent,
      bookingConfirmed,
      dealLost,
      highPriority,
      whatsappSent,
    ] = await Promise.all([
      Lead.countDocuments(baseQuery),
      Lead.countDocuments({ ...baseQuery, status: "Enquiry" }),
      Lead.countDocuments({
        ...baseQuery,
        nextFollowupDate: { $gte: today, $lt: tomorrow },
      }),
      Lead.countDocuments({
        ...baseQuery,
        nextFollowupDate: { $gte: tomorrow, $lt: dayAfterTomorrow },
      }),
      Lead.countDocuments({
        ...baseQuery,
        nextFollowupDate: { $lt: today },
        status: { $nin: ["Booking confirmed", "Deal lost"] },
      }),
      Lead.countDocuments({ ...baseQuery, quotationSent: true }),
      Lead.countDocuments({ ...baseQuery, status: "Booking confirmed" }),
      Lead.countDocuments({ ...baseQuery, status: "Deal lost" }),
      Lead.countDocuments({ ...baseQuery, priority: "high" }),
      Lead.countDocuments({ ...baseQuery, whatsappSent: true }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalLeads,
        newLeads,
        todayFollowups,
        tomorrowFollowups,
        missedFollowups,
        quotationSent,
        bookingConfirmed,
        dealLost,
        highPriority,
        whatsappSent,
      },
    });
  } catch (error) {
    console.error("Dashboard Stats Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch dashboard statistics.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const getLeads = async (req, res) => {
  try {
    let {
      page = 1,
      limit = 200,

      search = "",

      vehicleType,
      priority,

      // New Query Parameters
      status,
      dealLossReason,
      longBooking,
      mondayLead,

      tab = "all",

      dateField = "created",
      dateMode = "all",

      singleDate,
      fromDate,
      toDate,

      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    page = parseInt(page);
    limit = parseInt(limit);

    const query = {
      isDeleted: false,
    };

    // ==========================================
    // Search
    // ==========================================

    // Escaped: typed text such as "+91 98..." or "(" is not a valid regex.
    const searchTerm = escapeRegex(String(search || "").trim());

    if (searchTerm !== "") {
      query.$or = [
        { customerName: { $regex: searchTerm, $options: "i" } },
        { mobileNumber: { $regex: searchTerm, $options: "i" } },
        { vehicleName: { $regex: searchTerm, $options: "i" } },
      ];
    }

    // ==========================================
    // Vehicle Type
    // ==========================================

    if (
      vehicleType &&
      vehicleType !== "all" &&
      ["car", "bike"].includes(vehicleType)
    ) {
      query.vehicleType = vehicleType;
    }

    // ==========================================
    // Priority
    // ==========================================

    if (priority && priority !== "all") {
      query.priority = {
        $regex: new RegExp(`^${escapeRegex(String(priority))}$`, "i"),
      };
    }

    // ==========================================
    // Tabs (With Status Conflict Resolution)
    // ==========================================

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(today.getDate() + 2);

    switch (tab) {
      case "new":
        query.status = "Enquiry";
        break;

      case "today_followup":
        query.nextFollowupDate = { $gte: today, $lt: tomorrow };
        break;

      case "tomorrow_followup":
        query.nextFollowupDate = { $gte: tomorrow, $lt: dayAfterTomorrow };
        break;

      case "missed_followup":
        query.nextFollowupDate = { $lt: today };
        query.status = { $nin: ["Booking confirmed", "Deal lost"] };
        break;

      default:
        break;
    }

    // Fix Conflict: Custom Status Filter Overwrites Tab-assigned Status
    if (status && status !== "all") {
      // If they are on missed_followup, we keep the date filter but narrow or overwrite the status condition
      query.status = status;
    }

    // ==========================================
    // New Extended Filters
    // ==========================================

    // Deal Loss Reason
    if (dealLossReason && dealLossReason !== "all") {
      query.reasonForDealLoss = dealLossReason;
    }

    // Long Booking
    if (longBooking === "yes") {
      query.longBookingLead = true;
    } else if (longBooking === "no") {
      query.longBookingLead = false;
    }

    // Monday Lead
    if (mondayLead === "yes") {
      query.mondayLead = true;
    } else if (mondayLead === "no") {
      query.mondayLead = false;
    }

    // ==========================================
    // Date Filter
    // ==========================================

    let field = "createdAt";

    switch (dateField) {
      case "created":
        field = "createdAt";
        break;
      case "followup":
        field = "nextFollowupDate";
        break;
      case "pickup":
        field = "fromDate";
        break;
      case "dropoff":
        field = "toDate";
        break;
      case "booking":
        field = "bookingConfirmedAt";
        break;
      default:
        field = "createdAt";
    }

    if (dateMode === "single" && singleDate) {
      const start = new Date(singleDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(singleDate);
      end.setHours(23, 59, 59, 999);
      query[field] = { $gte: start, $lte: end };
    }

    if (dateMode === "range") {
      query[field] = {};
      if (fromDate) {
        const start = new Date(fromDate);
        start.setHours(0, 0, 0, 0);
        query[field].$gte = start;
      }
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query[field].$lte = end;
      }
      if (Object.keys(query[field]).length === 0) {
        delete query[field];
      }
    }

    // ==========================================
    // Sorting
    // ==========================================

    const allowedSortFields = [
      "createdAt",
      "updatedAt",
      "leadDate",
      "nextFollowupDate",
      "fromDate",
      "toDate",
      "priority",
    ];

    const sort = {
      [allowedSortFields.includes(sortBy) ? sortBy : "createdAt"]:
        sortOrder === "asc" ? 1 : -1,
    };

    // ==========================================
    // Database
    // ==========================================

    const total = await Lead.countDocuments(query);

    const leads = await Lead.find(query)
      .populate("leadOwner", "fullName email mobileNumber")
      .populate("createdBy", "fullName email mobileNumber")
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // ==========================================
    // Response
    // ==========================================

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      count: leads.length,
      data: leads,
    });
  } catch (error) {
    console.error("Get Leads Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch leads.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// dearch lead
export const checkLeadByMobile = async (req, res) => {
  try {
    const { mobile } = req.params;

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required.",
      });
    }

    const lead = await Lead.findOne({
      mobileNumber: mobile.trim(),
      isDeleted: false,
    })
      .select(
        "_id leadId customerName mobileNumber status priority vehicleType fromDate toDate createdAt",
      )
      .lean();

    if (!lead) {
      return res.status(200).json({
        success: true,
        exists: false,
      });
    }

    return res.status(200).json({
      success: true,
      exists: true,
      lead,
    });
  } catch (error) {
    console.error("Check Lead Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to search lead.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
// not in use
export const getLead = async (req, res) => {
  try {
    let {
      page = 1,
      limit = 20,

      search = "",

      vehicleType,
      priority,

      tab = "all",

      dateField = "created",
      dateMode = "all",

      singleDate,
      fromDate,
      toDate,

      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    page = parseInt(page);
    limit = parseInt(limit);

    const query = {
      isDeleted: false,
    };

    // ==========================================
    // Search
    // ==========================================

    if (search && search.trim() !== "") {
      query.$or = [
        { customerName: { $regex: search.trim(), $options: "i" } },
        { mobileNumber: { $regex: search.trim(), $options: "i" } },
        { vehicleName: { $regex: search.trim(), $options: "i" } },
      ];
    }

    // ==========================================
    // Vehicle Type
    // ==========================================

    if (
      vehicleType &&
      vehicleType !== "all" &&
      ["car", "bike"].includes(vehicleType)
    ) {
      query.vehicleType = vehicleType;
    }

    // ==========================================
    // Priority
    // ==========================================

    if (
      priority &&
      priority !== "all" &&
      ["low", "medium", "high"].includes(priority)
    ) {
      query.priority = priority;
    }

    // ==========================================
    // Tabs
    // ==========================================

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(today.getDate() + 2);

    switch (tab) {
      case "new":
        query.status = "Enquiry";
        break;

      case "today_followup":
        query.nextFollowupDate = { $gte: today, $lt: tomorrow };
        break;

      case "tomorrow_followup":
        query.nextFollowupDate = { $gte: tomorrow, $lt: dayAfterTomorrow };
        break;

      case "missed_followup":
        query.nextFollowupDate = { $lt: today };
        query.status = { $nin: ["Booking confirmed", "Deal lost"] };
        break;

      default:
        break;
    }

    // ==========================================
    // Date Filter
    // ==========================================

    let field = "createdAt";

    switch (dateField) {
      case "created":
        field = "createdAt";
        break;
      case "followup":
        field = "nextFollowupDate";
        break;
      case "pickup":
        field = "fromDate";
        break;
      case "dropoff":
        field = "toDate";
        break;
      case "booking":
        field = "bookingConfirmedAt";
        break;
      default:
        field = "createdAt";
    }

    if (dateMode === "single" && singleDate) {
      const start = new Date(singleDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(singleDate);
      end.setHours(23, 59, 59, 999);
      query[field] = { $gte: start, $lte: end };
    }

    if (dateMode === "range") {
      query[field] = {};
      if (fromDate) {
        const start = new Date(fromDate);
        start.setHours(0, 0, 0, 0);
        query[field].$gte = start;
      }
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query[field].$lte = end;
      }
      if (Object.keys(query[field]).length === 0) {
        delete query[field];
      }
    }

    // ==========================================
    // Sorting
    // ==========================================

    const allowedSortFields = [
      "createdAt",
      "updatedAt",
      "leadDate",
      "nextFollowupDate",
      "fromDate",
      "toDate",
      "priority",
    ];

    const sort = {
      [allowedSortFields.includes(sortBy) ? sortBy : "createdAt"]:
        sortOrder === "asc" ? 1 : -1,
    };

    // ==========================================
    // Database
    // ==========================================

    const total = await Lead.countDocuments(query);

    const leads = await Lead.find(query)
      .populate("leadOwner", "name email phone")
      .populate("createdBy", "name email phone")
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // ==========================================
    // Response
    // ==========================================

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      count: leads.length,
      data: leads,
    });
  } catch (error) {
    console.error("Get Leads Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch leads.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lead id.",
      });
    }

    const lead = await Lead.findOne({
      _id: id,
      isDeleted: false,
    })
      .populate("leadOwner", "fullName email mobileNumber profileImage")
      .populate("createdBy", "fullName email mobileNumber profileImage")
      .populate("notes.addedBy", "fullName profileImage")
      .populate(
        "detailedConversation.addedBy",
        "fullName email mobileNumber profileImage",
      );

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error) {
    console.error("Get Lead Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch lead.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lead id",
      });
    }

    const lead = await Lead.findById(id);

    if (!lead || lead.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const allowedFields = [
      "customerName",
      "mobileNumber",
      "vehicleType",
      "vehicleName",
      "fromDate",
      "toDate",
      "residents",
      "cabService",
      "priority",
      "status",
      "conversationSummary",
      "nextFollowupDate",
      "nextActionItem",
      "strategyForClosing",
      "strategyPreparedBy",
      "quotationAmount",
      "reasonForDealLoss",
      "remarksFeedback",
      "feedbackBy",
      "mondayLead",
      "longBookingLead",
      "whatsappSent",
      "quotationSent",
      "missedCalls",
      "leadTime",
      "source",
      "campaignName",
      "utmSource",
      "utmMedium",
    ];

    const historyLogs = [];

    const normalize = (value) => {
      if (value instanceof Date) return value.toISOString();

      if (value instanceof mongoose.Types.ObjectId) {
        return value.toString();
      }

      return String(value ?? "");
    };

    // Normal field updates
    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;

      const oldValue = lead[field];
      const newValue = req.body[field];

      if (normalize(oldValue) !== normalize(newValue)) {
        historyLogs.push({
          lead: lead._id,
          company: lead.company,
          field,
          oldValue,
          newValue,
          changedBy: req.user._id,
          action:
            field === "status"
              ? "status_changed"
              : field === "priority"
                ? "priority_changed"
                : "updated",
        });

        lead[field] = newValue;
      }
    }

    // Add Discussion (doesn't overwrite old ones)
    if (
      req.body.detailedConversation &&
      typeof req.body.detailedConversation === "string" &&
      req.body.detailedConversation.trim()
    ) {
      // Fix old leads that still have a string stored
      if (!Array.isArray(lead.detailedConversation)) {
        lead.detailedConversation = [];
      }

      lead.detailedConversation.push({
        message: req.body.detailedConversation.trim(),
        addedBy: req.user._id,
        createdAt: new Date(),
      });

      historyLogs.push({
        lead: lead._id,
        company: lead.company,
        field: "detailedConversation",
        oldValue: "",
        newValue: req.body.detailedConversation.trim(),
        changedBy: req.user._id,
        action: "updated",
      });
    }

    await lead.save();

    if (historyLogs.length) {
      await LeadHistory.insertMany(historyLogs);
    }

    const updatedLead = await Lead.findById(lead._id)
      .populate("leadOwner", "fullName email mobileNumber")
      .populate("createdBy", "fullName email mobileNumber")
      .populate("notes.addedBy", "fullName")
      .populate("detailedConversation.addedBy", "fullName profileImage email");

    return res.status(200).json({
      success: true,
      message: "Lead updated successfully",
      data: updatedLead,
    });
  } catch (error) {
    console.error("Update Lead Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update lead",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const getLeadHistory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lead id",
      });
    }

    const history = await LeadHistory.find({
      lead: id,
    })
      .populate("changedBy", "name email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch history.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
//v1.0 [not use]
export const getBookingsDashboards = async (req, res) => {
  try {
    const { tab = "All", search = "", page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 20, 1);

    const now = new Date();
    const today = getISTDateString(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = getISTDateString(tomorrowDate);

    const searchTerm = String(search || "").trim();
    const matchStage = { isDeleted: false };

    let searchMatch = null;
    if (searchTerm) {
      const regex = new RegExp(escapeRegex(searchTerm), "i");
      searchMatch = {
        $or: [
          { customerName: regex },
          { mobileNumber: regex },
          { alternateMobileNumber: regex },
          { bookingCode: regex },
          { vehicleName: regex },
          { vehicleNumber: regex },
          { destination: regex },
        ],
      };
    }

    const baseMatchStages = [
      { $match: matchStage },
      ...(searchMatch ? [{ $match: searchMatch }] : []),
    ];

    const statsCacheKey = `${today}|${searchTerm.toLowerCase()}`;
    let stats = getCachedStats(statsCacheKey);

    if (!stats) {
      const statsPipeline = [
        ...baseMatchStages,
        { $project: { status: 1, fromDate: 1 } },
        ...bucketingStages(today, tomorrow),
        { $group: { _id: "$bucket", count: { $sum: 1 } } },
      ];

      const statsRows = await Booking.aggregate(statsPipeline);
      const bucketCounts = {};
      statsRows.forEach((r) => {
        bucketCounts[r._id] = r.count;
      });
      stats = bucketCountsToStats(bucketCounts);
      setCachedStats(statsCacheKey, stats);
    }

    const allowedBuckets = Object.prototype.hasOwnProperty.call(
      TAB_BUCKETS,
      tab,
    )
      ? TAB_BUCKETS[tab]
      : null;

    const startIndex = (pageNum - 1) * limitNum;

    const pagePipeline = [
      ...baseMatchStages,
      ...bucketingStages(today, tomorrow),
      ...(allowedBuckets
        ? [{ $match: { bucket: { $in: allowedBuckets } } }]
        : []),
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [
            { $skip: startIndex },
            { $limit: limitNum },
            { $project: { _id: 1 } },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const [pageResult] = await Booking.aggregate(pagePipeline);
    const orderedIds = (pageResult?.data || []).map((d) => d._id);
    const total = pageResult?.totalCount?.[0]?.count || 0;
    const hasMore = startIndex + orderedIds.length < total;

    if (orderedIds.length === 0) {
      return res.status(200).json({
        success: true,
        stats,
        bookings: [],
        pagination: { page: pageNum, limit: limitNum, total, hasMore },
      });
    }

    const pageDocs = await Booking.find({ _id: { $in: orderedIds } })
      .select(
        [
          "bookingCode",
          "lead",
          "customerName",
          "mobileNumber",
          "alternateMobileNumber",
          "occupation",
          "destination",
          "aadhaarNumber",
          "drivingLicenseNumber",
          "tripType",
          "fromDate",
          "toDate",
          "pickupTime",
          "dropTime",
          "totalDays",
          "residents",
          "payment",
          "vehicleId",
          "vehicleName",
          "vehicleNumber",
          "vehicleColor",
          "status",
          "handover",
          "vehicleReturn",
          "pickupDropRequired",
          "serviceType",
          "pickup",
          "drop",
          "assignedDriver",
          "createdBy",
          "pickupDropNotes",
          "createdAt",
        ].join(" "),
      )
      .populate({
        path: "lead",
        select:
          "leadId priority source vehicleType bookingConfirmedAt leadOwner",
        populate: { path: "leadOwner", select: "name fullName" },
      })
      .populate({
        path: "vehicleId",
        select: "vehicleName vehicleNumber color",
      })
      .populate({ path: "createdBy", select: "name fullName" })
      .populate({
        path: "assignedDriver",
        select: "fullName name mobileNumber",
      })
      .lean();

    const byId = new Map(pageDocs.map((doc) => [String(doc._id), doc]));
    const orderedDocs = orderedIds
      .map((id) => byId.get(String(id)))
      .filter(Boolean);

    const bookings = orderedDocs.map((booking) => {
      let status = "Booking Confirmed";
      const isOpenBooking = !OPEN_STATUSES_EXCLUDED.includes(booking.status);

      if (booking.status === "completed") status = "Completed";
      else if (booking.status === "cancelled") status = "Cancelled";
      else if (["active", "vehicle_handover"].includes(booking.status))
        status = "Active Rental";
      else if (booking.fromDate && isOpenBooking) {
        const pickupDate = getISTDateString(booking.fromDate);
        if (pickupDate < today) status = "Pending Handover";
        else if (pickupDate === today) status = "Today's Pickup";
        else if (pickupDate === tomorrow) status = "Tomorrow's Pickup";
      }

      return {
        _id: booking._id,
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        leadId: booking.lead?.leadId || "",
        customerName: booking.customerName,
        mobileNumber: booking.mobileNumber,
        alternateMobileNumber: booking.alternateMobileNumber,
        occupation: booking.occupation,
        destination: booking.destination,
        aadhaarNumber: booking.aadhaarNumber,
        drivingLicenseNumber: booking.drivingLicenseNumber,
        tripType: booking.tripType,
        pickupDate: booking.fromDate,
        dropDate: booking.toDate,
        fromDate: booking.fromDate,
        toDate: booking.toDate,
        pickupTime: booking.pickupTime,
        dropTime: booking.dropTime,
        tripDays: booking.totalDays,
        totalDays: booking.totalDays,
        residents: booking.residents,
        quotationAmount: booking.payment?.totalAmount || 0,
        bookingAmount: booking.payment?.bookingAmountPaid || 0,
        discountAmount: booking.payment?.discountAmount || 0,
        fastagBalance: booking.payment?.fastagAmount || 0,
        securityDeposit: booking.payment?.securityDeposit || 0,
        payment: booking.payment || null,
        vehicleId: booking.vehicleId?._id || null,
        vehicleName: booking.vehicleId?.vehicleName || booking.vehicleName,
        vehicleNumber:
          booking.vehicleId?.vehicleNumber || booking.vehicleNumber,
        vehicleColor: booking.vehicleId?.color || booking.vehicleColor,
        vehicleType: booking.lead?.vehicleType || "",
        priority: booking.lead?.priority || "medium",
        source: booking.lead?.source || "",
        leadOwner:
          booking.lead?.leadOwner?.fullName ||
          booking.lead?.leadOwner?.name ||
          booking.createdBy?.fullName ||
          booking.createdBy?.name ||
          "",
        bookingConfirmedAt:
          booking.lead?.bookingConfirmedAt || booking.createdAt,
        status,
        bookingStatus: booking.status,
        handoverCompleted: booking.status !== "confirmed",
        handover: booking.handover,
        vehicleReturn: booking.vehicleReturn,
        pickupDropRequired: booking.pickupDropRequired,
        serviceType: booking.serviceType,
        pickup: booking.pickup,
        drop: booking.drop,
        assignedDriver: booking.assignedDriver
          ? {
              _id: booking.assignedDriver._id,
              fullName:
                booking.assignedDriver.fullName ||
                booking.assignedDriver.name ||
                "",
              mobileNumber: booking.assignedDriver.mobileNumber || "",
            }
          : null,
        pickupDropNotes: booking.pickupDropNotes,
        createdBy: booking.createdBy
          ? {
              _id: booking.createdBy._id,
              name: booking.createdBy.fullName || booking.createdBy.name || "",
            }
          : null,
        createdAt: booking.createdAt,
      };
    });

    return res.status(200).json({
      success: true,
      stats,
      bookings,
      pagination: { page: pageNum, limit: limitNum, total, hasMore },
    });
  } catch (error) {
    console.error("===== BOOKING DASHBOARD ERROR =====");
    console.error(error);
    console.error(error.stack);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch bookings.",
      error: error.message,
    });
  }
};
//v1.1 [use]
export const getBookingsDashboard = async (req, res) => {
  try {
    const { tab = "All", search = "", page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 20, 1);

    const now = new Date();
    const today = getISTDateString(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = getISTDateString(tomorrowDate);

    const searchTerm = String(search || "").trim();
    const matchStage = { isDeleted: false };

    let searchMatch = null;
    if (searchTerm) {
      const regex = new RegExp(escapeRegex(searchTerm), "i");
      searchMatch = {
        $or: [
          { customerName: regex },
          { mobileNumber: regex },
          { alternateMobileNumber: regex },
          { bookingCode: regex },
          { vehicleName: regex },
          { vehicleNumber: regex },
          { destination: regex },
        ],
      };
    }

    const baseMatchStages = [
      { $match: matchStage },
      ...(searchMatch ? [{ $match: searchMatch }] : []),
    ];

    const statsCacheKey = `${today}|${searchTerm.toLowerCase()}`;
    let stats = getCachedStats(statsCacheKey);

    if (!stats) {
      const statsPipeline = [
        ...baseMatchStages,
        { $project: { status: 1, fromDate: 1 } },
        ...bucketingStages(today, tomorrow),
        { $group: { _id: "$bucket", count: { $sum: 1 } } },
      ];

      const statsRows = await Booking.aggregate(statsPipeline);
      const bucketCounts = {};
      statsRows.forEach((r) => {
        bucketCounts[r._id] = r.count;
      });
      stats = bucketCountsToStats(bucketCounts);
      setCachedStats(statsCacheKey, stats);
    }

    const allowedBuckets = Object.prototype.hasOwnProperty.call(
      TAB_BUCKETS,
      tab,
    )
      ? TAB_BUCKETS[tab]
      : null;

    const startIndex = (pageNum - 1) * limitNum;

    const pagePipeline = [
      ...baseMatchStages,
      ...bucketingStages(today, tomorrow),
      ...(allowedBuckets
        ? [{ $match: { bucket: { $in: allowedBuckets } } }]
        : []),
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [
            { $skip: startIndex },
            { $limit: limitNum },
            { $project: { _id: 1 } },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const [pageResult] = await Booking.aggregate(pagePipeline);
    const orderedIds = (pageResult?.data || []).map((d) => d._id);
    const total = pageResult?.totalCount?.[0]?.count || 0;
    const hasMore = startIndex + orderedIds.length < total;

    if (orderedIds.length === 0) {
      return res.status(200).json({
        success: true,
        stats,
        bookings: [],
        pagination: { page: pageNum, limit: limitNum, total, hasMore },
      });
    }

    const pageDocs = await Booking.find({ _id: { $in: orderedIds } })
      .select(
        [
          "bookingCode",
          "lead",
          "customerName",
          "mobileNumber",
          "alternateMobileNumber",
          "occupation",
          "destination",
          "aadhaarNumber",
          "drivingLicenseNumber",
          "tripType",
          "fromDate",
          "toDate",
          "pickupTime",
          "dropTime",
          "totalDays",
          "residents",
          "payment",
          "vehicleId",
          "vehicleName",
          "vehicleNumber",
          "vehicleColor",
          "status",
          "handover",
          "vehicleReturn",
          "pickupDropRequired",
          "serviceType",
          "pickup",
          "drop",
          "assignedDriver",
          "createdBy",
          "pickupDropNotes",
          "vehicleHistory",
          "createdAt",
        ].join(" "),
      )
      .populate({
        path: "lead",
        select:
          "leadId priority source vehicleType bookingConfirmedAt leadOwner",
        populate: { path: "leadOwner", select: "name fullName" },
      })
      .populate({
        path: "vehicleId",
        select: "vehicleName vehicleNumber color",
      })
      .populate({ path: "createdBy", select: "name fullName" })
      .populate({
        path: "assignedDriver",
        select: "fullName name mobileNumber",
      })
      .populate({
        path: "vehicleHistory.changedBy",
        select: "fullName name",
      })
      .lean();

    const byId = new Map(pageDocs.map((doc) => [String(doc._id), doc]));
    const orderedDocs = orderedIds
      .map((id) => byId.get(String(id)))
      .filter(Boolean);

    const bookings = orderedDocs.map((booking) => {
      let status = "Booking Confirmed";
      const isOpenBooking = !OPEN_STATUSES_EXCLUDED.includes(booking.status);

      if (booking.status === "completed") status = "Completed";
      else if (booking.status === "cancelled") status = "Cancelled";
      else if (["active", "vehicle_handover"].includes(booking.status))
        status = "Active Rental";
      else if (booking.fromDate && isOpenBooking) {
        const pickupDate = getISTDateString(booking.fromDate);
        if (pickupDate < today) status = "Pending Handover";
        else if (pickupDate === today) status = "Today's Pickup";
        else if (pickupDate === tomorrow) status = "Tomorrow's Pickup";
      }

      return {
        _id: booking._id,
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        leadId: booking.lead?.leadId || "",
        customerName: booking.customerName,
        mobileNumber: booking.mobileNumber,
        alternateMobileNumber: booking.alternateMobileNumber,
        occupation: booking.occupation,
        destination: booking.destination,
        aadhaarNumber: booking.aadhaarNumber,
        drivingLicenseNumber: booking.drivingLicenseNumber,
        tripType: booking.tripType,
        pickupDate: booking.fromDate,
        dropDate: booking.toDate,
        fromDate: booking.fromDate,
        toDate: booking.toDate,
        pickupTime: booking.pickupTime,
        dropTime: booking.dropTime,
        tripDays: booking.totalDays,
        totalDays: booking.totalDays,
        residents: booking.residents,
        quotationAmount: booking.payment?.totalAmount || 0,
        bookingAmount: booking.payment?.bookingAmountPaid || 0,
        discountAmount: booking.payment?.discountAmount || 0,
        fastagBalance: booking.payment?.fastagAmount || 0,
        securityDeposit: booking.payment?.securityDeposit || 0,
        payment: booking.payment || null,
        vehicleId: booking.vehicleId?._id || null,
        vehicleName: booking.vehicleId?.vehicleName || booking.vehicleName,
        vehicleNumber:
          booking.vehicleId?.vehicleNumber || booking.vehicleNumber,
        vehicleColor: booking.vehicleId?.color || booking.vehicleColor,
        vehicleType: booking.lead?.vehicleType || "",
        priority: booking.lead?.priority || "medium",
        source: booking.lead?.source || "",
        leadOwner:
          booking.lead?.leadOwner?.fullName ||
          booking.lead?.leadOwner?.name ||
          booking.createdBy?.fullName ||
          booking.createdBy?.name ||
          "",
        bookingConfirmedAt:
          booking.lead?.bookingConfirmedAt || booking.createdAt,
        status,
        bookingStatus: booking.status,
        handoverCompleted: booking.status !== "confirmed",
        handover: booking.handover,
        vehicleReturn: booking.vehicleReturn,
        pickupDropRequired: booking.pickupDropRequired,
        serviceType: booking.serviceType,
        pickup: booking.pickup,
        drop: booking.drop,
        assignedDriver: booking.assignedDriver
          ? {
              _id: booking.assignedDriver._id,
              fullName:
                booking.assignedDriver.fullName ||
                booking.assignedDriver.name ||
                "",
              mobileNumber: booking.assignedDriver.mobileNumber || "",
            }
          : null,
        pickupDropNotes: booking.pickupDropNotes,
        // Vehicle change history — flattened for the client: only the
        // fields the "Vehicle History" popup on the bookings list needs.
        vehicleHistory: (booking.vehicleHistory || []).map((h) => ({
          fromVehicle: h.fromVehicle,
          toVehicle: h.toVehicle,
          changedByName: h.changedBy?.fullName || h.changedBy?.name || "",
          changedAt: h.changedAt,
          note: h.note,
        })),
        createdBy: booking.createdBy
          ? {
              _id: booking.createdBy._id,
              name: booking.createdBy.fullName || booking.createdBy.name || "",
            }
          : null,
        createdAt: booking.createdAt,
      };
    });

    return res.status(200).json({
      success: true,
      stats,
      bookings,
      pagination: { page: pageNum, limit: limitNum, total, hasMore },
    });
  } catch (error) {
    console.error("===== BOOKING DASHBOARD ERROR =====");
    console.error(error);
    console.error(error.stack);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch bookings.",
      error: error.message,
    });
  }
};

export const invalidateBookingStatsCache = () => statsCache.clear();
//new booking api ending [get]

export const createLeadBooking = async (req, res, next) => {
  try {
    const companyId = req.user.company || req.user.createdBy || req.user._id;
    const lead = await Lead.findOne({ _id: req.params.id, company: companyId, isDeleted: false });

    if (!lead || lead.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const {
      customerName,
      mobileNumber,
      alternateMobileNumber,
      occupation,
      destination,
      aadhaarNumber,
      drivingLicenseNumber,
      tripType,
      vehicleId,
      vehicleName,
      bookingAmount,
      discountAmount,
      securityDeposit,
      fastagBalance,
      totalDays,
      fromDate,
      toDate,
      pickupTime,
      dropTime,
      rentalType,
      residents,

      // NEW: how the advance was collected
      paymentMethod = "cash", // "cash" | "phonepe" | "razorpay" | "mixed"
      paymentBreakdown = {}, // { cash, phonePe, razorpay } — required when paymentMethod === "mixed"

      // PICKUP / DROP SERVICE FIELDS FROM MOBILE APP
      pickupDropRequired,
      serviceType,
      pickup,
      drop,
      pickupDropNotes,
    } = req.body;

    if (!vehicleId) {
      return res.status(400).json({
        success: false,
        message: "Vehicle is required.",
      });
    }

    // NEW: validate payment method / mixed breakdown up front
    const VALID_PAYMENT_METHODS = ["cash", "phonepe", "razorpay", "mixed"];
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method.",
      });
    }

    const advancePaid = Number(bookingAmount) || 0;
    const breakdown = {
      cash: Number(paymentBreakdown.cash) || 0,
      phonePe: Number(paymentBreakdown.phonePe) || 0,
      razorpay: Number(paymentBreakdown.razorpay) || 0,
    };

    if (paymentMethod === "mixed") {
      const breakdownSum =
        breakdown.cash + breakdown.phonePe + breakdown.razorpay;
      if (advancePaid > 0 && breakdownSum !== advancePaid) {
        return res.status(400).json({
          success: false,
          message: `Payment breakdown (₹${breakdownSum}) does not match the advance amount (₹${advancePaid}).`,
        });
      }
    } else if (advancePaid > 0) {
      // Single-method payments: mirror the full advance into that method's
      // breakdown bucket so paymentBreakdown is always a complete record,
      // even when the user didn't fill it in manually.
      breakdown.cash = paymentMethod === "cash" ? advancePaid : 0;
      breakdown.phonePe = paymentMethod === "phonepe" ? advancePaid : 0;
      breakdown.razorpay = paymentMethod === "razorpay" ? advancePaid : 0;
    }

    // Keep latest customer info in Lead
    if (customerName?.trim()) {
      lead.customerName = customerName.trim();
    }
    if (mobileNumber?.trim()) {
      lead.mobileNumber = mobileNumber.trim();
    }
    // Use current form inputs or fallback to historic lead record
    const finalFromDate = fromDate ? new Date(fromDate) : lead.fromDate;
    const finalToDate = toDate ? new Date(toDate) : lead.toDate;

    // Prevent duplicate booking for same vehicle and same trip window
    const existingBooking = await Booking.findOne({
      lead: lead._id,
      vehicleId,
      fromDate: finalFromDate,
      toDate: finalToDate,
      isDeleted: false,
      status: { $nin: ["cancelled", "completed"] },
    });

    if (existingBooking) {
      return res.status(400).json({
        success: false,
        message:
          "A booking already exists for this vehicle during the selected trip.",
      });
    }

    // NEW: fetch the vehicle so we can compute a real vehicle-rent figure
    // for the payment subdocument (same as the fresh-booking flow).
    const vehicle = await Vehicle.findOne({ _id: vehicleId, company: companyId, isDeleted: false });
    if (!vehicle || vehicle.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found.",
      });
    }

    const finalTotalDays = Number(totalDays) || 1;
    await lead.save();

    // Normalize pickup/drop service inputs — only persist the leg(s) that
    // actually apply to the chosen serviceType, so a "pickup" only booking
    // doesn't carry stray drop details (and vice versa).
    const isPickupDropRequired = Boolean(pickupDropRequired);
    const finalServiceType = ["pickup", "drop", "pickup_drop"].includes(
      serviceType,
    )
      ? serviceType
      : "pickup_drop";

    const includesPickup =
      isPickupDropRequired &&
      (finalServiceType === "pickup" || finalServiceType === "pickup_drop");

    const includesDrop =
      isPickupDropRequired &&
      (finalServiceType === "drop" || finalServiceType === "pickup_drop");

    const pickupDetails = includesPickup
      ? {
          location: pickup?.location?.trim() || "",
          landmark: pickup?.landmark?.trim() || "",
          mapLink: pickup?.mapLink?.trim() || "",
          charge: Number(pickup?.charge) || 0,
        }
      : { location: "", landmark: "", mapLink: "", charge: 0 };

    const dropDetails = includesDrop
      ? {
          location: drop?.location?.trim() || "",
          landmark: drop?.landmark?.trim() || "",
          mapLink: drop?.mapLink?.trim() || "",
          charge: Number(drop?.charge) || 0,
        }
      : { location: "", landmark: "", mapLink: "", charge: 0 };

    // ========================= PRICING =========================
    const vehicleRent = Number(vehicle.pricePerDay || 0) * finalTotalDays;
    const pickupCharge = pickupDetails.charge;
    const dropCharge = dropDetails.charge;
    const fastagAmount = Number(fastagBalance) || 0;

    // Prefer a freshly computed total from the actual vehicle rate; fall
    // back to the lead's stored quotation only if the vehicle has no rate
    // configured (keeps old behaviour as a safety net).
    const computedTotal =
      vehicleRent + pickupCharge + dropCharge + fastagAmount;
    const finalQuotationAmount =
      computedTotal > 0 ? computedTotal : lead.quotationAmount || 0;

    const finalDiscountAmount = Number(discountAmount) || 0;
    const finalSecurityDeposit = Number(securityDeposit) || 0;

    const booking = await Booking.create({
      lead: lead._id,
      company: companyId,
      createdBy: req.user._id,

      customerName: customerName?.trim() || lead.customerName,
      mobileNumber: mobileNumber?.trim() || lead.mobileNumber,
      alternateMobileNumber: alternateMobileNumber?.trim() || "",
      occupation: occupation?.trim() || "",

      aadhaarNumber: aadhaarNumber?.trim() || "",
      drivingLicenseNumber: drivingLicenseNumber?.trim().toUpperCase() || "",

      destination: destination?.trim() || "",
      tripType: tripType || "local",
      rentalType: rentalType === "flexible" ? "flexible" : "standard",

      fromDate: finalFromDate,
      toDate: finalToDate,
      pickupTime: pickupTime || "09:00 AM",
      dropTime: dropTime || "06:00 PM",

      residents: Number(residents) || lead.residents || 1,
      vehicleId,
      vehicleName: vehicleName || vehicle.vehicleName,
      vehicleNumber: vehicle.vehicleNumber,
      vehicleColor: vehicle.color,

      // Flat fields kept for existing list/card screens
      quotationAmount: finalQuotationAmount,
      bookingAmount: advancePaid,
      discountAmount: finalDiscountAmount,
      securityDeposit: finalSecurityDeposit,
      fastagBalance: fastagAmount,
      totalDays: finalTotalDays,

      // NEW: structured payment/bill record — mirrors Handover.payment so
      // the "View Booking" bill screen renders identically pre/post handover.
      payment: {
        vehicleRent,
        pickupCharge,
        dropCharge,
        fastagAmount,
        totalAmount: finalQuotationAmount,
        discountAmount: finalDiscountAmount,
        securityDeposit: finalSecurityDeposit,
        bookingAmountPaid: advancePaid,
        paymentMethod,
        paymentBreakdown: breakdown,
        // balanceAmount / totalCollected / paymentStatus are computed
        // by the pre("save") hook on the Booking model.
      },

      // PERSIST PICKUP / DROP SERVICE
      pickupDropRequired: isPickupDropRequired,
      serviceType: finalServiceType,
      pickup: pickupDetails,
      drop: dropDetails,
      pickupDropNotes: pickupDropNotes?.trim() || "",

      status: "confirmed",
    });

    // ==========================
    // CREATE PAYMENT HISTORY
    // ==========================
    // Record booking advance payment separately.
    // Payment history failure must NOT break booking creation.

    if (Number(advancePaid) > 0) {
      try {
        await PaymentHistory.create({
          company: companyId,

          bookingId: booking._id,

          // Booking's resolved values: customerName/mobileNumber are optional
          // in this request and fall back to the lead.
          customer: {
            fullName: booking.customerName,
            mobileNumber: booking.mobileNumber,
          },

          vehicle: {
            vehicleId: vehicle._id,
            vehicleName: vehicle.vehicleName,
            vehicleNumber: vehicle.vehicleNumber,
          },

          amount: advancePaid,

          paymentMethod: paymentMethod,

          paymentBreakdown: {
            cash: Number(breakdown.cash) || 0,
            phonePe: Number(breakdown.phonePe) || 0,
            razorpay: Number(breakdown.razorpay) || 0,
          },

          type: "booking",

          note: "Booking advance payment",

          createdBy: req.user._id,
        });
      } catch (paymentHistoryError) {
        // Do NOT break booking creation if payment history fails.
        console.error(
          "Payment History Creation Error:",
          paymentHistoryError?.message || paymentHistoryError,
        );
      }
    }

    await booking.populate([
      {
        path: "vehicleId",
        select:
          "vehicleName vehicleNumber color manufacturer model pricePerDay",
      },
      {
        path: "lead",
        select:
          "leadId customerName mobileNumber vehicleType fromDate toDate totalDays",
      },
    ]);

    try {
      await sendBookingCreatedMessage(booking.mobileNumber);

      console.log("Booking WhatsApp message sent successfully");
    } catch (whatsappError) {
      console.error(
        "Booking WhatsApp Error:",
        whatsappError?.response?.data ||
          whatsappError?.message ||
          whatsappError,
      );

      // Do not fail booking if WhatsApp fails
    }

    return res.status(201).json({
      success: true,
      message: "Booking created successfully.",
      data: booking,
    });
  } catch (err) {
    console.error("Create Booking Error:", err);
    next(err);
  }
};

export const getLeadBookingDetails = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate("leadOwner", "name email")
      .populate("createdBy", "name");

    if (!lead || lead.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const latestBooking = await Booking.findOne({
      lead: lead._id,
      isDeleted: false,
    })
      .populate(
        "vehicleId",
        "vehicleName vehicleNumber color manufacturer model pricePerDay",
      )
      .sort({ createdAt: -1 });

    const totalBookings = await Booking.countDocuments({
      lead: lead._id,
      isDeleted: false,
    });

    const response = {
      ...lead.toObject(),

      booking: latestBooking
        ? {
            _id: latestBooking._id,
            bookingCode: latestBooking.bookingCode,

            customerName: latestBooking.customerName,
            mobileNumber: latestBooking.mobileNumber,
            alternateMobileNumber: latestBooking.alternateMobileNumber || "",

            occupation: latestBooking.occupation || "",

            destination: latestBooking.destination || "",

            aadhaarNumber: latestBooking.aadhaarNumber || "",

            drivingLicenseNumber: latestBooking.drivingLicenseNumber || "",

            tripType: latestBooking.tripType,

            bookingAmount: latestBooking.bookingAmount,

            discountAmount: latestBooking.discountAmount,

            quotationAmount: latestBooking.quotationAmount,

            vehicleId: latestBooking.vehicleId,

            vehicleName:
              latestBooking.vehicleId?.vehicleName || latestBooking.vehicleName,

            vehicleNumber:
              latestBooking.vehicleId?.vehicleNumber ||
              latestBooking.vehicleNumber,

            vehicleColor:
              latestBooking.vehicleId?.color || latestBooking.vehicleColor,

            fromDate: latestBooking.fromDate,

            toDate: latestBooking.toDate,
            pickupTime: latestBooking.pickupTime || "08:00 AM",
            dropTime: latestBooking.dropTime || "08:00 PM",

            totalDays: latestBooking.totalDays,

            residents: latestBooking.residents,

            status: latestBooking.status,

            createdAt: latestBooking.createdAt,
          }
        : {
            customerName: lead.customerName,
            mobileNumber: lead.mobileNumber,
            alternateMobileNumber: lead.booking?.alternateMobileNumber || "",

            occupation: lead.booking?.occupation || "",

            destination: lead.booking?.destination || "",

            aadhaarNumber: lead.booking?.aadhaarNumber || "",

            drivingLicenseNumber: lead.booking?.drivingLicenseNumber || "",

            tripType: lead.booking?.tripType || "local",

            bookingAmount: lead.booking?.bookingAmount || 0,

            discountAmount: lead.booking?.discountAmount || 0,

            quotationAmount: lead.quotationAmount || 0,

            vehicleId: lead.booking?.vehicleId || null,

            vehicleName: lead.booking?.vehicleName || lead.vehicleName,

            vehicleNumber: "",

            vehicleColor: "",

            fromDate: lead.fromDate,

            toDate: lead.toDate,

            totalDays: lead.totalDays,

            residents: lead.residents,

            status: "confirmed",

            createdAt: lead.createdAt,
          },

      totalBookings,
      hasPreviousBooking: totalBookings > 0,
    };

    return res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error("Get Lead Booking Details Error:", error);
    next(error);
  }
};

export const getLeadBookings = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id);

    if (!lead || lead.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const bookings = await Booking.find({
      lead: lead._id,
      isDeleted: false,
    })
      .populate(
        "vehicleId",
        "vehicleName vehicleNumber color manufacturer model",
      )
      .populate("createdBy", "name fullName")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      total: bookings.length,
      data: bookings,
    });
  } catch (error) {
    next(error);
  }
};

//
const parseTime = (time = "08:00 AM") => {
  let [clock, period] = time.split(" ");
  let [hours, minutes] = clock.split(":").map(Number);

  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;

  return { hours, minutes };
};

const combineDateAndTime = (date, time) => {
  const d = new Date(date);
  const { hours, minutes } = parseTime(time);

  d.setHours(hours, minutes, 0, 0);

  return d;
};

// fromDate first, then toDate as fallback.
const resolveBookingMonth = (fromDate, toDate) => {
  return toBookingMonth(fromDate) || toBookingMonth(toDate) || null;
};

export const createBookings = async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    const companyId = req.user.company || req.user.createdBy || req.user._id;
    const {
      customerName,
      mobileNumber,
      alternateMobileNumber,
      occupation,
      destination,
      aadhaarNumber,
      drivingLicenseNumber,

      // We accept this for compatibility with the frontend,
      // but backend calculates the real value.
      totalDays,

      tripType,
      fromDate,
      toDate,
      pickupTime,
      dropTime,
      residents,
      vehicleId,
      vehicleType,

      bookingAmount,
      discountAmount,
      securityDeposit,
      fastagBalance,

      paymentMethod = "phonepe",
      paymentBreakdown = {},
      upiLast4 = "",

      pickupDropRequired = false,
      serviceType = "pickup_drop",
      pickup = {},
      drop = {},
      pickupDropNotes = "",
    } = req.body;

    // ============================================================
    // BASIC VALIDATION
    // ============================================================

    if (!customerName?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Customer name is required.",
      });
    }

    if (!mobileNumber?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required.",
      });
    }

    if (!vehicleId) {
      return res.status(400).json({
        success: false,
        message: "Vehicle is required.",
      });
    }

    if (!fromDate || !toDate) {
      return res.status(400).json({
        success: false,
        message: "Trip dates are required.",
      });
    }

    // ============================================================
    // PICKUP / DROP VALIDATION
    // ============================================================

    if (pickupDropRequired) {
      if (
        (serviceType === "pickup" || serviceType === "pickup_drop") &&
        !pickup.location?.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: "Pickup location is required.",
        });
      }

      if (
        (serviceType === "drop" || serviceType === "pickup_drop") &&
        !drop.location?.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: "Drop location is required.",
        });
      }
    }

    // ============================================================
    // DATE PARSER
    //
    // Only accept:
    //
    // YYYY-MM-DD
    //
    // Example:
    // 2026-08-25
    //
    // Store at UTC midnight to prevent timezone shifting.
    // ============================================================

    const parseBookingDate = (value) => {
      if (typeof value !== "string") {
        return null;
      }

      const dateString = value.trim();

      const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);

      if (!match) {
        return null;
      }

      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);

      const date = new Date(Date.UTC(year, month - 1, day));

      // Validate dates like:
      // 2026-02-31
      // 2026-04-31
      // etc.
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        return null;
      }

      return date;
    };

    const finalFromDate = parseBookingDate(fromDate);
    const finalToDate = parseBookingDate(toDate);

    // ============================================================
    // DATE VALIDATION
    // ============================================================

    if (!finalFromDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid start date. Date must be in YYYY-MM-DD format.",
      });
    }

    if (!finalToDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid end date. Date must be in YYYY-MM-DD format.",
      });
    }

    // Start must be before end.
    if (finalFromDate > finalToDate) {
      return res.status(400).json({
        success: false,
        message: "End date cannot be before start date.",
      });
    }

    // ============================================================
    // FUTURE DATE VALIDATION
    //
    // No maximum duration.
    //
    // 25 Aug -> 09 Sep       allowed
    // 25 Aug -> 25 Dec       allowed
    // 25 Aug -> 25 Aug 2027  allowed
    // ============================================================

    const now = new Date();

    const todayUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    if (finalFromDate < todayUTC) {
      return res.status(400).json({
        success: false,
        message: "Booking start date cannot be in the past.",
      });
    }

    // ============================================================
    // CALCULATE TOTAL DAYS
    //
    // Backend is the source of truth.
    // Do not trust frontend totalDays.
    // ============================================================

    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const calculatedTotalDays = Math.round(
      (finalToDate.getTime() - finalFromDate.getTime()) / MS_PER_DAY,
    );

    // Same-day booking is allowed and counts as 1 rental day.
    const finalTotalDays = Math.max(1, calculatedTotalDays);

    // ============================================================
    // BOOKING MONTH
    //
    // Based on trip start date, not creation date.
    // Example: created 30 Sep for 02 Oct - 05 Oct => "2026-10"
    // Falls back to toDate if fromDate is somehow unavailable.
    // ============================================================

    const bookingMonth = resolveBookingMonth(finalFromDate, finalToDate);

    // ============================================================
    // PAYMENT METHOD VALIDATION
    // ============================================================

    const VALID_PAYMENT_METHODS = ["cash", "phonepe", "razorpay", "mixed"];

    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method.",
      });
    }

    const advancePaid = Number(bookingAmount) || 0;

    const normalizedUpiLast4 = String(upiLast4 || "").trim();

    if (paymentMethod === "phonepe" && advancePaid > 0) {
      if (!/^\d{4}$/.test(normalizedUpiLast4)) {
        return res.status(400).json({
          success: false,
          message: "PhonePe UPI last 4 digits are required.",
        });
      }
    }

    if (advancePaid < 0) {
      return res.status(400).json({
        success: false,
        message: "Booking amount cannot be negative.",
      });
    }

    const breakdown = {
      cash: Number(paymentBreakdown.cash) || 0,
      phonePe: Number(paymentBreakdown.phonePe) || 0,
      razorpay: Number(paymentBreakdown.razorpay) || 0,
    };

    // ============================================================
    // MIXED PAYMENT VALIDATION
    // ============================================================

    if (paymentMethod === "mixed") {
      const breakdownSum =
        breakdown.cash + breakdown.phonePe + breakdown.razorpay;

      if (Math.round(breakdownSum * 100) !== Math.round(advancePaid * 100)) {
        return res.status(400).json({
          success: false,
          message: `Payment breakdown (₹${breakdownSum}) does not match the advance amount (₹${advancePaid}).`,
        });
      }
    } else if (advancePaid > 0) {
      breakdown.cash = paymentMethod === "cash" ? advancePaid : 0;

      breakdown.phonePe = paymentMethod === "phonepe" ? advancePaid : 0;

      breakdown.razorpay = paymentMethod === "razorpay" ? advancePaid : 0;
    }

    // ============================================================
    // VEHICLE
    // ============================================================

    const vehicle = await Vehicle.findOne({
      _id: vehicleId,
      isDeleted: false,
    });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found.",
      });
    }

    // ============================================================
    // PRICING
    // ============================================================

    const vehicleRent = Number(vehicle.pricePerDay || 0) * finalTotalDays;

    const pickupCharge =
      pickupDropRequired &&
      (serviceType === "pickup" || serviceType === "pickup_drop")
        ? Number(pickup.charge || 0)
        : 0;

    const dropCharge =
      pickupDropRequired &&
      (serviceType === "drop" || serviceType === "pickup_drop")
        ? Number(drop.charge || 0)
        : 0;

    const fastagAmount = Number(fastagBalance || 0);

    const quotationAmount =
      vehicleRent + pickupCharge + dropCharge + fastagAmount;

    const finalDiscountAmount = Number(discountAmount) || 0;

    const finalSecurityDeposit = Number(securityDeposit) || 0;

    // ============================================================
    // START TRANSACTION
    // ============================================================

    await session.startTransaction();

    // ============================================================
    // CHECK BOOKING CONFLICT
    // ============================================================

    const parseTimeToMinutes = (timeString) => {
      if (!timeString || typeof timeString !== "string") {
        return 0;
      }

      const match = timeString.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

      if (!match) {
        return 0;
      }

      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const period = match[3].toUpperCase();

      if (period === "AM" && hour === 12) {
        hour = 0;
      }

      if (period === "PM" && hour !== 12) {
        hour += 12;
      }

      return hour * 60 + minute;
    };

    const newPickupMinutes = parseTimeToMinutes(pickupTime || "08:00 AM");
    const newDropMinutes = parseTimeToMinutes(dropTime || "08:00 AM");

    const newStart = new Date(finalFromDate);
    newStart.setUTCHours(0, newPickupMinutes, 0, 0);

    const newEnd = new Date(finalToDate);
    newEnd.setUTCHours(0, newDropMinutes, 0, 0);

    // Exact boundary is allowed:
    // Existing ends exactly when new booking starts = NO conflict.
    const existingBookings = await Booking.find({
      vehicleId: vehicle._id,
      isDeleted: false,
      status: {
        $nin: ["cancelled", "completed"],
      },
    })
      .select(
        "_id bookingCode fromDate toDate pickupTime dropTime status customerName",
      )
      .session(session)
      .lean();

    const existingBooking = existingBookings.find((booking) => {
      const existingStart = new Date(booking.fromDate);
      const existingEnd = new Date(booking.toDate);

      const existingPickupMinutes = parseTimeToMinutes(
        booking.pickupTime || "08:00 AM",
      );

      const existingDropMinutes = parseTimeToMinutes(
        booking.dropTime || "08:00 AM",
      );

      existingStart.setUTCHours(0, existingPickupMinutes, 0, 0);
      existingEnd.setUTCHours(0, existingDropMinutes, 0, 0);

      // Overlap only when:
      // existingStart < newEnd
      // AND existingEnd > newStart
      return existingStart < newEnd && existingEnd > newStart;
    });

    if (existingBooking) {
      await session.abortTransaction();

      return res.status(409).json({
        success: false,
        message: "This vehicle is already booked during the selected dates.",
        conflict: {
          bookingId: existingBooking._id,
          bookingCode: existingBooking.bookingCode || null,
          customerName: existingBooking.customerName || "",
          fromDate: existingBooking.fromDate,
          toDate: existingBooking.toDate,
          pickupTime: existingBooking.pickupTime,
          dropTime: existingBooking.dropTime,
          status: existingBooking.status,
        },
      });
    }

    // Same rule as booking edits: open maintenance blocks the vehicle.
    const existingMaintenance = await Maintenance.findOne({
      vehicle: vehicle._id,
      isDeleted: { $ne: true },
      status: { $nin: ["Cancelled", "Completed"] },
      startDate: { $lt: newEnd },
      endDate: { $gt: newStart },
    })
      .select("_id startDate endDate status")
      .session(session)
      .lean();

    if (existingMaintenance) {
      await session.abortTransaction();

      return res.status(409).json({
        success: false,
        message: "This vehicle has maintenance during the selected dates.",
        conflict: {
          maintenanceId: existingMaintenance._id,
          startDate: existingMaintenance.startDate,
          endDate: existingMaintenance.endDate,
          status: existingMaintenance.status,
        },
      });
    }

    // ============================================================
    // COMPANY
    // ============================================================

    // ============================================================
    // FIND EXISTING LEAD
    // ============================================================

    let lead = await Lead.findOne({
      mobileNumber: mobileNumber.trim(),

      company: companyId,

      isDeleted: false,
    }).session(session);

    // ============================================================
    // CREATE LEAD IF NOT EXISTS
    // ============================================================

    if (!lead) {
      const [newLead] = await Lead.create(
        [
          {
            customerName: customerName.trim(),

            mobileNumber: mobileNumber.trim(),

            vehicleType: vehicleType === "bike" ? "bike" : "car",

            vehicleName: vehicle.vehicleName,

            fromDate: finalFromDate,

            toDate: finalToDate,

            totalDays: finalTotalDays,

            residents: Number(residents) || 1,

            source: "other",

            status: "Booking confirmed",

            quotationAmount,

            isBookingCreated: true,

            company: companyId,

            createdBy: req.user._id,

            booking: {
              alternateMobileNumber: alternateMobileNumber?.trim() || "",

              occupation: occupation?.trim() || "",

              destination: destination?.trim() || "",

              aadhaarNumber: aadhaarNumber?.trim() || "",

              drivingLicenseNumber:
                drivingLicenseNumber?.trim().toUpperCase() || "",

              tripType: tripType || "local",

              vehicleId: vehicle._id,

              vehicleName: vehicle.vehicleName,

              bookingAmount: advancePaid,

              discountAmount: finalDiscountAmount,

              createdAt: new Date(),
            },
          },
        ],
        {
          session,
        },
      );

      lead = newLead;
    }

    // ============================================================
    // CREATE BOOKING
    // ============================================================

    const [booking] = await Booking.create(
      [
        {
          lead: lead._id,

          company: companyId,

          createdBy: req.user._id,

          customerName: customerName.trim(),

          mobileNumber: mobileNumber.trim(),

          alternateMobileNumber: alternateMobileNumber?.trim() || "",

          occupation: occupation?.trim() || "",

          destination: destination?.trim() || "",

          aadhaarNumber: aadhaarNumber?.trim() || "",

          drivingLicenseNumber:
            drivingLicenseNumber?.trim().toUpperCase() || "",

          tripType: tripType || "local",

          // IMPORTANT:
          // Store canonical UTC date.
          fromDate: finalFromDate,

          toDate: finalToDate,

          pickupTime: pickupTime || "08:00 AM",

          dropTime: dropTime || "08:00 AM",

          // Backend calculated value.
          totalDays: finalTotalDays,

          residents: Number(residents) || 1,

          vehicleId: vehicle._id,

          vehicleName: vehicle.vehicleName,

          vehicleNumber: vehicle.vehicleNumber,

          vehicleColor: vehicle.color,

          // Flat fields.
          quotationAmount,

          bookingAmount: advancePaid,

          discountAmount: finalDiscountAmount,

          securityDeposit: finalSecurityDeposit,

          fastagBalance: fastagAmount,

          // Structured payment.
          payment: {
            vehicleRent,

            pickupCharge,

            dropCharge,

            fastagAmount,

            totalAmount: quotationAmount,

            discountAmount: finalDiscountAmount,

            securityDeposit: finalSecurityDeposit,

            bookingAmountPaid: advancePaid,

            paymentMethod,

            paymentBreakdown: breakdown,
          },

          pickupDropRequired,

          serviceType,

          pickup: {
            location: pickup.location?.trim() || "",

            landmark: pickup.landmark?.trim() || "",

            mapLink: pickup.mapLink?.trim() || "",

            charge: pickupCharge,
          },

          drop: {
            location: drop.location?.trim() || "",

            landmark: drop.landmark?.trim() || "",

            mapLink: drop.mapLink?.trim() || "",

            charge: dropCharge,
          },

          pickupDropNotes: pickupDropNotes?.trim() || "",

          status: "confirmed",
        },
      ],
      {
        session,
      },
    );

    // ============================================================
    // PAYMENT HISTORY + VEHICLE PAYMENT ID
    // ============================================================

    if (advancePaid > 0) {
      const [paymentHistory] = await PaymentHistory.create(
        [
          {
            company: companyId,

            bookingId: booking._id,

            customer: {
              fullName: customerName.trim(),

              mobileNumber: mobileNumber.trim(),
            },

            vehicle: {
              vehicleId: vehicle._id,

              vehicleName: vehicle.vehicleName,

              vehicleNumber: vehicle.vehicleNumber,
            },

            booking: {
              fromDate: finalFromDate,

              toDate: finalToDate,

              bookingAmount: advancePaid,
            },

            // Trip month (from fromDate), e.g. "2026-10".
            bookingMonth,

            amount: advancePaid,

            paymentMethod,

            upiLast4:
              paymentMethod === "phonepe" && normalizedUpiLast4
                ? [normalizedUpiLast4]
                : [],

            paymentBreakdown: {
              cash: Number(breakdown.cash) || 0,

              phonePe: Number(breakdown.phonePe) || 0,

              razorpay: Number(breakdown.razorpay) || 0,
            },

            type: "booking",

            note: "Booking advance payment",

            createdBy: req.user._id,
          },
        ],
        { session },
      );

      // Store only the PaymentHistory id on the vehicle.
      await Vehicle.updateOne(
        { _id: vehicle._id },
        { $push: { payments: paymentHistory._id } },
        { session },
      );
    }

    // ============================================================
    // UPDATE LEAD
    // ============================================================

    lead.bookingId = booking._id;

    lead.bookingConfirmedAt = new Date();

    lead.isBookingCreated = true;

    await lead.save({
      session,
    });

    // ============================================================
    // COMMIT TRANSACTION
    // ============================================================

    await session.commitTransaction();

    // ============================================================
    // SEND BOOKING WHATSAPP
    // ============================================================

    try {
      const whatsappResult = await sendBookingCreatedMessage(
        booking.mobileNumber,
      );

      console.log("Booking WhatsApp Result:", whatsappResult);
    } catch (whatsappError) {
      console.error(
        "Booking WhatsApp Error:",
        whatsappError?.response?.data ||
          whatsappError?.message ||
          whatsappError,
      );
    }

    // ============================================================
    // POPULATE VEHICLE
    // ============================================================

    await booking.populate({
      path: "vehicleId",

      select: "vehicleName vehicleNumber color manufacturer model pricePerDay",
    });

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(201).json({
      success: true,

      message: "Booking created successfully.",

      booking,

      leadId: lead._id,
    });
  } catch (error) {
    // ============================================================
    // ROLLBACK
    // ============================================================

    if (session.inTransaction()) {
      await session.abortTransaction();
    }

    // ============================================================
    // TRANSACTION CONFLICT
    // ============================================================

    if (
      error?.code === 112 ||
      error?.errorLabels?.includes("TransientTransactionError")
    ) {
      return res.status(409).json({
        success: false,

        message:
          "This vehicle was just booked by someone else for overlapping dates. Please refresh and try again.",
      });
    }

    console.error("Create booking error:", error);

    next(error);
  } finally {
    await session.endSession();
  }
};

export const getBookingDetails = async (req, res, next) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findOne({
      _id: id,
      isDeleted: false,
    })
      .populate({
        path: "vehicleId",
        select:
          "vehicleName vehicleNumber manufacturer model variant color fuelType transmission seatingCapacity pricePerDay images",
      })
      .populate({
        path: "createdBy",
        select: "fullName email mobileNumber role profileImage",
      })
      .populate({
        path: "handover",
      })
      .populate({
        path: "vehicleReturn",
      })
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
    }

    return res.status(200).json({
      success: true,
      booking,
    });
  } catch (error) {
    next(error);
  }
};

const calculateTotalDaysFromDates = (fromDate, toDate) => {
  const start = new Date(fromDate);
  const end = new Date(toDate);

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const diffMs = end.getTime() - start.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  return diffDays < 1 ? 1 : diffDays;
};

// Calendar days and wall-clock times use the same UTC day representation as
// booking creation. Accept stored AM/PM values and the modal's 24-hour inputs.
const bookingDay = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.toISOString().slice(0, 10));
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};
const bookingMinutes = (value) => {
  const match = typeof value === "string" && value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return hour * 60 + minute;
};

export const updateBooking = async (req, res, next) => {
  try {
    const fail = (message, status = 400) => res.status(status).json({ success: false, message });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return fail("Invalid booking id.");
    // Unified fleet: the clicked Fleet Dashboard booking, by _id, whichever
    // company (or legacy employee id) it was stamped with.
    const booking = await Booking.findOne({ _id: id, isDeleted: false });
    if (!booking) return fail("Booking not found.", 404);
    // Hydration defaults are useful for reads, but must not materialize a
    // missing legacy payment field/split during an unrelated booking edit.
    Booking.schema.eachPath(path => {
      if (path.startsWith("payment.") && booking.$isDefault(path)) booking.$ignore(path);
    });
    const originalFare = Object.fromEntries(["totalAmount", "vehicleRent", "pickupCharge", "dropCharge", "fastagAmount"].map(key => [key, Number(booking.payment?.[key]) || 0]));
    booking.$locals.bookingPaymentSnapshot = {
      paid: Number(booking.payment?.bookingAmountPaid) || 0,
      security: Number(booking.payment?.securityDeposit) || 0,
      collected: Number(booking.payment?.totalCollected) || 0,
    };
    if (!["confirmed", "handover_pending"].includes(booking.status) || booking.handover) {
      return fail("Only bookings awaiting handover can be edited.", 409);
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid booking update payload.");
    const has = key => Object.hasOwn(body, key);
    const vehicleId = has("vehicleId") ? body.vehicleId : booking.vehicleId;
    if (!mongoose.isValidObjectId(vehicleId)) return fail("Invalid vehicle id.");
    const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false });
    if (!vehicle) {
      if (String(vehicleId) === String(booking.vehicleId)) {
        return res.status(409).json({ success: false, code: "BOOKING_VEHICLE_UNAVAILABLE", message: "The saved vehicle is no longer in the fleet. Select another vehicle and save again. No changes were saved." });
      }
      return fail("Vehicle not found.", 404);
    }
    const fromDate = bookingDay(has("fromDate") ? body.fromDate : booking.fromDate);
    const toDate = bookingDay(has("toDate") ? body.toDate : booking.toDate);
    const pickupTime = has("pickupTime") ? body.pickupTime : booking.pickupTime;
    const dropTime = has("dropTime") ? body.dropTime : booking.dropTime;
    const pickupMinutes = bookingMinutes(pickupTime), dropMinutes = bookingMinutes(dropTime);
    if (!fromDate || !toDate) return fail("Invalid pickup or drop date. Use YYYY-MM-DD.");
    if (pickupMinutes === null || dropMinutes === null) return fail("Invalid pickup or drop time.");
    const start = fromDate.getTime() + pickupMinutes * 60000;
    const end = toDate.getTime() + dropMinutes * 60000;
    if (end <= start) return fail("Drop date and time must be after pickup date and time.");
    const changedVehicle = String(booking.vehicleId) !== String(vehicle._id);
    const changedRange = changedVehicle || start !== bookingDay(booking.fromDate)?.getTime() + bookingMinutes(booking.pickupTime) * 60000 || end !== bookingDay(booking.toDate)?.getTime() + bookingMinutes(booking.dropTime) * 60000;
    if (changedRange) {
      const candidates = await Booking.find({ _id: { $ne: booking._id }, vehicleId: vehicle._id, isDeleted: false, status: { $nin: ["cancelled", "completed"] } })
        .select("fromDate toDate pickupTime dropTime").lean();
      if (candidates.some(item => {
        const lo = bookingDay(item.fromDate)?.getTime() + bookingMinutes(item.pickupTime) * 60000;
        const hi = bookingDay(item.toDate)?.getTime() + bookingMinutes(item.dropTime) * 60000;
        return lo < end && hi > start;
      })) return fail("This vehicle is already booked during the selected dates and times.", 409);
      const maintenance = await Maintenance.exists({ vehicle: vehicle._id, isDeleted: false, status: { $nin: ["Cancelled", "Completed"] }, startDate: { $lt: new Date(end) }, endDate: { $gt: new Date(start) } });
      if (maintenance) return fail("This vehicle has maintenance during the selected dates and times.", 409);
    }

    // Apply only explicitly supported fields; omission preserves saved values.
    const textFields = ["customerName", "mobileNumber", "alternateMobileNumber", "occupation", "destination", "aadhaarNumber", "drivingLicenseNumber", "pickupDropNotes"];
    for (const key of textFields) {
      if (!has(key)) continue;
      if (typeof body[key] !== "string") return fail(`Invalid ${key}.`);
      booking.set(key, body[key].trim());
    }
    if (has("tripType")) {
      if (!Booking.schema.path("tripType").enumValues.includes(body.tripType)) return fail("Invalid trip type.");
      booking.tripType = body.tripType;
    }
    if (has("residents")) {
      if (!Number.isInteger(body.residents) || body.residents < 1) return fail("Residents must be a positive integer.");
      booking.residents = body.residents;
    }
    if (has("pickupDropRequired")) {
      if (typeof body.pickupDropRequired !== "boolean") return fail("pickupDropRequired must be a boolean.");
      booking.pickupDropRequired = body.pickupDropRequired;
    }
    if (has("serviceType")) {
      if (!Booking.schema.path("serviceType").enumValues.includes(body.serviceType)) return fail("Invalid service type.");
      booking.serviceType = body.serviceType;
    }
    const validAmount = value => ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    for (const leg of ["pickup", "drop"]) {
      if (!has(leg)) continue;
      const input = body[leg];
      if (!input || typeof input !== "object" || Array.isArray(input)) return fail(`Invalid ${leg} details.`);
      for (const key of ["location", "landmark", "mapLink", "charge"]) {
        if (!Object.hasOwn(input, key)) continue;
        if (key !== "charge" && typeof input[key] !== "string") return fail(`Invalid ${leg} ${key}.`);
        if (key === "charge" && !validAmount(input[key])) return fail(`Invalid ${leg} charge.`);
        booking.set(`${leg}.${key}`, key === "charge" ? input[key] : input[key].trim());
      }
    }
    const serviceChanged = booking.isModified("pickupDropRequired") || booking.isModified("serviceType");
    if (serviceChanged || has("pickup") || has("drop")) {
      const pickupActive = booking.pickupDropRequired && ["pickup", "pickup_drop"].includes(booking.serviceType);
      const dropActive = booking.pickupDropRequired && ["drop", "pickup_drop"].includes(booking.serviceType);
      if (pickupActive && !booking.pickup?.location?.trim()) return fail("Pickup location is required for the selected service.");
      if (dropActive && !booking.drop?.location?.trim()) return fail("Drop location is required for the selected service.");
      if (!pickupActive && (serviceChanged || Object.hasOwn(body.pickup || {}, "charge"))) booking.set("pickup.charge", 0);
      if (!dropActive && (serviceChanged || Object.hasOwn(body.drop || {}, "charge"))) booking.set("drop.charge", 0);
    }
    booking.fromDate = fromDate;
    booking.toDate = toDate;
    booking.pickupTime = pickupTime.trim();
    booking.dropTime = dropTime.trim();
    if (changedRange) booking.totalDays = calculateTotalDaysFromDates(fromDate, toDate);
    if (changedVehicle) {
      booking.vehicleHistory.push({ fromVehicle: { vehicleId: booking.vehicleId, vehicleName: booking.vehicleName, vehicleNumber: booking.vehicleNumber }, toVehicle: { vehicleId: vehicle._id, vehicleName: vehicle.vehicleName, vehicleNumber: vehicle.vehicleNumber }, changedBy: req.user._id, note: "Vehicle changed through booking editor" });
      booking.vehicleId = vehicle._id;
      booking.vehicleName = vehicle.vehicleName;
      booking.vehicleNumber = vehicle.vehicleNumber;
      booking.vehicleColor = vehicle.color;
    }
    const payment = has("payment") ? body.payment : {};
    if (!payment || typeof payment !== "object" || Array.isArray(payment)) return fail("Invalid payment details.");
    const aliases = { vehicleRent: "vehicleRent", discountAmount: "discountAmount", securityDeposit: "securityDeposit", bookingAmountPaid: "bookingAmount", fastagAmount: "fastagBalance", paymentMethod: "paymentMethod" };
    for (const [key, alias] of Object.entries(aliases)) {
      if (!Object.hasOwn(payment, key) && !has(alias)) continue;
      const value = Object.hasOwn(payment, key) ? payment[key] : body[alias];
      if (key !== "paymentMethod" && !validAmount(value)) return fail(`Invalid payment ${key}.`);
      if (key === "paymentMethod" && !Booking.schema.path("payment.paymentMethod").enumValues.includes(value)) return fail("Invalid payment method.");
      booking.set(`payment.${key}`, value);
    }
    const breakdown = Object.hasOwn(payment, "paymentBreakdown") ? payment.paymentBreakdown : body.paymentBreakdown;
    if (breakdown !== undefined && !(breakdown === null && booking.payment.paymentMethod === "mixed")) {
      if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) return fail("Invalid payment breakdown.");
      for (const key of ["cash", "phonePe", "razorpay"]) {
        if (Object.hasOwn(breakdown, key)) {
          if (!validAmount(breakdown[key])) return fail("Invalid payment breakdown amount.");
          booking.set(`payment.paymentBreakdown.${key}`, breakdown[key]);
        }
      }
    }
    // Keep the saved rental estimate unless explicitly supplied. Updating
    // dates, the vehicle, an advance or discount must not silently reprice it.
    if (booking.isModified("pickup.charge")) {
      booking.payment.pickupCharge = booking.pickupDropRequired && ["pickup", "pickup_drop"].includes(booking.serviceType) ? booking.pickup.charge : 0;
    }
    if (booking.isModified("drop.charge")) {
      booking.payment.dropCharge = booking.pickupDropRequired && ["drop", "pickup_drop"].includes(booking.serviceType) ? booking.drop.charge : 0;
    }
    const fareChanged = ["vehicleRent", "pickupCharge", "dropCharge", "fastagAmount"].some(key => booking.isModified(`payment.${key}`));
    if (fareChanged) {
      // Retain any unitemized historical fare. Changing an advance, deposit,
      // discount, method or split must never replace the saved fare total.
      const delta = ["vehicleRent", "pickupCharge", "dropCharge", "fastagAmount"].reduce((sum, key) => sum + Number(booking.payment[key] || 0) - originalFare[key], 0);
      booking.payment.totalAmount = Math.round((originalFare.totalAmount + delta) * 100) / 100;
    }
    await booking.validate();
    await booking.save();
    await booking.populate({ path: "vehicleId", select: "vehicleName vehicleNumber manufacturer model color pricePerDay images" });
    return res.status(200).json({ success: true, message: "Booking updated successfully.", booking });
  } catch (error) {
    next(error);
  }
};

export const cancelBooking = async (req, res, next) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findOne({
      _id: id,
      isDeleted: false,
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
    }

    if (booking.status === "active") {
      return res.status(400).json({
        success: false,
        message:
          "Vehicle has already been handed over. Active bookings cannot be cancelled.",
      });
    }

    if (booking.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Completed bookings cannot be cancelled.",
      });
    }

    if (booking.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Booking is already cancelled.",
      });
    }

    booking.status = "cancelled";
    // isDeleted stays false — a cancelled booking is a real, visible
    // outcome, not a deleted record. Keep it queryable for the
    // Cancelled tab, history, and reporting.
    booking.cancelledAt = new Date();
    booking.cancelledBy = req.user._id;

    await booking.save();

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully.",
      booking,
    });
  } catch (error) {
    next(error);
  }
};
