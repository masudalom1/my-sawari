import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "../config/cloudinary.js";

/* ==================================
   IMAGE FILE FILTER
================================== */

const imageFileFilter = (req, file, cb) => {
  const allowedTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    return cb(null, true);
  }

  return cb(
    new Error(
      "Only JPG, JPEG, PNG and WEBP image files are allowed"
    ),
    false
  );
};

/* ==================================
   CLOUDINARY STORAGE
================================== */

const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "my-sawari/handover",
    allowed_formats: [
      "jpg",
      "jpeg",
      "png",
      "webp",
    ],
    public_id: `${Date.now()}-${Math.round(
      Math.random() * 1000000
    )}`,
  }),
});

/* ==================================
   MULTER INSTANCE
================================== */

const upload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

/* ==================================
   HANDOVER UPLOAD
================================== */

export const handoverUpload = upload.fields([
  {
    name: "customerPhoto",
    maxCount: 1,
  },
  { name: "customerProfileImage", maxCount: 1 },
  {
    name: "customerWithVehicle",
    maxCount: 1,
  },

  {
    name: "idCardFront",
    maxCount: 1,
  },
  {
    name: "idCardBack",
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

/* ==================================
   VEHICLE RETURN UPLOAD
================================== */

export const vehicleReturnUpload =
  upload.fields([
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

    {
      name: "damageImages",
      maxCount: 20,
    },
  ]);

/* ==================================
   MULTER ERROR HANDLER
================================== */

export const multerErrorHandler = (
  err,
  req,
  res,
  next
) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  next();
};

export const singleImageUpload = upload.single("image")