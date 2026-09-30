import express from "express";

import protect from "../middlewares/auth.middleware.js"
import { createMaintenance, getBookingDashboard, getBookingsForImport, getDashboardStats, getMaintenances, getPaymentsForImport, getVehicleRevenue, getVehiclesForImport } from "../controllers/dashboard.controller.js";
import { getBookingsDashboard } from "../controllers/lead.controller.js";

const router = express.Router();

router.get("/import",getVehiclesForImport);
router.get("/bookings/import", getBookingsForImport);
router.get("/payments/import", getPaymentsForImport);
router.post("/maintenance", createMaintenance);
router.get("/maintenance", getMaintenances);
router.get("/stats", getDashboardStats);
router.get("/revenue/vehicles", getVehicleRevenue);
router.get("/bookingrevenue", protect, getBookingsDashboard);

export default router;