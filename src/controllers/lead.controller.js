import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import LeadHistory from "../models/leadHistory.model.js";
import Booking from "../models/booking.model.js";
import Vehicle from "../models/vehicle.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";

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

    if (priority && priority !== "all") {
      query.priority = {
        $regex: new RegExp(`^${priority}$`, "i"),
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

// v1.0
export const getBookingsDashboards = async (req, res) => {
  try {
    // ==========================
    // QUERY PARAMS
    // ==========================
    const {
      tab = "All",
      search = "",
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 20, 1);

    // ==========================
    // IST DATE HELPERS
    // ==========================
    const getISTDateString = (date) =>
      new Date(date).toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      }); // YYYY-MM-DD

    const now = new Date();
    const today = getISTDateString(now);

    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = getISTDateString(tomorrowDate);

    const bookings = await Booking.find({ isDeleted: false })
      // Only pull the fields the dashboard card / list actually renders.
      // Trims payload size and avoids hydrating fields (long text notes,
      // historical audit fields, etc.) that never reach the screen.
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
        populate: {
          path: "leadOwner",
          select: "name fullName",
        },
      })
      .populate({
        path: "vehicleId",
        select: "vehicleName vehicleNumber color",
      })
      .populate({
        path: "createdBy",
        select: "name fullName",
      })
      .populate({
        path: "assignedDriver",
        select: "fullName name mobileNumber",
      })
      .sort({ createdAt: -1 })
      // .lean() skips Mongoose document hydration (getters, virtuals, change
      // tracking) — for a read-only dashboard list this is a large, free win,
      // especially as the collection grows.
      .lean();

    const stats = {
      totalBookings: bookings.length,
      pendingHandover: 0,
      todayPickup: 0,
      tomorrowPickup: 0,
      upcoming: 0,
      activeRentals: 0,
      completed: 0,
      cancelled: 0,
    };

    const dashboard = bookings.map((booking) => {
      let status = "Booking Confirmed";
      // `bucket` drives TAB FILTERING below. It's kept separate from the
      // human-readable `status` string so tab matching never depends on
      // exact label text (labels can change; buckets stay stable).
      let bucket = "confirmed";

      // ==========================
      // COMPLETED / CANCELLED
      // ==========================
      if (booking.status === "completed") {
        status = "Completed";
        bucket = "completed";
        stats.completed++;
      } else if (booking.status === "cancelled") {
        status = "Cancelled";
        bucket = "cancelled";
        stats.cancelled++;
      }

      // ==========================
      // ACTIVE RENTAL
      // ==========================
      if (
        booking.status === "active" ||
        booking.status === "vehicle_handover"
      ) {
        status = "Active Rental";
        bucket = "active";
        stats.activeRentals++;
      }

      // ==========================
      // PENDING (overdue, not handed over) / TODAY / TOMORROW / FUTURE
      // DATE ONLY (TIME IGNORED)
      // ==========================
      const isOpenBooking =
        booking.status !== "completed" &&
        booking.status !== "cancelled" &&
        booking.status !== "active" &&
        booking.status !== "vehicle_handover";

      if (booking.fromDate && isOpenBooking) {
        const pickupDate = getISTDateString(booking.fromDate);

        if (pickupDate < today) {
          status = "Pending Handover";
          bucket = "pending";
          stats.pendingHandover++;
        } else if (pickupDate === today) {
          status = "Today's Pickup";
          bucket = "today";
          stats.todayPickup++;
          stats.upcoming++;
        } else if (pickupDate === tomorrow) {
          status = "Tomorrow's Pickup";
          bucket = "tomorrow";
          stats.tomorrowPickup++;
          stats.upcoming++;
        } else {
          bucket = "upcoming";
          stats.upcoming++;
        }
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
        // internal-only field used for tab filtering below; not required by
        // the UI, but harmless to leave on the payload.
        bucket,

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

    // ==========================
    // SEARCH (applied before tab split so stats reflect the search scope,
    // but not the currently selected tab)
    // ==========================
    const searchTerm = String(search || "").trim().toLowerCase();
    const searched = searchTerm
      ? dashboard.filter((b) => {
          const haystack = [
            b.customerName,
            b.mobileNumber,
            b.alternateMobileNumber,
            b.bookingCode,
            b.vehicleName,
            b.vehicleNumber,
            b.destination,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(searchTerm);
        })
      : dashboard;

    // ==========================
    // TAB FILTERING
    // ==========================
    const TAB_BUCKETS = {
      All: null, // no filter
      Pending: ["pending"],
      "Today's Pickup": ["today"],
      "Tomorrow's Pickup": ["tomorrow"],
      // "Upcoming" = every open booking that isn't overdue: today,
      // tomorrow, and further-out confirmed pickups.
      Upcoming: ["today", "tomorrow", "upcoming"],
      "Active Rental": ["active"],
      Completed: ["completed"],
      Cancelled: ["cancelled"],
    };

    const allowedBuckets = Object.prototype.hasOwnProperty.call(
      TAB_BUCKETS,
      tab,
    )
      ? TAB_BUCKETS[tab]
      : null; // unknown tab name -> behave like "All" rather than erroring

    const tabFiltered = allowedBuckets
      ? searched.filter((b) => allowedBuckets.includes(b.bucket))
      : searched;

    // ==========================
    // PAGINATION
    // ==========================
    const total = tabFiltered.length;
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    const pageItems = tabFiltered.slice(startIndex, endIndex);
    const hasMore = endIndex < total;

    return res.status(200).json({
      success: true,
      stats,
      bookings: pageItems,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore,
      },
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
//v1.1
// ==========================================
// In-memory micro-cache (swap for Redis if you run >1 instance)
// TTL is short — just enough to absorb repeated dashboard hits
// (tab switches, pull-to-refresh double-taps, multiple devices).
// ==========================================
const dashboardCache = new Map();
const CACHE_TTL_MS = 8000;

export const invalidateBookingsCache = () => dashboardCache.clear();

const getISTDateString = (date) =>
  new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export const getBookingsDashboardss = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // hard cap
    const tab = req.query.tab || "All";
    const search = (req.query.search || "").trim();

    const cacheKey = `${page}:${limit}:${tab}:${search}`;
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      res.set("X-Cache", "HIT");
      return res.status(200).json(cached.payload);
    }

    const now = new Date();
    const today = getISTDateString(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = getISTDateString(tomorrowDate);

    const skip = (page - 1) * limit;

    const basePipeline = [
      // Uses { isDeleted: 1, createdAt: -1 } index — see index note below
      { $match: { isDeleted: false } },

      // ---- lightweight lookups, projected at the source (no full doc hydration) ----
      {
        $lookup: {
          from: "leads",
          localField: "lead",
          foreignField: "_id",
          as: "lead",
          pipeline: [
            {
              $project: {
                leadId: 1,
                priority: 1,
                source: 1,
                vehicleType: 1,
                bookingConfirmedAt: 1,
                leadOwner: 1,
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "leadOwner",
                foreignField: "_id",
                as: "leadOwner",
                pipeline: [{ $project: { name: 1, fullName: 1 } }],
              },
            },
            { $unwind: { path: "$leadOwner", preserveNullAndEmptyArrays: true } },
          ],
        },
      },
      { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "vehicles",
          localField: "vehicleId",
          foreignField: "_id",
          as: "vehicleId",
          pipeline: [{ $project: { vehicleName: 1, vehicleNumber: 1, color: 1 } }],
        },
      },
      { $unwind: { path: "$vehicleId", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "createdBy",
          pipeline: [{ $project: { name: 1, fullName: 1 } }],
        },
      },
      { $unwind: { path: "$createdBy", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "drivers", // adjust to your actual collection name
          localField: "assignedDriver",
          foreignField: "_id",
          as: "assignedDriver",
          pipeline: [{ $project: { fullName: 1, name: 1, mobileNumber: 1 } }],
        },
      },
      { $unwind: { path: "$assignedDriver", preserveNullAndEmptyArrays: true } },

      // ---- derived status computed once, in the DB, not per-request in JS on every doc ----
      {
        $addFields: {
          pickupDateStr: {
            $cond: [
              { $ifNull: ["$fromDate", false] },
              { $dateToString: { format: "%Y-%m-%d", date: "$fromDate", timezone: "Asia/Kolkata" } },
              null,
            ],
          },
          isOpenBooking: { $not: [{ $in: ["$status", ["completed", "cancelled", "active", "vehicle_handover"]] }] },
        },
      },
      {
        $addFields: {
          computedStatus: {
            $switch: {
              branches: [
                { case: { $eq: ["$status", "completed"] }, then: "Completed" },
                { case: { $eq: ["$status", "cancelled"] }, then: "Cancelled" },
                { case: { $in: ["$status", ["active", "vehicle_handover"]] }, then: "Active Rental" },
                {
                  case: { $and: ["$isOpenBooking", { $ne: ["$pickupDateStr", null] }, { $lt: ["$pickupDateStr", today] }] },
                  then: "Pending Handover",
                },
                {
                  case: { $and: ["$isOpenBooking", { $eq: ["$pickupDateStr", today] }] },
                  then: "Today's Pickup",
                },
                {
                  case: { $and: ["$isOpenBooking", { $eq: ["$pickupDateStr", tomorrow] }] },
                  then: "Tomorrow's Pickup",
                },
              ],
              default: "Booking Confirmed",
            },
          },
          isUpcoming: {
            $and: [
              "$isOpenBooking",
              { $ne: ["$pickupDateStr", null] },
              { $gte: ["$pickupDateStr", today] },
            ],
          },
        },
      },
    ];

    // ---- tab filter (server-side, on the already-computed status) ----
    const tabMatch = [];
    if (tab === "Pending") tabMatch.push({ $match: { computedStatus: "Pending Handover" } });
    else if (tab === "Upcoming") tabMatch.push({ $match: { isUpcoming: true } });
    else if (tab !== "All") tabMatch.push({ $match: { computedStatus: tab } });

    // ---- search filter (server-side, across the fields the UI searches) ----
    const searchMatch = [];
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      searchMatch.push({
        $match: {
          $or: [
            { customerName: re },
            { mobileNumber: re },
            { bookingCode: re },
            { destination: re },
            { "vehicleId.vehicleName": re },
            { vehicleName: re },
          ],
        },
      });
    }

    const filterStage = [...tabMatch, ...searchMatch];

    const pipeline = [
      ...basePipeline,
      ...filterStage,
      {
        $facet: {
          stats: [
            {
              $group: {
                _id: null,
                totalBookings: { $sum: 1 },
                pendingHandover: { $sum: { $cond: [{ $eq: ["$computedStatus", "Pending Handover"] }, 1, 0] } },
                todayPickup: { $sum: { $cond: [{ $eq: ["$computedStatus", "Today's Pickup"] }, 1, 0] } },
                tomorrowPickup: { $sum: { $cond: [{ $eq: ["$computedStatus", "Tomorrow's Pickup"] }, 1, 0] } },
                activeRentals: { $sum: { $cond: [{ $eq: ["$computedStatus", "Active Rental"] }, 1, 0] } },
                completed: { $sum: { $cond: [{ $eq: ["$computedStatus", "Completed"] }, 1, 0] } },
                cancelled: { $sum: { $cond: [{ $eq: ["$computedStatus", "Cancelled"] }, 1, 0] } },
                upcoming: { $sum: { $cond: ["$isUpcoming", 1, 0] } },
              },
            },
          ],
          totalCount: [{ $count: "count" }],
          data: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                bookingCode: 1,
                lead: 1,
                customerName: 1,
                mobileNumber: 1,
                alternateMobileNumber: 1,
                occupation: 1,
                destination: 1,
                aadhaarNumber: 1,
                drivingLicenseNumber: 1,
                tripType: 1,
                fromDate: 1,
                toDate: 1,
                pickupTime: 1,
                dropTime: 1,
                totalDays: 1,
                residents: 1,
                payment: 1,
                vehicleId: 1,
                vehicleName: 1,
                vehicleNumber: 1,
                vehicleColor: 1,
                status: 1,
                computedStatus: 1,
                handover: 1,
                vehicleReturn: 1,
                pickupDropRequired: 1,
                serviceType: 1,
                pickup: 1,
                drop: 1,
                assignedDriver: 1,
                createdBy: 1,
                pickupDropNotes: 1,
                createdAt: 1,
              },
            },
          ],
        },
      },
    ];

    const [result] = await Booking.aggregate(pipeline).allowDiskUse(true);

    const stats = result.stats[0] || {
      totalBookings: 0,
      pendingHandover: 0,
      todayPickup: 0,
      tomorrowPickup: 0,
      upcoming: 0,
      activeRentals: 0,
      completed: 0,
      cancelled: 0,
    };
    const total = result.totalCount[0]?.count || 0;

    const dashboard = result.data.map((booking) => ({
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
      vehicleNumber: booking.vehicleId?.vehicleNumber || booking.vehicleNumber,
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
      bookingConfirmedAt: booking.lead?.bookingConfirmedAt || booking.createdAt,
      status: booking.computedStatus,
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
            fullName: booking.assignedDriver.fullName || booking.assignedDriver.name || "",
            mobileNumber: booking.assignedDriver.mobileNumber || "",
          }
        : null,
      pickupDropNotes: booking.pickupDropNotes,
      createdBy: booking.createdBy
        ? { _id: booking.createdBy._id, name: booking.createdBy.fullName || booking.createdBy.name || "" }
        : null,
      createdAt: booking.createdAt,
    }));

    const payload = {
      success: true,
      stats,
      bookings: dashboard,
      pagination: { page, limit, total, hasMore: skip + dashboard.length < total },
    };

    dashboardCache.set(cacheKey, { ts: Date.now(), payload });

    res.set("X-Cache", "MISS");
    return res.status(200).json(payload);
  } catch (error) {
    console.error("BOOKING DASHBOARD ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch bookings.", error: error.message });
  }
};
// v1.2
//new booking api start [get]
const OPEN_STATUSES_EXCLUDED = ["completed", "cancelled", "active", "vehicle_handover"];

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

    const allowedBuckets = Object.prototype.hasOwnProperty.call(TAB_BUCKETS, tab)
      ? TAB_BUCKETS[tab]
      : null;

    const startIndex = (pageNum - 1) * limitNum;

    const pagePipeline = [
      ...baseMatchStages,
      ...bucketingStages(today, tomorrow),
      ...(allowedBuckets ? [{ $match: { bucket: { $in: allowedBuckets } } }] : []),
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
        select: "leadId priority source vehicleType bookingConfirmedAt leadOwner",
        populate: { path: "leadOwner", select: "name fullName" },
      })
      .populate({ path: "vehicleId", select: "vehicleName vehicleNumber color" })
      .populate({ path: "createdBy", select: "name fullName" })
      .populate({ path: "assignedDriver", select: "fullName name mobileNumber" })
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
        vehicleNumber: booking.vehicleId?.vehicleNumber || booking.vehicleNumber,
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
        bookingConfirmedAt: booking.lead?.bookingConfirmedAt || booking.createdAt,
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
                booking.assignedDriver.fullName || booking.assignedDriver.name || "",
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

