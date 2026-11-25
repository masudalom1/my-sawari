import express from "express";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { refundAttachmentUpload } from "../middlewares/upload.middleware.js";
import {
  approveRefundRequest,
  createManualRefundRequest,
  getBookingRefundBalance,
  getRefundRequestOptions,
  getRefundRequests,
  getRefundRequest,
  getRefundAttachment,
  uploadRefundAttachment,
  markRefundRequestPaid,
  rejectRefundRequest,
} from "../controllers/refundRequest.controller.js";

const router = express.Router();
router.use(protect, requirePermission(PERMISSIONS.paymentsHistory.view));
router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });

router.post("/attachments", requirePermission(PERMISSIONS.dashboard.edit),
  requirePermission([PERMISSIONS.bookings.create, PERMISSIONS.bookings.edit]),
  refundAttachmentUpload.single("image"), uploadRefundAttachment);
router.get("/:id/attachments/:kind", getRefundAttachment);

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
router.get("/:id", getRefundRequest);
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
