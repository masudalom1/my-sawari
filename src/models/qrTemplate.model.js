import mongoose from "mongoose";

// QR sticker card design shared by the team.
// Positions/sizes are percentages of the card (see the QR generator page).
// Uploaded images are compressed in the browser and stored as data URLs,
// so no file storage is needed. https:// image URLs are also accepted.

const textSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, default: "", maxlength: 200 },
    cx: Number,
    cy: Number,
    size: Number,
    color: String,
    weight: Number,
    font: String,
    letterSpacing: Number,
    uppercase: Boolean,
  },
  { _id: false }
);

const shapeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    cx: Number,
    cy: Number,
    w: Number,
    h: Number,
    color: String,
    radius: Number,
    opacity: Number,
  },
  { _id: false }
);

const imageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    src: { type: String, required: true },
    cx: Number,
    cy: Number,
    w: Number,
    opacity: Number,
    radius: Number,
  },
  { _id: false }
);

const qrTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    isDefault: { type: Boolean, default: false, index: true },

    width: { type: Number, default: 600 },
    height: { type: Number, default: 760 },

    background: {
      color: { type: String, default: "#ffffff" },
      gradientTo: { type: String, default: "" },
      gradientAngle: { type: Number, default: 180 },
      image: { type: String, default: "" },
      imageFit: { type: String, enum: ["cover", "contain"], default: "cover" },
      imageOpacity: { type: Number, default: 1 },
    },

    border: {
      color: { type: String, default: "#e2e8f0" },
      width: { type: Number, default: 0 },
      radius: { type: Number, default: 3 },
    },

    qr: {
      cx: { type: Number, default: 50 },
      cy: { type: Number, default: 52 },
      size: { type: Number, default: 70 },
      fg: { type: String, default: "#000000" },
      bg: { type: String, default: "#ffffff" },
      padding: { type: Number, default: 0 },
      radius: { type: Number, default: 0 },
      centerLogo: { type: String, default: "" },
      centerLogoSize: { type: Number, default: 22 },
    },

    texts: { type: [textSchema], default: [] },
    shapes: { type: [shapeSchema], default: [] },
    images: { type: [imageSchema], default: [] },

    // Team member / admin who created / last changed it
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

const QrTemplate = mongoose.models.QrTemplate || mongoose.model("QrTemplate", qrTemplateSchema);

export default QrTemplate;