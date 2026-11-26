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
import {
  createDownloadLink,
  createTemplate,
  deleteTemplate,
  listTemplates,
  renderQrCard,
  setQrTemplate,
  updateTemplate,
} from "../controllers/qrTemplate.controller.js";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { qrTemplateUpload } from "../middlewares/qrTemplateUpload.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";

const router = express.Router();
router.get("/qr-codes", protect, requirePermission(PERMISSIONS.qrCodes.view), listCodes);
router.post("/qr-codes/bulk", protect, requirePermission(PERMISSIONS.qrCodes.create), bulkCreate);

// Templates library (view/download vs create/manage under qrCodes permissions)
router.get("/templates", protect, requirePermission(PERMISSIONS.qrCodes.view), listTemplates);
router.post("/templates", protect, requirePermission(PERMISSIONS.qrCodes.create), qrTemplateUpload, createTemplate);
router.patch("/templates/:id", protect, requirePermission(PERMISSIONS.qrCodes.create), qrTemplateUpload, updateTemplate);
router.delete("/templates/:id", protect, requirePermission(PERMISSIONS.qrCodes.create), deleteTemplate);

// Signed download URL (?dt=...) OR authenticated qrCodes.view permission verified inside renderQrCard
router.get("/qr-codes/:code/card.png", renderQrCard);
router.post("/qr-codes/:code/download-link", protect, requirePermission(PERMISSIONS.qrCodes.view), createDownloadLink);
router.patch("/qr-codes/:code/template", protect, requirePermission(PERMISSIONS.qrCodes.create), setQrTemplate);

router.get("/qr-codes/:code", getByCode);
router.post("/qr-codes/:code/claim", claimCode);

// Customer assignment by admin
router.get("/customers/search", protect, requirePermission(PERMISSIONS.qrCodes.view), searchCustomers);
router.post("/qr-codes/:code/assign", protect, requirePermission(PERMISSIONS.qrCodes.create), assignCode);
router.post("/qr-codes/:code/unassign", protect, requirePermission(PERMISSIONS.qrCodes.create), unassignCode);
router.post("/qr-codes/:code/revoke", protect, requirePermission(PERMISSIONS.qrCodes.create), revokeCode);

export default router;