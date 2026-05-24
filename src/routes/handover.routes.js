import express from "express";

import protect from "../middlewares/auth.middleware.js";
import { handoverUpload } from "../middlewares/upload.middleware.js";
import {
  createHandover,
  deleteHandover,
  getActiveHandovers,
  getAllHandovers,
  getSingleHandover,
  markVehicleReturned,
  updateHandover,
  uploadHandoverImages,
} from "../controllers/handover.controller.js";

const router = express.Router();

router.use(protect);

router.post("/create", handoverUpload, createHandover);
router.put("/upload-images/:handoverId",protect,handoverUpload,uploadHandoverImages,);
router.get("/active-handovers",protect,getActiveHandovers);
router.get("/single/:id",protect,getSingleHandover);
// no use
router.get("/all", getAllHandovers);
router.get("single/:id", getSingleHandover);
router.put("/update/:id", updateHandover);
router.put("/return/:id", markVehicleReturned);
router.delete("/delete/:id", deleteHandover);

export default router;
