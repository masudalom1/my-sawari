import mongoose from "mongoose";

const creatorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, trim: true },
    role: { type: String, trim: true },
  },
  { _id: false }
);

const qrTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    publicId: {
      type: String,
      required: true,
      trim: true,
    },
    width: {
      type: Number,
      required: true,
      min: 100,
    },
    height: {
      type: Number,
      required: true,
      min: 100,
    },
    qrSizePct: {
      type: Number,
      default: 44,
      min: 18,
      max: 82,
    },
    qrCenterXPct: {
      type: Number,
      default: 50,
      min: 15,
      max: 85,
    },
    qrCenterYPct: {
      type: Number,
      default: 50,
      min: 15,
      max: 85,
    },
    showQuietZone: {
      type: Boolean,
      default: true,
    },
    showCodeText: {
      type: Boolean,
      default: true,
    },
    showBusinessName: {
      type: Boolean,
      default: true,
    },
    textColor: {
      type: String,
      default: "#0F172A",
      match: /^#[0-9A-Fa-f]{6}$/,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: creatorSchema,
      default: null,
    },
  },
  { timestamps: true }
);

const QRTemplate =
  mongoose.models.QRTemplate || mongoose.model("QRTemplate", qrTemplateSchema);

export default QRTemplate;
