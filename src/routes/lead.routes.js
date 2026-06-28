import express from "express";

import protect from "../middlewares/auth.middleware.js";
import { createLead, deleteLead, getLeadById, getLeadDashboardStats, getLeads, updateLead } from "../controllers/lead.controller.js";


const router = express.Router();

router.post("/", protect, createLead);

router.get("/:id", protect, getLeadById);

// Update Lead
router.put("/:id", protect, updateLead);

// Delete Lead (Soft Delete)
router.delete("/:id", protect, deleteLead);
router.get("/dashboard", getLeadDashboardStats);

// Lead List
router.get("/",getLeads);

export default router;