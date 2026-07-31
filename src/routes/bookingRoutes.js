import express from "express";

import protect from "../middlewares/auth.middleware.js";
import {
  getBookingById,
  getBookingDetails,
  getDrivers,
  assignDriver,
  assignDriverHandover,
} from "../controllers/bookingController.js";

const router = express.Router();

router.get("/drivers", protect, getDrivers);

router.put("/:id/assign-driver", protect, assignDriver);
router.put("/:id/assign-driver-handover", protect, assignDriverHandover);

router.get("/:id/details", protect, getBookingDetails);

router.get("/:id", protect, getBookingById);

export default router;