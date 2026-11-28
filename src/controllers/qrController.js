import mongoose from "mongoose";
import ReferralQR from "../models/ReferralQR.js";
import Customer from "../models/customer.model.js";
import QrTemplate from "../models/qrTemplate.model.js"; // NEW: QR card templates

const CODE_REGEX = /^[A-HJKMNP-Z2-9]{6}$/;
const MAX_BULK = Number(process.env.QR_MAX_BULK || 1000);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const maskMobile = (m) => {
  const s = String(m || "").replace(/\D/g, "").slice(-10);
  return s.length === 10 ? `${s.slice(0, 2)}••••${s.slice(-4)}` : s;
};

const assignerFrom = (user) => ({
  userId: user?._id,
  name: user?.fullName || user?.name || "Admin",
  mobile: user?.mobileNumber || "",
  email: user?.email || "",
  role: user?.role || "ADMIN",
});

const STATUS_FILTER = {
  assigned: "assigned",
  unassigned: "available",
  pending: "pending",
  revoked: "revoked",
};

// Fields sent to the dashboard pages.
// Includes who assigned the QR (name + role). Customer id and mobile are never sent.
const PUBLIC_FIELDS =
  "token batchName status claimedAt assignedAt createdAt updatedAt " +
  "claimDetails.businessName claimDetails.category claimDetails.location " +
  "executiveName assignedBy.name assignedBy.role templateId";

const normalizeCode = (v) => String(v || "").trim().toUpperCase();
const clean = (v) => String(v ?? "").trim();

// ============================================================
// POST /api/v1/qr/qr-codes/bulk
// body:     { batchName, codes: string[] }
// response: { success, inserted: string[], duplicates: string[] }
// ============================================================
export const bulkCreate = async (req, res, next) => {
  try {
    const { batchName, codes } = req.body || {};

    if (!batchName || typeof batchName !== "string" || !batchName.trim()) {
      return res.status(400).json({ success: false, message: "Batch name is required" });
    }

    if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_BULK) {
      return res.status(400).json({ success: false, message: `Send 1–${MAX_BULK} codes` });
    }

    const unique = [...new Set(codes.map(normalizeCode))];

    if (!unique.every((c) => CODE_REGEX.test(c))) {
      return res.status(400).json({ success: false, message: "Invalid code format" });
    }

    const docs = unique.map((token) => ({ token, batchName: batchName.trim() }));

    let duplicates = [];

    try {
      await ReferralQR.insertMany(docs, { ordered: false });
    } catch (err) {
      const writeErrors = err.writeErrors || [];
      if (!writeErrors.length) throw err;

      // 11000 = duplicate key. Anything else is a real error.
      const onlyDuplicates = writeErrors.every((e) => (e.code ?? e.err?.code) === 11000);
      if (!onlyDuplicates) throw err;

      duplicates = writeErrors.map((e) => unique[e.index ?? e.err?.index]).filter(Boolean);
    }

    const dupSet = new Set(duplicates);
    const inserted = unique.filter((c) => !dupSet.has(c));

    return res.status(201).json({ success: true, inserted, duplicates });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// GET /api/v1/qr/qr-codes/:code
// response: { success, qr }
// ============================================================
export const getByCode = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);

    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const qr = await ReferralQR.findOne({ token: code }).select(PUBLIC_FIELDS).lean();

    if (!qr) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    return res.json({ success: true, qr });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// POST /api/v1/qr/qr-codes/:code/claim   (DISABLED)
// The old open claim form let anyone claim a QR without logging in.
// QR codes are now assigned only by logged-in team members
// (POST /qr-codes/:code/assign). Kept so existing route imports don't break.
// ============================================================
export const claimCode = (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Self-registration is closed. QR codes are assigned by the MySawari team.",
  });
};

