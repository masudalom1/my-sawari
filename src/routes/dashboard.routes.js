import express from "express";

import protect from "../middlewares/auth.middleware.js"
import { createMaintenance, getBookingsForImport, getMaintenances, getPaymentsForImport, getVehiclesForImport } from "../controllers/dashboard.controller.js";

const router = express.Router();

router.get("/import",getVehiclesForImport);
router.get("/bookings/import", getBookingsForImport);
router.get("/payments/import", getPaymentsForImport);
router.post("/maintenance", createMaintenance);
router.get("/maintenance", getMaintenances);

export default router;