import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { vehicleReturnUpload } from "../middlewares/upload.middleware.js";
import { getReturnDetails, getServiceVehicles, markVehicleAvailable, receiveVehicle } from "../controllers/vehicleReturn.controller.js";

const router = express.Router();

router.use(protect);

router.post("/receive/:handoverId",vehicleReturnUpload,receiveVehicle);
router.get("/details/:handoverId", getReturnDetails);

// menu/service
router.get("/service",protect,getServiceVehicles);
router.put("/service/complete/:id",protect,markVehicleAvailable);

export default router;