// ============================================================
// GET /api/v1/qr/qr-codes?status=&batch=&search=&page=&limit=
// ============================================================
export const listCodes = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 48));
    const status = clean(req.query.status).toLowerCase();
    const batch = clean(req.query.batch);
    const search = clean(req.query.search).slice(0, 100);

    if (status && !STATUS_FILTER[status]) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    // Batch + search apply to the counts too; status only to the list
    const base = {};
    if (batch) base.batchName = batch;
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      base.$or = [
        { token: rx },
        { "claimDetails.businessName": rx },
        { "claimDetails.location": rx },
        { executiveName: rx },
        { "assignedBy.name": rx },
      ];
    }
    const filter = status ? { ...base, status: STATUS_FILTER[status] } : base;

    const [items, total, statusRows, batches] = await Promise.all([
      ReferralQR.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(PUBLIC_FIELDS)
        .lean(),
      ReferralQR.countDocuments(filter),
      ReferralQR.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      ReferralQR.aggregate([
        { $group: { _id: "$batchName", total: { $sum: 1 }, createdAt: { $max: "$createdAt" } } },
        { $sort: { createdAt: -1 } },
        { $limit: 200 },
        { $project: { _id: 0, batchName: "$_id", total: 1, createdAt: 1 } },
      ]),
    ]);

    const by = Object.fromEntries(statusRows.map((r) => [r._id, r.n]));
    const counts = {
      total: statusRows.reduce((sum, r) => sum + r.n, 0),
      assigned: by.assigned || 0,
      unassigned: by.available || 0,
      pending: by.pending || 0,
      revoked: by.revoked || 0,
    };

    return res.json({
      success: true,
      items,
      counts,
      batches,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// GET /api/v1/qr/customers/search?q=
// ============================================================
export const searchCustomers = async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim().slice(0, 60);
    const digits = q.replace(/\D/g, "");
    const isNumber = /^[+\d\s-]+$/.test(q);

    if (isNumber ? digits.length < 4 : q.length < 3) {
      return res.status(400).json({ success: false, message: "Type at least 4 digits or 3 letters" });
    }

    const match = isNumber
      ? { mobileNumber: new RegExp(escapeRegex(digits.slice(-10))) }
      : { customerName: new RegExp(escapeRegex(q), "i") };

    const users = await Customer.find({ status: "active", ...match })
      .select("customerName mobileNumber")
      .limit(10)
      .lean();

    const customers = users.map((u) => ({
      _id: u._id,
      name: u.customerName || "(no name)",
      mobile: maskMobile(u.mobileNumber),
    }));

    return res.json({ success: true, customers });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// POST /api/v1/qr/qr-codes/:code/assign
// Accepts existing customerId OR on-the-spot partner details:
// { customerId } OR { newCustomer: { name, mobile, businessName, location } }
// ============================================================
export const assignCode = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    let customer = null;
    let businessName = "";
    let ownerName = "";
    let location = "";

    const customerId = String(req.body?.customerId ?? "").trim();
    if (customerId && mongoose.isValidObjectId(customerId)) {
      customer = await Customer.findOne({ _id: customerId, status: "active" })
        .select("customerName mobileNumber")
        .lean();
      if (!customer) {
        return res.status(404).json({ success: false, message: "Customer not found" });
      }
      ownerName = String(customer.customerName || "");
      businessName = String(req.body?.businessName || ownerName);
      location = String(req.body?.location || "");
    } else {
      const newCust = req.body?.newCustomer || req.body || {};
      const rawMobile = String(newCust.mobile || newCust.mobileNumber || "").replace(/\D/g, "").slice(-10);
      if (!/^[6-9]\d{9}$/.test(rawMobile)) {
        return res.status(400).json({ success: false, message: "Choose a customer or enter a valid 10-digit mobile number" });
      }

      ownerName = String(newCust.name || newCust.ownerName || newCust.businessName || "Partner").trim();
      businessName = String(newCust.businessName || newCust.name || ownerName).trim();
      location = String(newCust.location || "").trim();

      customer = await Customer.findOne({ mobileNumber: rawMobile, status: "active" })
        .select("customerName mobileNumber")
        .lean();

      if (!customer) {
        const uniqueReferralCode = () => {
          const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
          let s = "";
          for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
          return s;
        };

        const created = await Customer.create({
          customerName: ownerName,
          mobileNumber: rawMobile,
          referralCode: uniqueReferralCode(),
          status: "active",
          walletBalance: 0,
        });
        customer = {
          _id: created._id,
          customerName: created.customerName,
          mobileNumber: created.mobileNumber,
        };
      }
    }

    const now = new Date();
    const by = assignerFrom(req.user);
    const rawTplId = String(req.body?.templateId || "").trim();
    const validTemplateId = mongoose.isValidObjectId(rawTplId) ? rawTplId : null;

    // Atomic: only an "available" QR can be assigned, so never twice
    const qr = await ReferralQR.findOneAndUpdate(
      { token: code, status: "available" },
      {
        $set: {
          status: "assigned",
          partnerId: customer._id,
          claimedAt: now,
          assignedAt: now,
          executiveId: by.userId,
          executiveName: by.name,
          assignedBy: by,
          ...(validTemplateId ? { templateId: validTemplateId } : {}),
          claimDetails: {
            businessName: businessName || ownerName,
            ownerName: ownerName,
            mobile: String(customer.mobileNumber || ""),
            location: location || "",
          },
        },
        $push: {
          history: {
            action: "assigned",
            customerId: customer._id,
            customerName: businessName || ownerName,
            by,
            at: now,
          },
        },
      },
      { new: true }
    )
      .select(PUBLIC_FIELDS)
      .lean();

    if (!qr) {
      const existing = await ReferralQR.findOne({ token: code }).select("status").lean();
      if (!existing) return res.status(404).json({ success: false, message: "QR code not found" });
      if (existing.status === "revoked") {
        return res.status(409).json({ success: false, message: "This QR code is disabled." });
      }
      return res.status(409).json({ success: false, message: "This QR code is already assigned." });
    }

    return res.status(201).json({ success: true, qr });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// POST /api/v1/qr/qr-codes/:code/unassign
// ============================================================
export const unassignCode = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const existing = await ReferralQR.findOne({ token: code }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }
    if (existing.status !== "assigned") {
      return res.status(400).json({ success: false, message: "QR code is not currently assigned" });
    }

    const now = new Date();
    const by = assignerFrom(req.user);

    const qr = await ReferralQR.findOneAndUpdate(
      { token: code, status: "assigned" },
      {
        $set: {
          status: "available",
          partnerId: null,
          claimedAt: null,
          assignedAt: null,
          claimDetails: null,
          executiveId: null,
          executiveName: null,
          assignedBy: null,
        },
        $push: {
          history: {
            action: "unassigned",
            customerId: existing.partnerId,
            customerName: existing.claimDetails?.businessName || existing.claimDetails?.ownerName || "",
            by,
            at: now,
          },
        },
      },
      { new: true }
    )
      .select(PUBLIC_FIELDS)
      .lean();

    return res.json({ success: true, qr, message: "QR code unassigned successfully" });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// POST /api/v1/qr/qr-codes/:code/revoke
// ============================================================
export const revokeCode = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const now = new Date();
    const by = assignerFrom(req.user);

    const qr = await ReferralQR.findOneAndUpdate(
      { token: code },
      {
        $set: {
          status: "revoked",
        },
        $push: {
          history: {
            action: "revoked",
            by,
            at: now,
          },
        },
      },
      { new: true }
    )
      .select(PUBLIC_FIELDS)
      .lean();

    if (!qr) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    return res.json({ success: true, qr, message: "QR code revoked successfully" });
  } catch (err) {
    next(err);
  }
};
// ############################################################
// NEW: QR CARD TEMPLATES
//   GET    /api/v1/qr/templates
//   POST   /api/v1/qr/templates
//   PUT    /api/v1/qr/templates/:id
//   PATCH  /api/v1/qr/templates/:id/default
//   DELETE /api/v1/qr/templates/:id
// ############################################################

