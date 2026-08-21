import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { collectCashPayment, getPaymentHistory } from "../controllers/paymentHistory.controller.js";

const router = express.Router();

router.get("/", protect, getPaymentHistory);
router.post("/:id/collect-cash", protect, collectCashPayment);

export default router;