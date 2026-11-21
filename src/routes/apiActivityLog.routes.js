import express from "express";
import authMiddleware from "../middlewares/auth.middleware.js";
import restrictTo from "../middlewares/restrictTo.middleware.js";
import { getApiActivityLogs } from "../controllers/apiActivityLog.controller.js";

const router = express.Router();

router.get("/", authMiddleware, restrictTo("SUPER_ADMIN"), getApiActivityLogs);

export default router;
