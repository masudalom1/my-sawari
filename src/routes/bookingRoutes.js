import express from "express";

import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import {
  getBookingById,
  getBookingVehicles,
  getBookingDetails,
  getDrivers,
  assignDriver,
  assignDriverHandover,
} from "../controllers/bookingController.js";

const router = express.Router();
router.get("/vehicles", protect, requirePermission(PERMISSIONS.bookings.create), getBookingVehicles);

router.get("/drivers", protect, requirePermission(PERMISSIONS.bookings.view), getDrivers);

router.put("/:id/assign-driver", protect, requirePermission(PERMISSIONS.bookings.edit), assignDriver);
router.put("/:id/assign-driver-handover", protect, requirePermission(PERMISSIONS.bookings.edit), assignDriverHandover);

router.get("/:id/details", protect, requirePermission(PERMISSIONS.bookings.view), getBookingDetails);

router.get("/:id", protect, requirePermission(PERMISSIONS.bookings.view), getBookingById);

export default router;