export const invalidateBookingStatsCache = () => statsCache.clear();
//new booking api ending [get]

export const createLeadBooking = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id);

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
    await lead.save();

    const companyId = req.user.company || req.user._id;

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
    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle || vehicle.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found.",
      });
    }

    const finalTotalDays = Number(totalDays) || 1;

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

          customer: {
            fullName: customerName.trim(),
            mobileNumber: mobileNumber.trim(),
          },

          vehicle: {
            vehicleId: selectedVehicle._id,
            vehicleName: selectedVehicle.vehicleName,
            vehicleNumber: selectedVehicle.vehicleNumber,
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

//v1.1
export const createBooking = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const {
      customerName,
      mobileNumber,
      alternateMobileNumber,
      occupation,
      destination,
      aadhaarNumber,
      drivingLicenseNumber,
      totalDays,
      tripType,
      fromDate,
      toDate,
      pickupTime,
      dropTime,
      residents,
      vehicleId,
      vehicleType, // "car" | "bike" — needed for the Lead record

      bookingAmount, // advance paid now
      discountAmount,
      securityDeposit,
      fastagBalance,

      // NEW: how the advance was collected
      paymentMethod = "cash", // "cash" | "phonepe" | "razorpay" | "mixed"
      paymentBreakdown = {}, // { cash, phonePe, razorpay } — only used/required when paymentMethod === "mixed"

      pickupDropRequired = false,
      serviceType = "pickup_drop",
      pickup = {},
      drop = {},
      pickupDropNotes = "",
    } = req.body;

    // ========================= VALIDATIONS (unchanged) =========================
    if (!customerName?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Customer name is required." });
    }
    if (!mobileNumber?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Mobile number is required." });
    }
    if (!vehicleId) {
      return res
        .status(400)
        .json({ success: false, message: "Vehicle is required." });
    }
    if (!fromDate || !toDate) {
      return res
        .status(400)
        .json({ success: false, message: "Trip dates are required." });
    }
    if (pickupDropRequired) {
      if (
        (serviceType === "pickup" || serviceType === "pickup_drop") &&
        !pickup.location?.trim()
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Pickup location is required." });
      }
      if (
        (serviceType === "drop" || serviceType === "pickup_drop") &&
        !drop.location?.trim()
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Drop location is required." });
      }
    }

    const finalTotalDays = Number(totalDays);
    if (!Number.isInteger(finalTotalDays) || finalTotalDays < 1) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid total days." });
    }

    const finalFromDate = new Date(fromDate);
    const finalToDate = new Date(toDate);

    if (
      !Number.isFinite(finalFromDate.getTime()) ||
      !Number.isFinite(finalToDate.getTime())
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid trip date.",
      });
    }

    // NEW: validate payment method / mixed breakdown
    const VALID_PAYMENT_METHODS = ["cash", "phonepe", "razorpay", "mixed"];
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment method." });
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
      breakdown.cash = paymentMethod === "cash" ? advancePaid : 0;
      breakdown.phonePe = paymentMethod === "phonepe" ? advancePaid : 0;
      breakdown.razorpay = paymentMethod === "razorpay" ? advancePaid : 0;
    }

    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle || vehicle.isDeleted) {
      return res
        .status(404)
        .json({ success: false, message: "Vehicle not found." });
    }

    // ========================= PRICING =========================
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

    session.startTransaction();

    const existingBooking = await Booking.findOne({
      vehicleId,
      isDeleted: false,
      status: { $nin: ["cancelled", "completed"] },
      fromDate: { $lt: finalToDate },
      toDate: { $gt: finalFromDate },
    }).session(session);

    if (existingBooking) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: `This vehicle is already booked from ${existingBooking.fromDate.toDateString()} to ${existingBooking.toDate.toDateString()}, which overlaps with the selected dates.`,
      });
    }

    const companyId = req.user.company || req.user._id;

    let lead = await Lead.findOne({
      mobileNumber: mobileNumber.trim(),
      company: companyId,
      isDeleted: false,
    }).session(session);

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
        { session },
      );
      lead = newLead;
    }

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
          fromDate: finalFromDate,
          toDate: finalToDate,
          pickupTime: pickupTime || "08:00 AM",
          dropTime: dropTime || "08:00 AM",
          totalDays: finalTotalDays,
          residents: Number(residents) || 1,

          vehicleId: vehicle._id,
          vehicleName: vehicle.vehicleName,
          vehicleNumber: vehicle.vehicleNumber,
          vehicleColor: vehicle.color,

          // Flat fields kept for existing list/card screens
          quotationAmount,
          bookingAmount: advancePaid,
          discountAmount: finalDiscountAmount,
          securityDeposit: finalSecurityDeposit,
          fastagBalance: fastagAmount,

          // NEW: structured payment/bill record
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
            // balanceAmount / totalCollected / paymentStatus are computed
            // by the pre("save") hook on the Booking model.
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
      { session },
    );

    if (Number(advancePaid) > 0) {
      try {
        await PaymentHistory.create({
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

          amount: advancePaid,

          paymentMethod,

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
        console.error("Payment History Creation Error:", paymentHistoryError);
      }
    }

    lead.bookingId = booking._id;
    lead.bookingConfirmedAt = new Date();
    lead.isBookingCreated = true;
    await lead.save({ session });

    await session.commitTransaction();

    await booking.populate({
      path: "vehicleId",
      select: "vehicleName vehicleNumber color manufacturer model pricePerDay",
    });

    return res.status(201).json({
      success: true,
      message: "Booking created successfully.",
      booking,
      leadId: lead._id,
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();

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

    next(error);
  } finally {
    session.endSession();
  }
};
export const createBookings = async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
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
          status: existingBooking.status,
        },
      });
    }

    // ============================================================
    // COMPANY
    // ============================================================

    const companyId = req.user.company || req.user._id;

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
    // PAYMENT HISTORY
    // ============================================================

    if (advancePaid > 0) {
      try {
        await PaymentHistory.create(
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

              amount: advancePaid,

              paymentMethod,
              upiLast4: paymentMethod === "phonepe" ? normalizedUpiLast4 : "",
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
          {
            session,
          },
        );
      } catch (paymentHistoryError) {
        console.error("Payment History Creation Error:", paymentHistoryError);
      }
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

export const updateBooking = async (req, res, next) => {
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

    const {
      customerName,
      mobileNumber,
      alternateMobileNumber,
      occupation,
      destination,
      aadhaarNumber,
      drivingLicenseNumber,
      tripType,
      fromDate,
      toDate,
      pickupTime,
      dropTime,
      residents,

      vehicleId,

      pickupDropRequired = false,
      serviceType = "pickup_drop",

      pickup = {},
      drop = {},
      pickupDropNotes = "",

      // ── FIX: the frontend sends every pricing field nested inside
      // `payment: {...}` (see BookingDetailsScreen's handleUpdateBooking
      // payload). The old code destructured `bookingAmount`,
      // `discountAmount`, `securityDeposit`, `fastagBalance` as flat
      // top-level fields, which the client never sends at the top level —
      // they were always undefined, so every price update silently used 0.
      payment: paymentInput = {},
    } = req.body;

    const {
      discountAmount: discountAmountInput,
      securityDeposit: securityDepositInput,
      bookingAmountPaid: bookingAmountPaidInput,
      fastagAmount: fastagAmountInput,
      paymentMethod: paymentMethodInput,
    } = paymentInput;

    // =========================
    // VEHICLE
    // =========================

    const vehicle = await Vehicle.findById(vehicleId);

    if (!vehicle || vehicle.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found.",
      });
    }

    // =========================
    // DATES
    // =========================

    const finalFromDate = new Date(fromDate);
    const finalToDate = new Date(toDate);

    if (isNaN(finalFromDate.getTime()) || isNaN(finalToDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid pickup or drop date.",
      });
    }

    // =========================
    // TOTAL DAYS
    // ── FIX: recompute from fromDate/toDate server-side instead of
    // trusting req.body.totalDays. The client's totalDays is no longer
    // read at all — this is now the single source of truth for both the
    // frontend and backend, using the same calendar-day-difference logic,
    // so pricing can never be manipulated or drift out of sync with the
    // dates actually stored on the booking.
    // =========================

    const finalTotalDays = calculateTotalDaysFromDates(
      finalFromDate,
      finalToDate,
    );

    // =========================
    // PRICING (recomputed server-side — never trust client totals)
    // =========================

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

    const fastagAmount = Number(fastagAmountInput || 0);

    const discountAmount = Number(discountAmountInput || 0);
    const securityDeposit = Number(securityDepositInput || 0);
    const bookingAmountPaid = Number(bookingAmountPaidInput || 0);

    // Vehicle + Pickup + Drop + FASTag — matches the schema comment on
    // `payment.totalAmount` and the frontend's `rentalAmount` /
    // `finalAmount` calculation. Security deposit is tracked separately
    // (it's refundable, not part of the payable fare).
    const totalAmount = vehicleRent + pickupCharge + dropCharge + fastagAmount;

    // =========================
    // UPDATE — CUSTOMER / TRIP FIELDS
    // =========================

    booking.customerName = customerName?.trim() || "";
    booking.mobileNumber = mobileNumber?.trim() || "";
    booking.alternateMobileNumber = alternateMobileNumber?.trim() || "";
    booking.occupation = occupation?.trim() || "";

    booking.destination = destination?.trim() || "";

    booking.aadhaarNumber = aadhaarNumber?.trim() || "";

    booking.drivingLicenseNumber =
      drivingLicenseNumber?.trim().toUpperCase() || "";

    booking.tripType = tripType || "local";

    booking.fromDate = finalFromDate;
    booking.toDate = finalToDate;

    booking.pickupTime = pickupTime || "09:00 AM";
    booking.dropTime = dropTime || "06:00 PM";

    booking.totalDays = finalTotalDays;
    booking.residents = Number(residents) || 1;

    booking.vehicleId = vehicle._id;
    booking.vehicleName = vehicle.vehicleName;
    booking.vehicleNumber = vehicle.vehicleNumber;
    booking.vehicleColor = vehicle.color;

    // =========================
    // UPDATE — PAYMENT (only fields that actually exist on the schema;
    // balanceAmount / totalCollected / paymentStatus are recomputed
    // automatically by the pre-save hook, so we don't set them here)
    // =========================

    booking.payment = booking.payment || {};

    booking.payment.vehicleRent = vehicleRent;
    booking.payment.pickupCharge = pickupCharge;
    booking.payment.dropCharge = dropCharge;
    booking.payment.fastagAmount = fastagAmount;
    booking.payment.totalAmount = totalAmount;
    booking.payment.discountAmount = discountAmount;
    booking.payment.securityDeposit = securityDeposit;
    booking.payment.bookingAmountPaid = bookingAmountPaid;
    booking.payment.paymentMethod = paymentMethodInput || "cash";

    // =========================
    // UPDATE — PICKUP / DROP SERVICE
    // =========================

    booking.pickupDropRequired = pickupDropRequired;
    booking.serviceType = serviceType;

    booking.pickup = {
      location: pickup.location?.trim() || "",
      landmark: pickup.landmark?.trim() || "",
      mapLink: pickup.mapLink?.trim() || "",
      charge: pickupCharge,
    };

    booking.drop = {
      location: drop.location?.trim() || "",
      landmark: drop.landmark?.trim() || "",
      mapLink: drop.mapLink?.trim() || "",
      charge: dropCharge,
    };

    booking.pickupDropNotes = pickupDropNotes?.trim() || "";

    // booking.payment.balanceAmount, totalCollected, and paymentStatus are
    // derived automatically in the schema's pre-save hook from
    // totalAmount / discountAmount / bookingAmountPaid / securityDeposit —
    // no need to compute or assign them here.

    await booking.save();

    await booking.populate({
      path: "vehicleId",
      select:
        "vehicleName vehicleNumber manufacturer model color pricePerDay images",
    });

    return res.status(200).json({
      success: true,
      message: "Booking updated successfully.",
      booking,
    });
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
