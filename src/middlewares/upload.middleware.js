import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "../config/cloudinary.js";

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "my-sawari/handover",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: `${Date.now()}-${file.originalname.split(".")[0]}`,
  }),
});

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

export const handoverUpload = upload.fields([
  { name: "customerPhoto", maxCount: 1 },
  { name: "customerWithVehicle", maxCount: 1 },

  // ID Card Images
  { name: "idCardFront", maxCount: 1 },
  { name: "idCardBack", maxCount: 1 },

  // Vehicle Images
  { name: "vehicleFront", maxCount: 1 },
  { name: "vehicleRear", maxCount: 1 },
  { name: "vehicleLeft", maxCount: 1 },
  { name: "vehicleRight", maxCount: 1 },
]);

export const vehicleReturnUpload = upload.fields([
  { name: "vehicleFront", maxCount: 1 },
  { name: "vehicleRear", maxCount: 1 },
  { name: "vehicleLeft", maxCount: 1 },
  { name: "vehicleRight", maxCount: 1 },
  { name: "damageImage", maxCount: 1 },
]);