import express from "express";
import upload from "../config/multer.js";
import {
  createVehicle,
  getAllVehicles,
  getSingleVehicle,
  updateVehicle,
  deleteVehicle,
  updateVehicleStatus,
} from "../controllers/vehicle.controller.js";

import protect from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.post("/create", upload.array("images", 5), createVehicle);

router.get("/all", getAllVehicles);

router.get("/:id", getSingleVehicle);

router.put("/update/:id", upload.array("images", 5), updateVehicle);

router.patch("/status/:id", updateVehicleStatus);

router.delete("/delete/:id", deleteVehicle);

export default router;
