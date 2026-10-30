import express from "express";
import protect from "../middlewares/auth.middleware.js"; 
import { getPaymentsHistory } from "../controllers/paymentHistory.js";
import { collectCashPayment, getCashCollectionPayments } from "../controllers/paymentHistory.controller.js";
import { getUpiVerification, verifyUpiPayment } from "../controllers/upiVerification.controller.js";


const router = express.Router();

router.get("/", protect, getPaymentsHistory);
router.get("/cash", protect, getCashCollectionPayments);
router.post("/cash/:id/collect", protect, collectCashPayment);
router.get("/upi", protect, getUpiVerification);
router.post("/upi/:id/verify", protect, verifyUpiPayment);

export default router;
