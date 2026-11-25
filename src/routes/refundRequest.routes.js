import express from "express";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import {
  approveRefundRequest,
  createManualRefundRequest,
  getBookingRefundBalance,
  getRefundRequestOptions,
  getRefundRequests,
  markRefundRequestPaid,
  rejectRefundRequest,
} from "../controllers/refundRequest.controller.js";

const router = express.Router();

router.get(
  "/",
  protect,
  requirePermission(PERMISSIONS.paymentsHistory.view),
  getRefundRequests,
);
router.get(
  "/options",
  protect,
  requirePermission(PERMISSIONS.bookings.create),
  getRefundRequestOptions,
);
router.get(
  "/balance/:bookingId",
  protect,
  requirePermission(PERMISSIONS.bookings.create),
  getBookingRefundBalance,
);
router.post(
  "/",
  protect,
  requirePermission(PERMISSIONS.bookings.create),
  createManualRefundRequest,
);
router.patch(
  "/:id/approve",
  protect,
  requirePermission(PERMISSIONS.bookings.edit),
  approveRefundRequest,
);
router.patch(
  "/:id/reject",
  protect,
  requirePermission(PERMISSIONS.bookings.edit),
  rejectRefundRequest,
);
router.patch(
  "/:id/refunded",
  protect,
  requirePermission(PERMISSIONS.bookings.edit),
  requirePermission(PERMISSIONS.dashboard.edit),
  markRefundRequestPaid,
);

export default router;
