import express from "express";

import protect from "../middlewares/auth.middleware.js";
import { handoverUpload, singleImageUpload } from "../middlewares/upload.middleware.js";
import {
  createHandover,
  deleteHandover,
  getActiveHandovers,
  getAllHandovers,
  getReceiveCarList,
  getRentalDetails,
  getSingleHandover,
  saveHandoverImages,
  updateHandover,
  updateRental,
  uploadHandoverImages,
  uploadSingleImage,
} from "../controllers/handover.controller.js";

const router = express.Router();

router.use(protect);

router.post("/create", handoverUpload, createHandover);

router.put("/upload-images/:handoverId",protect,handoverUpload,uploadHandoverImages,);
router.post("/image",protect,singleImageUpload,uploadSingleImage);
router.put("/save-images/:handoverId",protect,saveHandoverImages);

router.get("/active-handovers",protect,getActiveHandovers);
router.get("/single/:id",protect,getSingleHandover);
router.get("/receive-list", getReceiveCarList);

// ACTIVE RENTAL EDIT APIS
router.get("/rentals/:id",protect,getRentalDetails);

router.put("/rentals/edit/:id",protect,updateRental);
// no use
router.get("/all", getAllHandovers);
router.get("single/:id", getSingleHandover);
router.put("/update/:id", updateHandover);
router.delete("/delete/:id", deleteHandover);

export default router;
