import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { handoverUpload, singleImageUpload } from "../middlewares/upload.middleware.js";
import {
  completeDraftHandover,
  createDraftHandover,
  createHandover,
  deleteHandover,
  getActiveHandovers,
  getAllHandovers,
  getHandoverById,
  getHandovers,
  getLatestDraftHandover,
  getReceiveCarList,
  getRentalDetails,
  getSingleHandover,
  saveHandoverImages,
  updateDraftHandover,
  updateDraftImages,
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

//handover api 
router.get("/list", protect, getHandovers);
// no use
router.get("/all", getAllHandovers);
router.get("single/:id", getSingleHandover);
router.put("/update/:id", updateHandover);
router.delete("/delete/:id", deleteHandover);

router.get("/:id",protect,getHandoverById);


// Draft route 
router.post("/draft", protect, createDraftHandover);
router.put("/draft/:id", protect, updateDraftHandover);
router.put("/images/:id",protect,handoverUpload,updateDraftImages);
router.get("/draft/latest",protect,getLatestDraftHandover);

router.put("/complete/:id",protect,completeDraftHandover);

export default router;
