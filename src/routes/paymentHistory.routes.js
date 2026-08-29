import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { collectCashPayment, collectPhonePePayment, getCashCollectionPayments, getPaymentHistory, getPhonePeCollectionPayments } from "../controllers/paymentHistory.controller.js";

const router = express.Router();

router.get("/", protect, getPaymentHistory);
router.post("/:id/collect-cash", protect, collectCashPayment);
router.get("/pending",protect,getCashCollectionPayments);

router.get("/phonepe/pending", protect, getPhonePeCollectionPayments);
router.post("/:paymentId/collect-phonepe", protect, collectPhonePePayment);

export default router;