import express from "express";
import protect from "../middlewares/auth.middleware.js";

import {
  createLead,
  getLeadById,
  getLeadDashboardStats,
  getLeads,
} from "../controllers/lead.controller.js";

const router = express.Router();

router.get("/dashboard", protect, getLeadDashboardStats);
router.get("/", protect, getLeads);
router.post("/", protect, createLead);
router.get("/:id", protect, getLeadById);

export default router;
