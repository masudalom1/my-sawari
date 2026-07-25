import express from "express";

import protect from "../middlewares/auth.middleware.js"; // adjust to your actual auth middleware
import { getBookingById, getBookingDetails } from "../controllers/bookingController.js";

const router = express.Router();

router.get("/:id/details", protect, getBookingDetails);
router.get("/:id", protect, getBookingById);

export default router;