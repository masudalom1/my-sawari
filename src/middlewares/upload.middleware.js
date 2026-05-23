import multer from "multer";
import path from "path";
import fs from "fs";

const uploadPath = "uploads/handover";

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadPath);
  },

  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
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