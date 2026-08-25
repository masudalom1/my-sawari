import express from "express";

import protect from "../middlewares/auth.middleware.js"
import { createMaintenance, getBookingsForImport, getVehiclesForImport } from "../controllers/dashboard.controller.js";

const router = express.Router();

router.get("/import",getVehiclesForImport);
router.get("/bookings/import", getBookingsForImport);
router.post("/maintenance", createMaintenance);

export default router;