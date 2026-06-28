import Lead from "../models/lead.model.js";

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

export const getLeads = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;

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
      company: companyId,
      isDeleted: false,
    };

    // ==========================================
    // Search
    // ==========================================

    if (search && search.trim() !== "") {
      query.$or = [
        {
          customerName: {
            $regex: search.trim(),
            $options: "i",
          },
        },
        {
          mobileNumber: {
            $regex: search.trim(),
            $options: "i",
          },
        },
        {
          vehicleName: {
            $regex: search.trim(),
            $options: "i",
          },
        },
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
        query.nextFollowupDate = {
          $gte: today,
          $lt: tomorrow,
        };
        break;

      case "tomorrow_followup":
        query.nextFollowupDate = {
          $gte: tomorrow,
          $lt: dayAfterTomorrow,
        };
        break;

      case "missed_followup":
        query.nextFollowupDate = {
          $lt: today,
        };

        query.status = {
          $nin: ["Booking confirmed", "Deal lost"],
        };

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

      query[field] = {
        $gte: start,
        $lte: end,
      };
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

    const sort = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    // ==========================================
    // Database
    // ==========================================

    const total = await Lead.countDocuments(query);

    const leads = await Lead.find(query)
      .populate("leadOwner", "name email phone")
      .populate("createdBy", "name")
      .populate("company", "companyName")
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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};

export const getLeadById = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;
    const { id } = req.params;

    const lead = await Lead.findOne({
      _id: id,
      company: companyId,
      isDeleted: false,
    })
      .populate("leadOwner", "name email phone")
      .populate("createdBy", "name email phone")
      .populate("company", "companyName email phone")
      .populate("bookingId")
      .populate("notes.addedBy", "name email");

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
    console.error("Get Lead By ID Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch lead.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};
export const updateLead = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;
    const { id } = req.params;

    const lead = await Lead.findOne({
      _id: id,
      company: companyId,
      isDeleted: false,
    });

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found.",
      });
    }

    const allowedFields = [
      "leadDate",
      "leadTime",
      "customerName",
      "mobileNumber",
      "vehicleType",
      "vehicleName",
      "fromDate",
      "toDate",
      "residents",
      "whatsappSent",
      "priority",
      "leadOwner",
      "missedCalls",
      "cabService",
      "source",
      "campaignName",
      "utmSource",
      "utmMedium",
      "status",
      "conversationSummary",
      "detailedConversation",
      "lastContactedDate",
      "lastFollowupDate",
      "nextFollowupDate",
      "nextActionItem",
      "mondayLead",
      "longBookingLead",
      "strategyForClosing",
      "strategyPreparedBy",
      "quotationSent",
      "quotationAmount",
      "bookingId",
      "reasonForDealLoss",
      "remarksFeedback",
      "feedbackBy",
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        lead[field] = req.body[field];
      }
    });

    if (req.body.customerName !== undefined) {
      lead.customerName = req.body.customerName.trim();
    }

    if (req.body.mobileNumber !== undefined) {
      lead.mobileNumber = req.body.mobileNumber.trim();
    }

    if (req.body.residents !== undefined) {
      lead.residents = Number(req.body.residents);
    }

    if (req.body.missedCalls !== undefined) {
      lead.missedCalls = Number(req.body.missedCalls);
    }

    if (req.body.quotationAmount !== undefined) {
      lead.quotationAmount = Number(req.body.quotationAmount);
    }

    await lead.save();

    await lead.populate([
      {
        path: "leadOwner",
        select: "name email phone",
      },
      {
        path: "createdBy",
        select: "name email",
      },
      {
        path: "company",
        select: "companyName",
      },
      {
        path: "bookingId",
      },
      {
        path: "notes.addedBy",
        select: "name",
      },
    ]);

    return res.status(200).json({
      success: true,
      message: "Lead updated successfully.",
      data: lead,
    });
  } catch (error) {
    console.error("Update Lead Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update lead.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};
export const deleteLead = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;
    const { id } = req.params;

    const lead = await Lead.findOne({
      _id: id,
      company: companyId,
      isDeleted: false,
    });

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found.",
      });
    }

    lead.isDeleted = true;
    lead.deletedAt = new Date();
    lead.deletedBy = req.user._id;

    await lead.save();

    return res.status(200).json({
      success: true,
      message: "Lead deleted successfully.",
    });
  } catch (error) {
    console.error("Delete Lead Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to delete lead.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};

export const getLeadDashboardStats = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(today.getDate() + 2);

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
      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        status: "Enquiry",
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        nextFollowupDate: {
          $gte: today,
          $lt: tomorrow,
        },
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        nextFollowupDate: {
          $gte: tomorrow,
          $lt: dayAfterTomorrow,
        },
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        nextFollowupDate: {
          $lt: today,
        },
        status: {
          $nin: ["Booking confirmed", "Deal lost"],
        },
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        quotationSent: true,
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        status: "Booking confirmed",
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        status: "Deal lost",
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        priority: "high",
      }),

      Lead.countDocuments({
        company: companyId,
        isDeleted: false,
        whatsappSent: true,
      }),
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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};