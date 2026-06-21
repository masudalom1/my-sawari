import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { vehicleReturnUpload } from "../middlewares/upload.middleware.js";
import { getServiceVehicles, receiveVehicle } from "../controllers/vehicleReturn.controller.js";

const router = express.Router();

router.use(protect);

router.post("/receive/:handoverId",vehicleReturnUpload,receiveVehicle);

// menu/service
router.get("/service",protect,getServiceVehicles);

export default router;