import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import LeadHistory from "../models/leadHistory.model.js";
import Booking from "../models/booking.model.js";

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

export const getBookingsDashboard = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const bookings = await Booking.find({
      isDeleted: false,
    })
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
      .sort({ createdAt: -1 });

    const stats = {
      totalBookings: bookings.length,
      todayPickup: 0,
      tomorrowPickup: 0,
      activeRentals: 0,
      pendingHandover: 0,
      completed: 0,
      cancelled: 0,
    };

    const dashboard = bookings.map((booking) => {
      const pickup = booking.fromDate ? new Date(booking.fromDate) : null;

      const drop = booking.toDate ? new Date(booking.toDate) : null;

      let status = "Booking Confirmed";

      if (booking.status === "completed") {
        status = "Completed";
        stats.completed++;
      } else if (booking.status === "cancelled") {
        status = "Cancelled";
        stats.cancelled++;
      } else if (
        booking.status === "confirmed" ||
        booking.status === "handover_pending"
      ) {
        stats.pendingHandover++;
      }

      if (pickup) {
        const pickupDay = new Date(pickup);
        pickupDay.setHours(0, 0, 0, 0);

        if (booking.status !== "completed" && booking.status !== "cancelled") {
          if (pickupDay.getTime() === today.getTime()) {
            status = "Today's Pickup";
            stats.todayPickup++;
          } else if (pickupDay.getTime() === tomorrow.getTime()) {
            status = "Tomorrow's Pickup";
            stats.tomorrowPickup++;
          }
        }
      }

      if (
        booking.status === "active" ||
        booking.status === "vehicle_handover"
      ) {
        status = "Active Rental";
        stats.activeRentals++;
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

        tripDays: booking.totalDays,
        residents: booking.residents,

        quotationAmount: booking.quotationAmount,
        bookingAmount: booking.bookingAmount,
        discountAmount: booking.discountAmount,

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

        createdAt: booking.createdAt,
      };
    });

    return res.status(200).json({
      success: true,
      stats,
      bookings: dashboard,
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
      // CAPTURE NEW FIELDS FROM MOBILE APP
      fromDate,
      toDate,
      pickupTime,
      dropTime,
    } = req.body;

    if (!vehicleId) {
      return res.status(400).json({
        success: false,
        message: "Vehicle is required.",
      });
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

      // COMMIT UPDATED DATETIMES TO DB
      fromDate: finalFromDate,
      toDate: finalToDate,
      pickupTime: pickupTime || "09:00 AM",
      dropTime: dropTime || "06:00 PM",

      residents: lead.residents,
      vehicleId,
      vehicleName,

      quotationAmount: lead.quotationAmount || 0,
      bookingAmount: Number(bookingAmount) || 0,
      discountAmount: Number(discountAmount) || 0,
      status: "confirmed",
    });

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
