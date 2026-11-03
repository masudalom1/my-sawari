import express from "express";
import protect from "../middlewares/auth.middleware.js";
import restrictTo from "../middlewares/restrictTo.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { PAYMENT_REPORT_ADMIN_ROLES } from "../../shared/paymentReportAccess.mjs";
import { getPaymentReport, getPaymentReportDetail, getPaymentReportExport, getPaymentReportSummary } from "../controllers/paymentReport.controller.js";
import { collectCashPayment, collectPhonePePayment, getCashCollectionPayments, getPaymentHistory, getPhonePeCollectionPayments } from "../controllers/paymentHistory.controller.js";

const router = express.Router();

const reportAdmin = restrictTo(...PAYMENT_REPORT_ADMIN_ROLES);
router.get("/report", protect, reportAdmin, requirePermission(PERMISSIONS.paymentsHistory.view), getPaymentReport);
router.get("/report/export", protect, reportAdmin, requirePermission(PERMISSIONS.paymentsHistory.export), getPaymentReportExport);
router.get("/report/summary", protect, reportAdmin, requirePermission(PERMISSIONS.paymentsHistory.view), getPaymentReportSummary);
router.get("/report/:id", protect, reportAdmin, requirePermission(PERMISSIONS.paymentsHistory.view), getPaymentReportDetail);

router.get("/", protect, requirePermission(PERMISSIONS.paymentsHistory.view), getPaymentHistory);
router.post("/:id/collect-cash", protect, requirePermission(PERMISSIONS.pendingToCollect.collect), collectCashPayment);
router.get("/pending",protect,requirePermission(PERMISSIONS.pendingToCollect.view),getCashCollectionPayments);

router.get("/phonepe/pending", protect, requirePermission(PERMISSIONS.pendingToCollect.view), getPhonePeCollectionPayments);
router.post("/:paymentId/collect-phonepe", protect, requirePermission(PERMISSIONS.pendingToCollect.collect), collectPhonePePayment);
router.get("/:id", protect, reportAdmin, requirePermission(PERMISSIONS.paymentsHistory.view), getPaymentReportDetail);

export default router;
