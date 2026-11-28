import express from "express";
import {
  assignCode,
  bulkCreate,
  claimCode,
  createTemplate,
  deleteTemplate,
  getByCode,
  listCodes,
  listTemplates,
  revokeCode,
  searchCustomers,
  setDefaultTemplate,
  unassignCode,
  updateTemplate,
} from "../controllers/qrController.js";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";

const router = express.Router();

// NEW: templates carry uploaded images, so they need a bigger body limit than the default 100 KB
const templateJson = express.json({ limit: "8mb" });

router.get("/qr-codes", protect, requirePermission(PERMISSIONS.qrCodes.view), listCodes);
router.post("/qr-codes/bulk", protect, requirePermission(PERMISSIONS.qrCodes.create), bulkCreate);
router.get("/qr-codes/:code", getByCode);
router.post("/qr-codes/:code/claim", claimCode);

// Customer assignment by admin
router.get("/customers/search", protect, requirePermission(PERMISSIONS.qrCodes.view), searchCustomers);
router.post("/qr-codes/:code/assign", protect, requirePermission(PERMISSIONS.qrCodes.create), assignCode);
router.post("/qr-codes/:code/unassign", protect, requirePermission(PERMISSIONS.qrCodes.create), unassignCode);
router.post("/qr-codes/:code/revoke", protect, requirePermission(PERMISSIONS.qrCodes.create), revokeCode);

// NEW: QR card templates (view = qrCodes.view, change = qrCodes.create)
router.get("/templates", protect, requirePermission(PERMISSIONS.qrCodes.view), listTemplates);
router.post("/templates", protect, requirePermission(PERMISSIONS.qrCodes.create), templateJson, createTemplate);
router.put("/templates/:id", protect, requirePermission(PERMISSIONS.qrCodes.create), templateJson, updateTemplate);
router.patch("/templates/:id/default", protect, requirePermission(PERMISSIONS.qrCodes.create), setDefaultTemplate);
router.delete("/templates/:id", protect, requirePermission(PERMISSIONS.qrCodes.create), deleteTemplate);

export default router;