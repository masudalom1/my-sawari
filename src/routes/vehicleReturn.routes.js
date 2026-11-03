import express from "express";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { vehicleReturnUpload } from "../middlewares/upload.middleware.js";
import { getReturnDetails, getServiceVehicles, getVehicleReturnsDashboard, markVehicleAvailable, receiveVehicle } from "../controllers/vehicleReturn.controller.js";

const router = express.Router();

router.use(protect);

router.post("/receive/:handoverId",requirePermission(PERMISSIONS.bookings.edit),vehicleReturnUpload,receiveVehicle);
router.get("/details/:handoverId", requirePermission(PERMISSIONS.bookings.view), getReturnDetails);
router.get("/dashboard",protect,requirePermission(PERMISSIONS.dashboard.view),getVehicleReturnsDashboard);

// menu/service
router.get("/service",protect,requirePermission(PERMISSIONS.dashboard.view),getServiceVehicles);
router.put("/service/complete/:id",protect,requirePermission(PERMISSIONS.dashboard.edit),markVehicleAvailable);

export default router;