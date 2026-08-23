import express from "express";

import protect from "../middlewares/auth.middleware.js"
import { getBookingsForImport, getVehiclesForImport } from "../controllers/dashboard.controller.js";

const router = express.Router();

router.get("/import",getVehiclesForImport);
router.get("/bookings/import", getBookingsForImport);

export default router;