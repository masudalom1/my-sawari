import express from "express";
import protect from "../middlewares/auth.middleware.js";

import {
  createLead,
  deleteLead,
  getLeadById,
  getLeadDashboardStats,
  getLeads,
  updateLead,
} from "../controllers/lead.controller.js";

const router = express.Router();

// Dashboard
router.get("/dashboard", protect, getLeadDashboardStats);

// All Leads
router.get("/", protect, getLeads);

// Create Lead
router.post("/", protect, createLead);

// Get Single Lead
router.get("/:id", protect, getLeadById);

// Update Lead
router.put("/:id", protect, updateLead);

// Delete Lead
router.delete("/:id", protect, deleteLead);

export default router;