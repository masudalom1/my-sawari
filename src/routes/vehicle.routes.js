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
} from "../controllers/vehicle.controller.js";

import protect from "../middlewares/auth.middleware.js";
import vehicleUpload from "../middlewares/vehicleUpload.js";
const router = express.Router();

router.use(protect);


router.post("/create", vehicleUpload.array("images", 5), createVehicle);

router.get("/all", getAllVehicles);

// Showing Available car in handover screen
router.get("/available", protect, getAvailableVehicles);
router.get("/getAll", protect, getAll);

// Maintenance 
router.post("/create-maintenance", createMaintenance);
 




// NOT IN USED
router.get("/:id", getSingleVehicle);

router.put("/update/:id", upload.array("images", 5), updateVehicle);

router.patch("/status/:id", updateVehicleStatus);

router.delete("/delete/:id", deleteVehicle);

export default router;
