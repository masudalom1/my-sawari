import express from "express";

import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
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
const tenantCacheKey = (req) => `${req.user?._id}:${req.originalUrl}`;
const untilChanged = cacheResponse({ maxAgeMs: DATA_ONLY_MS, cacheKey: tenantCacheKey });
const timeDependent = cacheResponse({ maxAgeMs: TIME_DEPENDENT_MS, cacheKey: tenantCacheKey });
const timeline = cacheResponse({
  maxAgeMs: (req) =>
    req.query.scope === "range" ? DATA_ONLY_MS : TIME_DEPENDENT_MS,
  cacheKey: tenantCacheKey,
});


const router = express.Router();

router.get("/import", protect, requirePermission(PERMISSIONS.dashboard.view), untilChanged, getVehiclesForImport);
router.get("/bookings/import", protect, requirePermission(PERMISSIONS.dashboard.view), untilChanged, getBookingsForImport);
router.get("/bookings/timeline", protect, requirePermission(PERMISSIONS.dashboard.view), timeline, getTimelineBookings); // fast: live / range
router.get("/payments/import", protect, requirePermission(PERMISSIONS.revenue.view), getPaymentsForImport);
router.post("/maintenance", protect, requirePermission(PERMISSIONS.dashboard.create), createMaintenance);
router.get("/maintenance", protect, requirePermission(PERMISSIONS.dashboard.view), getMaintenances);
router.get("/maintenance/timeline", protect, requirePermission(PERMISSIONS.dashboard.view), untilChanged, getTimelineMaintenances); // fast: no populate
router.get("/stats", protect, requirePermission(PERMISSIONS.dashboard.view), timeDependent, getDashboardStats);
router.get("/revenue/vehicles", protect, requirePermission(PERMISSIONS.vehicleRevenue.view), getVehicleRevenue);
router.get("/bookingrevenue", protect, requirePermission(PERMISSIONS.revenue.view), getBookingDashboardRevenue);
router.get("/payments/booking", protect, requirePermission(PERMISSIONS.bookings.view), untilChanged, getBookingPayments);

export default router;