import express from "express";
import protect from "../middlewares/auth.middleware.js";

import {
  createLead,
  getLeadById,
  getLeadDashboardStats,
  getLeadHistory,
  getLeads,
  updateLead,
} from "../controllers/lead.controller.js";

const router = express.Router();

router.get("/dashboard", protect, getLeadDashboardStats);
router.get("/", protect, getLeads);
router.post("/", protect, createLead);
router.get("/:id", protect, getLeadById);
router.put("/:id", protect, updateLead);

router.get("/:id/history", protect, getLeadHistory);
export default router;
