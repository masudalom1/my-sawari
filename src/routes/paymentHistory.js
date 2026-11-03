import express from "express";
import protect from "../middlewares/auth.middleware.js"; 
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { getPaymentsHistory } from "../controllers/paymentHistory.js";
import { collectCashPayment, getCashCollectionPayments } from "../controllers/paymentHistory.controller.js";
import { getUpiVerification, verifyUpiPayment } from "../controllers/upiVerification.controller.js";


const router = express.Router();

router.get("/", protect, requirePermission(PERMISSIONS.paymentsHistory.view), getPaymentsHistory);
router.get("/cash", protect, requirePermission(PERMISSIONS.pendingToCollect.view), getCashCollectionPayments);
router.post("/cash/:id/collect", protect, requirePermission(PERMISSIONS.pendingToCollect.collect), collectCashPayment);
router.get("/upi", protect, requirePermission(PERMISSIONS.verifyUpiCollections.view), getUpiVerification);
router.post("/upi/:id/verify", protect, requirePermission(PERMISSIONS.verifyUpiCollections.verify), verifyUpiPayment);

export default router;
