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

      leadOwner,

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

    const existingLead = await Lead.findOne({
      company: req.user.company,
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
    // Create Lead
    // =============================

    const lead = new Lead({
      leadDate: leadDate || new Date(),

      leadTime,

      customerName: customerName.trim(),

      mobileNumber: mobileNumber.trim(),

      vehicleType,

      vehicleName,

      fromDate,

      toDate,

      residents,

      whatsappSent,

      priority,

      leadOwner: leadOwner || req.user._id,

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

      company: req.user.company,

      createdBy: req.user._id,
    });

    // =============================
    // First Note
    // =============================

    if (
      notes &&
      Array.isArray(notes) &&
      notes.length > 0
    ) {
      lead.notes = notes.map((note) => ({
        message: note.message,
        type: note.type || "call",
        addedBy: req.user._id,
      }));
    }

    // =============================
    // Auto Create Summary Note
    // =============================

    if (
      conversationSummary &&
      conversationSummary.trim() !== ""
    ) {
      lead.notes.push({
        message: conversationSummary,
        type: "call",
        addedBy: req.user._id,
      });
    }

    // =============================
    // Save
    // =============================

    await lead.save();

    // =============================
    // Populate Response
    // =============================

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
        path: "notes.addedBy",
        select: "name",
      },
    ]);

    // =============================
    // Response
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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};