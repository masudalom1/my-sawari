import express from "express";
import upload from "../config/multer.js";
import {
  createVehicle,
  getAllVehicles,
  getFleetManagerVehicles,
  getSingleVehicle,
  updateVehicle,
  deleteVehicle,
  deactivateVehicle,
  getReactivationOptions,
  reactivateVehicle,
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

router.get("/fleet-manager", requirePermission(PERMISSIONS.vehicleManager.view), getFleetManagerVehicles);
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




// Fleet Manager Edit reads the saved vehicle, so Edit alone is enough to load it.
router.get("/:id", requirePermission([PERMISSIONS.dashboard.view, PERMISSIONS.dashboard.edit]), getSingleVehicle);

// Fleet Manager Edit. Photos are stored on Cloudinary, like Add Vehicle's.
router.put("/update/:id", requirePermission(PERMISSIONS.dashboard.edit), vehicleUpload.array("images", 5), updateVehicle);

// Fleet Manager Deactivate: unavailable for bookings from an effective date.
router.patch("/deactivate/:id", requirePermission(PERMISSIONS.dashboard.deactivate), deactivateVehicle);

// Fleet Manager Reactivate (same permission): eligibility and statuses, then the change.
router.get("/reactivation/:id", requirePermission(PERMISSIONS.dashboard.deactivate), getReactivationOptions);
router.patch("/reactivate/:id", requirePermission(PERMISSIONS.dashboard.deactivate), reactivateVehicle);

// NOT IN USED

router.patch("/status/:id", requirePermission(PERMISSIONS.dashboard.edit), updateVehicleStatus);

router.delete("/delete/:id", requirePermission(PERMISSIONS.dashboard.delete), deleteVehicle);

export default router;
