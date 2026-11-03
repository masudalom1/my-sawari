import express from "express";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { handoverUpload, singleImageUpload,vehicleExchangeUpload,multerErrorHandler } from "../middlewares/upload.middleware.js";
import {
  completeDraftHandover,
  createDraftHandover,
  createHandover,
  deleteHandover,
  discardHandoverDraft,
  getActiveHandovers,
  getAllHandovers,
  getHandoverById,
  getHandoverImages,
  getHandovers,
  getLatestDraftHandover,
  getReceiveCarList,
  getRentalDetails,
  getSingleHandover,
  saveHandoverImages,
  saveSingleHandoverImage,
  updateDraftHandover,
  updateDraftImages,
  updateHandover,
  updateRental,
  uploadHandoverImages,
  uploadSingleImage,
} from "../controllers/handover.controller.js";

const router = express.Router();

router.use(protect);
router.use(requirePermission(PERMISSIONS.bookings.view));

router.post("/create", requirePermission(PERMISSIONS.bookings.create), handoverUpload, createHandover);

router.put("/upload-images/:handoverId",protect,requirePermission(PERMISSIONS.bookings.edit),handoverUpload,uploadHandoverImages,);
router.post("/image",protect,requirePermission(PERMISSIONS.bookings.edit),singleImageUpload,uploadSingleImage);
router.put("/save-images/:handoverId",protect,requirePermission(PERMISSIONS.bookings.edit),saveHandoverImages);
router.put("/save-single-image/:handoverId",protect,requirePermission(PERMISSIONS.bookings.edit),saveSingleHandoverImage);
router.get("/images/:handoverId",protect,requirePermission(PERMISSIONS.bookings.view),getHandoverImages);

router.get("/active-handovers",protect,requirePermission(PERMISSIONS.bookings.view),getActiveHandovers);
router.get("/single/:id",protect,requirePermission(PERMISSIONS.bookings.view),getSingleHandover);
router.get("/receive-list", requirePermission(PERMISSIONS.bookings.view), getReceiveCarList);

// ACTIVE RENTAL EDIT APIS
router.get("/rentals/:id",protect,requirePermission(PERMISSIONS.bookings.view),getRentalDetails);

router.put("/rentals/edit/:id",protect,requirePermission(PERMISSIONS.bookings.edit),vehicleExchangeUpload,multerErrorHandler,updateRental);

//handover api 
router.get("/list", protect, requirePermission(PERMISSIONS.bookings.view), getHandovers);
router.patch("/discard/:id", requirePermission(PERMISSIONS.bookings.edit), discardHandoverDraft);
// no use
router.get("/all", requirePermission(PERMISSIONS.bookings.view), getAllHandovers);
router.get("single/:id", requirePermission(PERMISSIONS.bookings.view), getSingleHandover);

router.put("/update/:id", requirePermission(PERMISSIONS.bookings.edit), updateHandover);
router.delete("/delete/:id", requirePermission(PERMISSIONS.bookings.delete), deleteHandover);

router.get("/:id",protect,getHandoverById);


// Draft route 
router.post("/draft", protect,requirePermission(PERMISSIONS.bookings.create), createDraftHandover);
router.put("/draft/:id", protect,requirePermission(PERMISSIONS.bookings.edit), updateDraftHandover);
router.put("/images/:id",protect,requirePermission(PERMISSIONS.bookings.edit),handoverUpload,updateDraftImages);
router.get("/draft/latest",protect,requirePermission(PERMISSIONS.bookings.view),getLatestDraftHandover);

router.put("/complete/:id", protect,requirePermission(PERMISSIONS.bookings.edit), completeDraftHandover);

export default router;
