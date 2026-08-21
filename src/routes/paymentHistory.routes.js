import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { collectCashPayment, getCashCollectionPayments, getPaymentHistory } from "../controllers/paymentHistory.controller.js";

const router = express.Router();

router.get("/", protect, getPaymentHistory);
router.post("/:id/collect-cash", protect, collectCashPayment);
router.get("/pending",protect,getCashCollectionPayments);

export default router;