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

const vehicleStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "my-sawari/vehicles",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: `vehicle-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)}`,
  }),
});

const vehicleUpload = multer({
  storage: vehicleStorage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

export default vehicleUpload;