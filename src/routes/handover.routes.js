import express from "express";


import protect from "../middlewares/auth.middleware.js";
import { handoverUpload } from "../middlewares/upload.middleware.js";
import { createHandover, deleteHandover, getAllHandovers, getSingleHandover, markVehicleReturned, updateHandover } from "../controllers/handover.controller.js";

const router = express.Router();

router.use(protect);

router.post("/create", handoverUpload, createHandover);
router.get("/all", getAllHandovers);
router.get("/:id", getSingleHandover);
router.put("/update/:id", updateHandover);
router.put("/return/:id", markVehicleReturned);
router.delete("/delete/:id", deleteHandover);

export default router;
