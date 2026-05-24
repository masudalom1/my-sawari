import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
    fileSize: 5 * 1024 * 1024,
  },
});

export const handoverUpload = upload.fields([
  {
    name: "customerPhoto",
    maxCount: 1,
  },
  {
    name: "customerWithVehicle",
    maxCount: 1,
  },
  {
    name: "vehicleFront",
    maxCount: 1,
  },
  {
    name: "vehicleRear",
    maxCount: 1,
  },
  {
    name: "vehicleLeft",
    maxCount: 1,
  },
  {
    name: "vehicleRight",
    maxCount: 1,
  },
]);