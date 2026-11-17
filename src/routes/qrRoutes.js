import express from "express";
import {
  assignCode,
  bulkCreate,
  claimCode,
  getByCode,
  listCodes,
  revokeCode,
  searchCustomers,
  unassignCode,
} from "../controllers/qrController.js";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";

const router = express.Router();
router.get("/qr-codes", protect, requirePermission(PERMISSIONS.qrCodes.view), listCodes);
router.post("/qr-codes/bulk", protect, requirePermission(PERMISSIONS.qrCodes.create), bulkCreate);
router.get("/qr-codes/:code", getByCode);
router.post("/qr-codes/:code/claim", claimCode);

// Customer assignment by admin
router.get("/customers/search", protect, requirePermission(PERMISSIONS.qrCodes.view), searchCustomers);
router.post("/qr-codes/:code/assign", protect, requirePermission(PERMISSIONS.qrCodes.create), assignCode);
router.post("/qr-codes/:code/unassign", protect, requirePermission(PERMISSIONS.qrCodes.create), unassignCode);
router.post("/qr-codes/:code/revoke", protect, requirePermission(PERMISSIONS.qrCodes.create), revokeCode);

export default router;