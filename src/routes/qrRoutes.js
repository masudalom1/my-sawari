import express from "express";
import { bulkCreate, claimCode, getByCode, listCodes } from "../controllers/qrController.js";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";


const router = express.Router();
router.get("/qr-codes", protect, requirePermission(PERMISSIONS.qrCodes.view), listCodes);
router.post("/qr-codes/bulk", protect, requirePermission(PERMISSIONS.qrCodes.create), bulkCreate);
router.get("/qr-codes/:code", getByCode);
router.post("/qr-codes/:code/claim", claimCode);

export default router;