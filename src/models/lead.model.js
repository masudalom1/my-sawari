import mongoose from "mongoose";

const noteSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
      trim: true,
    },

    type: {
      type: String,
      enum: [
        "call",
        "whatsapp",
        "message",
        "email",
        "meeting",
        "system",
      ],
      default: "call",
    },

    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const leadSchema = new mongoose.Schema(
  {
    leadId: {
      type: String,
      unique: true,
      index: true,
    },

    leadDate: {
      type: Date,
      default: Date.now,
    },

    leadTime: {
      type: String,
      default: "",
      trim: true,
    },

    customerName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    mobileNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    vehicleType: {
      type: String,
      enum: ["car", "bike"],
      required: true,
    },

    vehicleName: {
      type: String,
      trim: true,
      default: "",
    },

    fromDate: {
      type: Date,
    },

    toDate: {
      type: Date,
    },

    totalDays: {
      type: Number,
      default: 0,
    },

    residents: {
      type: Number,
      default: 1,
      min: 1,
    },

    whatsappSent: {
      type: Boolean,
      default: false,
    },

    whatsappSentAt: {
      type: Date,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
      index: true,
    },

    leadOwner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    missedCalls: {
      type: Number,
      default: 0,
      min: 0,
    },

    cabService: {
      type: Boolean,
      default: false,
    },

    source: {
      type: String,
      enum: [
        "website",
        "whatsapp",
        "call",
        "facebook",
        "instagram",
        "google",
        "reference",
        "other",
      ],
      default: "other",
    },

    campaignName: {
      type: String,
      trim: true,
      default: "",
    },

    utmSource: {
      type: String,
      trim: true,
      default: "",
    },

    utmMedium: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: [
        "Incomplete information",
        "Information completed",
        "Quotation sent",
        "Negotiation",
        "Booking confirmed",
        "DNP",
        "Need B2B arrangement",
        "Not interested",
        "Disqualified",
        "Decision pending with customer",
        "Enquiry",
        "Deal lost",
      ],
      default: "Enquiry",
      index: true,
    },

    conversationSummary: {
      type: String,
      trim: true,
      default: "",
    },

    detailedConversation: {
      type: String,
      trim: true,
      default: "",
    },

    lastContactedDate: {
      type: Date,
    },

    lastFollowupDate: {
      type: Date,
    },

    nextFollowupDate: {
      type: Date,
      index: true,
    },

    nextActionItem: {
      type: String,
      trim: true,
      default: "",
    },

    mondayLead: {
      type: Boolean,
      default: false,
    },

    longBookingLead: {
      type: Boolean,
      default: false,
    },

    strategyForClosing: {
      type: String,
      trim: true,
      default: "",
    },

    // CHANGED: Converted to String to capture plain text inputted in React Native
    strategyPreparedBy: {
      type: String,
      trim: true,
      default: "",
    },

    quotationSent: {
      type: Boolean,
      default: false,
    },

    quotationSentAt: {
      type: Date,
    },

    quotationAmount: {
      type: Number,
      default: 0,
    },

    bookingConfirmedAt: {
      type: Date,
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
    },

    reasonForDealLoss: {
      type: String,
      enum: [
        "",
        "Car not available",
        "Doubtful customer",
        "No response from customer",
        "Plan changed",
        "Price high",
        "Time flexibility",
        "We didn't follow up",
      ],
      default: "",
    },

    remarksFeedback: {
      type: String,
      trim: true,
      default: "",
    },

    // CHANGED: Converted to String to capture plain text inputted in React Native
    feedbackBy: {
      type: String,
      trim: true,
      default: "",
    },

    notes: [noteSchema],

    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
    },

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// ================================
// PRE SAVE MIDDLEWARE
// ================================

leadSchema.pre("save", async function () {
  if (!this.leadId) {
    const random = Math.floor(1000 + Math.random() * 9000);
    this.leadId = `LD${Date.now()}${random}`;
  }

  if (this.fromDate && this.toDate) {
    const diff =
      new Date(this.toDate).getTime() -
      new Date(this.fromDate).getTime();

    this.totalDays = Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1);
  }

  if (this.whatsappSent && !this.whatsappSentAt) {
    this.whatsappSentAt = new Date();
  }

  if (this.quotationSent && !this.quotationSentAt) {
    this.quotationSentAt = new Date();
  }

  if (this.status === "Booking confirmed" && !this.bookingConfirmedAt) {
    this.bookingConfirmedAt = new Date();
  }
});

// ================================
// INDEXES
// ================================

leadSchema.index({
  customerName: "text",
  mobileNumber: "text",
  conversationSummary: "text",
  detailedConversation: "text",
  remarksFeedback: "text",
});

leadSchema.index({ company: 1, status: 1 });
leadSchema.index({ company: 1, priority: 1 });
leadSchema.index({ company: 1, leadOwner: 1 });
leadSchema.index({ company: 1, source: 1 });
leadSchema.index({ company: 1, createdBy: 1 });
leadSchema.index({ company: 1, leadDate: -1 });
leadSchema.index({ company: 1, createdAt: -1 });
leadSchema.index({ company: 1, nextFollowupDate: 1 });
leadSchema.index({ company: 1, lastFollowupDate: -1 });
leadSchema.index({ company: 1, isDeleted: 1 });
leadSchema.index({ company: 1, mobileNumber: 1 });
leadSchema.index({ company: 1, customerName: 1 });
leadSchema.index({ company: 1, vehicleType: 1 });
leadSchema.index({ company: 1, whatsappSent: 1 });
leadSchema.index({ company: 1, quotationSent: 1 });
leadSchema.index({ company: 1, mondayLead: 1 });
leadSchema.index({ company: 1, longBookingLead: 1 });
leadSchema.index({ company: 1, bookingConfirmedAt: -1 });
leadSchema.index({ company: 1, fromDate: 1, toDate: 1 });
leadSchema.index({ company: 1, updatedAt: -1 });

// ================================
// EXPORT
// ================================

const Lead = mongoose.model("Lead", leadSchema);

export default Lead;