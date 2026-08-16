import express from "express";
import protect from "../middlewares/auth.middleware.js";
import getPaymentHistory from "../controllers/paymentHistory.controller.js";

const router = express.Router();

router.get("/", protect, getPaymentHistory);

export default router;