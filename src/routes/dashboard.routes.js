import express from "express";

import protect from "../middlewares/auth.middleware.js";
import {
  createMaintenance,
  getBookingDashboardRevenue,
  getBookingPayments,
  getBookingsForImport,
  getDashboardStats,
  getMaintenances,
  getPaymentsForImport,
  getTimelineBookings,
  getTimelineMaintenances,
  getVehicleRevenue,
  getVehiclesForImport,
} from "../controllers/dashboard.controller.js";
import { cacheResponse } from "../realtime/responseCache.js";

// Reused only until the data changes (see realtime/responseCache.js).
// Time-dependent results ("on rent now", the live window) also expire after
// 30 s, the old polling interval; the rest after 5 min as a safety net.
const TIME_DEPENDENT_MS = 30_000;
const DATA_ONLY_MS = 5 * 60_000;
const untilChanged = cacheResponse({ maxAgeMs: DATA_ONLY_MS });
const timeDependent = cacheResponse({ maxAgeMs: TIME_DEPENDENT_MS });
const timeline = cacheResponse({
  maxAgeMs: (req) =>
    req.query.scope === "range" ? DATA_ONLY_MS : TIME_DEPENDENT_MS,
});


const router = express.Router();

router.get("/import", untilChanged, getVehiclesForImport);
router.get("/bookings/import", untilChanged, getBookingsForImport);
router.get("/bookings/timeline", timeline, getTimelineBookings); // fast: live / range
router.get("/payments/import", getPaymentsForImport);
router.post("/maintenance", protect, createMaintenance);
router.get("/maintenance", getMaintenances);
router.get("/maintenance/timeline", untilChanged, getTimelineMaintenances); // fast: no populate
router.get("/stats", timeDependent, getDashboardStats);
router.get("/revenue/vehicles", getVehicleRevenue);
router.get("/bookingrevenue", protect, getBookingDashboardRevenue);
router.get("/payments/booking", untilChanged, getBookingPayments);

export default router;