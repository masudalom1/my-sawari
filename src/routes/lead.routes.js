import express from "express";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";

import {
  cancelBooking,
  checkLeadByMobile,
  createBookings,
  createLead,
  createLeadBooking,
  getBookingDetails,
  getBookingsDashboard,
  getAppInstalls,
  getAppUserDetail,
  getLeadBookingDetails,
  getLeadBookings,
  getLeadById,
  getLeadDashboardStats,
  getLeadHistory,
  getLeads,
  updateBooking,
  updateLead,
} from "../controllers/lead.controller.js";
import { createLeadActivity, getLeadActivities } from "../controllers/leadActivity.controller.js";

const router = express.Router();

router.get("/dashboard", protect, requirePermission(PERMISSIONS.bookings.view), getLeadDashboardStats);
router.get("/booking", protect, requirePermission(PERMISSIONS.bookings.view), getBookingsDashboard);
router.get("/", protect, requirePermission(PERMISSIONS.bookings.view), getLeads);
router.post("/", protect, requirePermission(PERMISSIONS.bookings.create), createLead);
router.get("/app-installs", protect, requirePermission(PERMISSIONS.appUsers.view), getAppInstalls);
router.get("/app-installs/:id", protect, requirePermission(PERMISSIONS.appUsers.view), getAppUserDetail);
router.get("/:id", protect, requirePermission(PERMISSIONS.bookings.view), getLeadById);
router.put("/:id", protect, requirePermission(PERMISSIONS.bookings.edit), updateLead);

router.get("/:id/history", protect, requirePermission(PERMISSIONS.bookings.view), getLeadHistory);

router.post("/:id/activity", protect, requirePermission(PERMISSIONS.bookings.edit), createLeadActivity);
router.get("/:id/activity", protect, requirePermission(PERMISSIONS.bookings.view), getLeadActivities);

router.get("/check/:mobile",protect,requirePermission(PERMISSIONS.bookings.create),checkLeadByMobile);

router.put("/:id/create-booking",protect,requirePermission(PERMISSIONS.bookings.create),createLeadBooking);
router.get("/:id/create-booking",protect,requirePermission(PERMISSIONS.bookings.view),getLeadBookingDetails);
router.get("/:id/bookings",protect,requirePermission(PERMISSIONS.bookings.view),getLeadBookings);
router.post("/create",protect,requirePermission(PERMISSIONS.bookings.create),createBookings);
router.get("/booking-details/:id", protect, requirePermission(PERMISSIONS.bookings.view), getBookingDetails);
router.put("/booking-update/:id", protect, requirePermission(PERMISSIONS.bookings.edit), updateBooking);
router.put("/:id/cancel", protect, requirePermission(PERMISSIONS.bookings.edit), cancelBooking);

export default router;
