import express from "express";

import protect from "../middlewares/auth.middleware.js"
import { getVehiclesForImport } from "../controllers/dashboard.controller.js";

const router = express.Router();

router.get("/import", protect, getVehiclesForImport);

export default router;