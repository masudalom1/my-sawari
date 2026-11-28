import multer from "multer";
import { createRequire } from "module";
import cloudinary from "../config/cloudinary.js";
import { randomUUID } from "crypto";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname?.toLowerCase().split(".").pop();
    const ok =
      ALLOWED_MIME.has(String(file.mimetype || "").toLowerCase()) ||
      ["jpg", "jpeg", "png", "webp"].includes(ext);
    if (!ok) {
      return cb(
        Object.assign(
          new Error("Only JPG, JPEG, PNG, and WEBP template images are allowed"),
          { statusCode: 400 }
        ),
        false
      );
    }
    return cb(null, true);
  },
});

const uploadBufferToCloudinary = (buffer, publicId) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "my-sawari/qr-templates",
        public_id: publicId,
        format: "png",
        resource_type: "image",
        overwrite: false,
      },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      }
    );
    stream.end(buffer);
  });

export const qrTemplateUpload = (req, res, next) => {
  upload.single("image")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          Object.assign(new Error("Template image must be 10 MB or smaller"), {
            statusCode: 400,
          })
        );
      }
      return next(
        Object.assign(err, { statusCode: err.statusCode || 400 })
      );
    }

    if (!req.file?.buffer) {
      return next();
    }

    try {
      const oriented = sharp(req.file.buffer).rotate();
      const meta = await oriented.metadata();

      if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200) {
        return next(
          Object.assign(
            new Error("Template image must be at least 200x200 pixels"),
            { statusCode: 400 }
          )
        );
      }

      const normalized = await oriented
        .resize({
          width: 2000,
          height: 2000,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });

      const uploaded = await uploadBufferToCloudinary(
        normalized.data,
        `qr-tpl-${Date.now()}-${randomUUID().slice(0, 8)}`
      );

      req.uploadedTemplate = {
        imageUrl: uploaded.secure_url,
        publicId: uploaded.public_id,
        width: uploaded.width || normalized.info.width,
        height: uploaded.height || normalized.info.height,
      };
      return next();
    } catch (uploadErr) {
      return next(
        Object.assign(
          new Error(uploadErr?.message || "Invalid or corrupted template image"),
          { statusCode: 400 }
        )
      );
    }
  });
};
