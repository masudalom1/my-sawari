import express from "express";
import protect from "../middlewares/auth.middleware.js";
import restrictTo from "../middlewares/restrictTo.middleware.js";
import { PAYMENT_REPORT_ADMIN_ROLES } from "../../shared/paymentReportAccess.mjs";
import { getPaymentReport, getPaymentReportDetail, getPaymentReportExport, getPaymentReportSummary } from "../controllers/paymentReport.controller.js";
import { collectCashPayment, collectPhonePePayment, getCashCollectionPayments, getPaymentHistory, getPhonePeCollectionPayments } from "../controllers/paymentHistory.controller.js";

const router = express.Router();

const reportAdmin = restrictTo(...PAYMENT_REPORT_ADMIN_ROLES);
router.get("/report", protect, reportAdmin, getPaymentReport);
router.get("/report/export", protect, reportAdmin, getPaymentReportExport);
router.get("/report/summary", protect, reportAdmin, getPaymentReportSummary);
router.get("/report/:id", protect, reportAdmin, getPaymentReportDetail);

router.get("/", protect, getPaymentHistory);
router.post("/:id/collect-cash", protect, collectCashPayment);
router.get("/pending",protect,getCashCollectionPayments);

router.get("/phonepe/pending", protect, getPhonePeCollectionPayments);
router.post("/:paymentId/collect-phonepe", protect, collectPhonePePayment);
router.get("/:id", protect, reportAdmin, getPaymentReportDetail);

export default router;
