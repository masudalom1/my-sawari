import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import LeadHistory from "../models/leadHistory.model.js";

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
      detailedConversation,

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
      { path: "leadOwner", select: "name email phone" },
      { path: "createdBy", select: "name email" },
      { path: "company", select: "companyName" },
      { path: "notes.addedBy", select: "name" },
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
      .populate("leadOwner", "name email phone")
      .populate("createdBy", "name email phone")
      .populate("notes.addedBy", "name");

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

    const companyId = req.user.company || req.user._id;

    const lead = await Lead.findOne({
      _id: id,
      company: companyId,
      isDeleted: false,
    });

    if (!lead) {
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
      "detailedConversation",
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
      if (value instanceof mongoose.Types.ObjectId) return value.toString();
      return String(value ?? "");
    };

    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;

      const oldValue = lead[field];
      let newValue = req.body[field];

      if (field === "leadOwner" && typeof newValue === "object") {
        newValue = newValue._id;
      }

      if (normalize(oldValue) !== normalize(newValue)) {
        historyLogs.push({
          lead: lead._id,
          company: companyId,
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

    await lead.save();

    if (historyLogs.length) {
      await LeadHistory.insertMany(historyLogs);
    }

    const updatedLead = await Lead.findById(lead._id)
      .populate("leadOwner", "name email")
      .populate("createdBy", "name email")
      .populate("notes.addedBy", "name");

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

    const companyId = req.user.company || req.user._id;

    const history = await LeadHistory.find({
      lead: id,
      company: companyId,
    })
      .populate("changedBy", "name email")
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      data: history,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch history",
    });
  }
};
