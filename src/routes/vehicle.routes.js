import express from "express";
import upload from "../config/multer.js";
import {
  createVehicle,
  getAllVehicles,
  getSingleVehicle,
  updateVehicle,
  deleteVehicle,
  updateVehicleStatus,
  getAvailableVehicles,
  getAll,
  createMaintenance,
  getMaintenances,
  getMaintenanceById,
  updateMaintenance,
  updateMaintenanceStatus,
  uploadMaintenanceImage,
} from "../controllers/vehicle.controller.js";

import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import vehicleUpload from "../middlewares/vehicleUpload.js";

const router = express.Router();

router.use(protect);


router.post("/create", requirePermission(PERMISSIONS.dashboard.create), vehicleUpload.array("images", 5), createVehicle);

router.get("/all", requirePermission(PERMISSIONS.dashboard.view), getAllVehicles);

// Showing Available car in handover screen
router.get("/available", protect, requirePermission(PERMISSIONS.bookings.view), getAvailableVehicles);
router.get("/getAll", protect, requirePermission(PERMISSIONS.dashboard.view), getAll);

// Maintenance 
router.post("/create-maintenance", requirePermission(PERMISSIONS.dashboard.create), createMaintenance);
router.post("/upload-maintenance-image",protect,requirePermission(PERMISSIONS.dashboard.edit),upload.single("image"),uploadMaintenanceImage,);
router.get("/list-maintenance", protect, requirePermission(PERMISSIONS.dashboard.view), getMaintenances);
router.get("/maintenance/:id", protect, requirePermission(PERMISSIONS.dashboard.view), getMaintenanceById);
router.patch("/maintenance/:id", protect, requirePermission(PERMISSIONS.dashboard.edit), updateMaintenance);
router.patch("/maintenance/:id/status", protect, requirePermission(PERMISSIONS.dashboard.edit), updateMaintenanceStatus);




// NOT IN USED
router.get("/:id", requirePermission(PERMISSIONS.dashboard.view), getSingleVehicle);

router.put("/update/:id", requirePermission(PERMISSIONS.dashboard.edit), upload.array("images", 5), updateVehicle);

router.patch("/status/:id", requirePermission(PERMISSIONS.dashboard.edit), updateVehicleStatus);

router.delete("/delete/:id", requirePermission(PERMISSIONS.dashboard.delete), deleteVehicle);

export default router;
