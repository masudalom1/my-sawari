import express from "express";
import protect from "../middlewares/auth.middleware.js";

import {
  checkLeadByMobile,
  createLead,
  createLeadBooking,
  getBookingsDashboard,
  getLeadBookingDetails,
  getLeadById,
  getLeadDashboardStats,
  getLeadHistory,
  getLeads,
  updateLead,
} from "../controllers/lead.controller.js";
import { createLeadActivity, getLeadActivities } from "../controllers/leadActivity.controller.js";

const router = express.Router();

router.get("/dashboard", protect, getLeadDashboardStats);
router.get("/booking", getBookingsDashboard);
router.get("/", protect, getLeads);
router.post("/", protect, createLead);
router.get("/:id", protect, getLeadById);
router.put("/:id", protect, updateLead);

router.get("/:id/history", protect, getLeadHistory);

router.post("/:id/activity", protect, createLeadActivity);
router.get("/:id/activity", protect, getLeadActivities);

router.get("/check/:mobile",protect,checkLeadByMobile);

router.put("/:id/create-booking",protect,createLeadBooking);
router.get("/:id/create-booking",protect,getLeadBookingDetails);

export default router;
