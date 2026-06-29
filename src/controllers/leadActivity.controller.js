// controllers/leadActivity.controller.js

import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import LeadActivity from "../models/leadActivity.model.js";
import LeadHistory from "../models/leadHistory.model.js";

export const createLeadActivity = async (req, res) => {
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

    const {
      contactType,
      direction,
      duration,
      conversation,
      outcome,
      followUpRequired,
      nextFollowUpDate,
      leadStatusAfterContact,
    } = req.body;

    const activity = await LeadActivity.create({
      lead: lead._id,
      company: companyId,
      contactType,
      direction,
      duration,
      conversation,
      outcome,
      followUpRequired,
      nextFollowUpDate,
      leadStatusAfterContact,
      createdBy: req.user._id,
    });

    const history = [];

    const createHistory = (field, oldValue, newValue) => {
      if (String(oldValue ?? "") === String(newValue ?? "")) return;

      history.push({
        lead: lead._id,
        company: companyId,
        field,
        oldValue,
        newValue,
        changedBy: req.user._id,
        action: "updated",
      });
    };

    createHistory(
      "conversationSummary",
      lead.conversationSummary,
      conversation
    );

    createHistory(
      "nextFollowupDate",
      lead.nextFollowupDate,
      nextFollowUpDate
    );

    createHistory(
      "status",
      lead.status,
      leadStatusAfterContact
    );

    lead.conversationSummary = conversation;
    lead.lastContactedDate = new Date();

    if (followUpRequired) {
      lead.lastFollowupDate = new Date();
      lead.nextFollowupDate = nextFollowUpDate;
    }

    if (leadStatusAfterContact) {
      lead.status = leadStatusAfterContact;
    }

    await lead.save();

    if (history.length) {
      await LeadHistory.insertMany(history);
    }

    const data = await LeadActivity.findById(activity._id)
      .populate("createdBy", "name email");

    return res.status(201).json({
      success: true,
      message: "Activity added successfully.",
      data,
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: "Unable to save activity.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};

export const getLeadActivities = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lead id",
      });
    }

    const companyId = req.user.company || req.user._id;

    const activities = await LeadActivity.find({
      lead: id,
      company: companyId,
    })
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: activities,
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch activities.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};