const TPL_MAX_TEXTS = 12;
const TPL_MAX_SHAPES = 12;
const TPL_MAX_IMAGES = 8;
const TPL_MAX_IMAGE_CHARS = 1_600_000; // ~1.2 MB per image (data URL)
const TPL_MAX_TOTAL_CHARS = 7_000_000; // whole template
const TPL_FONTS = ["Inter", "Barlow Condensed", "Poppins", "Playfair Display", "JetBrains Mono"];

const tplNum = (v, d, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const TPL_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const tplColor = (v, d) => (typeof v === "string" && TPL_HEX.test(v.trim()) ? v.trim() : d);
const tplStr = (v, d = "", max = 200) => (typeof v === "string" ? v.slice(0, max) : d);
const tplId = (v) =>
  typeof v === "string" && /^[\w-]{1,20}$/.test(v) ? v : Math.random().toString(36).slice(2, 9);

const tplBadRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

// Only raster data URLs or https URLs (no SVG / javascript: etc.)
const tplImage = (v, field) => {
  if (!v) return "";
  if (typeof v !== "string") throw tplBadRequest(`${field}: invalid image`);
  const ok =
    /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(v) || /^https:\/\/[^\s"'<>]+$/i.test(v);
  if (!ok) throw tplBadRequest(`${field}: only PNG, JPG, WebP or GIF images are allowed`);
  if (v.length > TPL_MAX_IMAGE_CHARS) throw tplBadRequest(`${field}: image is too large`);
  return v;
};

// Mirrors normalizeTemplate() on the QR generator page
const sanitizeTemplate = (body = {}) => {
  const name = tplStr(body.name, "", 60).trim();
  if (!name) throw tplBadRequest("Template name is required.");

  const bg = body.background || {};
  const br = body.border || {};
  const qr = body.qr || {};
  const texts = Array.isArray(body.texts) ? body.texts : [];
  const shapes = Array.isArray(body.shapes) ? body.shapes : [];
  const images = Array.isArray(body.images) ? body.images : [];

  if (texts.length > TPL_MAX_TEXTS) throw tplBadRequest(`Max ${TPL_MAX_TEXTS} texts per template.`);
  if (shapes.length > TPL_MAX_SHAPES) throw tplBadRequest(`Max ${TPL_MAX_SHAPES} shapes per template.`);
  if (images.length > TPL_MAX_IMAGES) throw tplBadRequest(`Max ${TPL_MAX_IMAGES} images per template.`);

  const doc = {
    name,
    width: tplNum(body.width, 600, 100, 4000),
    height: tplNum(body.height, 760, 100, 4000),
    background: {
      color: tplColor(bg.color, "#ffffff"),
      gradientTo: bg.gradientTo ? tplColor(bg.gradientTo, "") : "",
      gradientAngle: tplNum(bg.gradientAngle, 180, 0, 360),
      image: tplImage(bg.image, "Background image"),
      imageFit: bg.imageFit === "contain" ? "contain" : "cover",
      imageOpacity: tplNum(bg.imageOpacity, 1, 0, 1),
    },
    border: {
      color: tplColor(br.color, "#e2e8f0"),
      width: tplNum(br.width, 0, 0, 10),
      radius: tplNum(br.radius, 3, 0, 50),
    },
    qr: {
      cx: tplNum(qr.cx, 50, 0, 100),
      cy: tplNum(qr.cy, 52, 0, 100),
      size: tplNum(qr.size, 70, 10, 100),
      fg: tplColor(qr.fg, "#000000"),
      bg: tplColor(qr.bg, "#ffffff"),
      padding: tplNum(qr.padding, 0, 0, 15),
      radius: tplNum(qr.radius, 0, 0, 20),
      centerLogo: tplImage(qr.centerLogo, "QR centre logo"),
      centerLogoSize: tplNum(qr.centerLogoSize, 22, 10, 30),
    },
    texts: texts.map((x = {}) => ({
      id: tplId(x.id),
      text: tplStr(x.text, "", 200),
      cx: tplNum(x.cx, 50, 0, 100),
      cy: tplNum(x.cy, 50, 0, 100),
      size: tplNum(x.size, 5, 1, 40),
      color: tplColor(x.color, "#12151b"),
      weight: tplNum(x.weight, 600, 100, 900),
      font: TPL_FONTS.includes(x.font) ? x.font : "Inter",
      letterSpacing: tplNum(x.letterSpacing, 0, -0.1, 1),
      uppercase: !!x.uppercase,
    })),
    shapes: shapes.map((s = {}) => ({
      id: tplId(s.id),
      cx: tplNum(s.cx, 50, -50, 150),
      cy: tplNum(s.cy, 50, -50, 150),
      w: tplNum(s.w, 100, 1, 200),
      h: tplNum(s.h, 10, 1, 200),
      color: tplColor(s.color, "#fbbf24"),
      radius: tplNum(s.radius, 0, 0, 50),
      opacity: tplNum(s.opacity, 1, 0, 1),
    })),
    images: images
      .map((im = {}, i) => ({
        id: tplId(im.id),
        src: tplImage(im.src, `Image ${i + 1}`),
        cx: tplNum(im.cx, 50, -50, 150),
        cy: tplNum(im.cy, 50, -50, 150),
        w: tplNum(im.w, 30, 2, 200),
        opacity: tplNum(im.opacity, 1, 0, 1),
        radius: tplNum(im.radius, 0, 0, 50),
      }))
      .filter((im) => im.src),
  };

  if (JSON.stringify(doc).length > TPL_MAX_TOTAL_CHARS) {
    throw tplBadRequest("Template is too large. Use fewer or smaller images.");
  }
  return doc;
};

const tplNotFound = (res) => res.status(404).json({ success: false, message: "Template not found" });

// Validation errors go back as 400; anything else goes to your error handler
const tplFail = (res, next, err) =>
  err.status === 400 || err.name === "ValidationError"
    ? res.status(400).json({ success: false, message: err.message })
    : next(err);

// ============================================================
// GET /api/v1/qr/templates
// response: { success, data: QrTemplate[] }
// ============================================================
export const listTemplates = async (req, res, next) => {
  try {
    const templates = await QrTemplate.find({}).sort({ isDefault: -1, updatedAt: -1 }).lean();
    return res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// POST /api/v1/qr/templates
// ============================================================
export const createTemplate = async (req, res, next) => {
  try {
    const doc = sanitizeTemplate(req.body);
    const by = req.user?._id || null;
    const created = await QrTemplate.create({ ...doc, createdBy: by, updatedBy: by });
    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    tplFail(res, next, err);
  }
};

// ============================================================
// PUT /api/v1/qr/templates/:id
// ============================================================
export const updateTemplate = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return tplNotFound(res);
    const doc = sanitizeTemplate(req.body);
    const updated = await QrTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: { ...doc, updatedBy: req.user?._id || null } },
      { new: true, runValidators: true }
    );
    if (!updated) return tplNotFound(res);
    return res.json({ success: true, data: updated });
  } catch (err) {
    tplFail(res, next, err);
  }
};

// ============================================================
// PATCH /api/v1/qr/templates/:id/default
// Only one team default at a time
// ============================================================
export const setDefaultTemplate = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return tplNotFound(res);
    const exists = await QrTemplate.exists({ _id: req.params.id });
    if (!exists) return tplNotFound(res);

    await QrTemplate.updateMany({ _id: { $ne: req.params.id }, isDefault: true }, { $set: { isDefault: false } });
    const updated = await QrTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: { isDefault: true, updatedBy: req.user?._id || null } },
      { new: true }
    );
    return res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// DELETE /api/v1/qr/templates/:id
// Printed stickers are not affected (they only hold the code)
// ============================================================
export const deleteTemplate = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return tplNotFound(res);
    const deleted = await QrTemplate.findByIdAndDelete(req.params.id);
    if (!deleted) return tplNotFound(res);
    return res.json({ success: true, data: { _id: deleted._id }, message: "Template deleted" });
  } catch (err) {
    next(err);
  }
};