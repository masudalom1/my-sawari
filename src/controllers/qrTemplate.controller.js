import crypto from "crypto";
import mongoose from "mongoose";
import cloudinary from "../config/cloudinary.js";
import QRTemplate from "../models/QRTemplate.js";
import ReferralQR from "../models/ReferralQR.js";
import { resolveActiveUser } from "../middlewares/auth.middleware.js";
import { resolveRequestPermissions } from "../services/permissionResolver.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { renderQrCardPng } from "../utils/qrCardRenderer.js";

const CODE_REGEX = /^[A-HJKMNP-Z2-9]{6}$/;
const HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;
const normalizeCode = (v) => String(v || "").trim().toUpperCase();
const clampNum = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
};
const parseBool = (v, fallback) => {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
};

const getDownloadHmacSecret = () => {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw Object.assign(new Error("JWT_ACCESS_SECRET is not configured"), { statusCode: 500 });
  }
  return crypto.createHmac("sha256", secret).update("mysawari-qr-download-v1").digest();
};

const signDownloadToken = ({ code, templateKey }) => {
  const payload = Buffer.from(
    JSON.stringify({
      c: code,
      t: templateKey,
      exp: Date.now() + 10 * 60 * 1000,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getDownloadHmacSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
};

const verifyDownloadToken = (dt, expectedCode, expectedTemplateKey) => {
  if (!dt || typeof dt !== "string" || !dt.includes(".")) return false;
  const [payloadB64, sigB64] = dt.split(".");
  if (!payloadB64 || !sigB64) return false;
  try {
    const expectedSig = crypto
      .createHmac("sha256", getDownloadHmacSecret())
      .update(payloadB64)
      .digest();
    const gotSig = Buffer.from(sigB64, "base64url");
    if (expectedSig.length !== gotSig.length || !crypto.timingSafeEqual(expectedSig, gotSig)) {
      return false;
    }
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!decoded || Number(decoded.exp) < Date.now()) return false;
    if (decoded.c !== expectedCode) return false;
    if (String(decoded.t || "classic") !== String(expectedTemplateKey || "classic")) return false;
    return true;
  } catch {
    return false;
  }
};

const hasDashboardViewPermission = async (req) => {
  let token = null;
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }
  if (!token && req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }
  if (!token) return false;

  try {
    const { user } = await resolveActiveUser(token);
    req.user = user;
    const access = await resolveRequestPermissions(req);
    if (user.role !== "SUPER_ADMIN" && !user.businessName) return false;
    return access.effectivePermissions[PERMISSIONS.qrCodes.view] === true;
  } catch {
    return false;
  }
};

const resolveTemplateOrClassic = async (templateIdRaw) => {
  const key = String(templateIdRaw || "").trim();
  if (!key || key === "classic") {
    return { template: null, templateKey: "classic" };
  }
  if (!mongoose.isValidObjectId(key)) {
    throw Object.assign(new Error("Invalid template ID"), { statusCode: 400 });
  }
  const tpl = await QRTemplate.findOne({ _id: key, isActive: true }).lean();
  if (!tpl) {
    throw Object.assign(new Error("Template not found"), { statusCode: 404 });
  }
  return { template: tpl, templateKey: String(tpl._id) };
};

export const listTemplates = async (req, res, next) => {
  try {
    const templates = await QRTemplate.find({ isActive: true })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean();
    return res.json({ success: true, templates });
  } catch (err) {
    next(err);
  }
};

export const createTemplate = async (req, res, next) => {
  const uploaded = req.uploadedTemplate;
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      if (uploaded?.publicId) {
        cloudinary.uploader.destroy(uploaded.publicId, { resource_type: "image" }).catch(() => {});
      }
      return res.status(400).json({ success: false, message: "Template name is required" });
    }
    if (!uploaded?.imageUrl || !uploaded?.publicId) {
      return res.status(400).json({ success: false, message: "Template image file is required" });
    }

    const isDefault = parseBool(req.body?.isDefault, false);
    const rawColor = String(req.body?.textColor || "").trim();

    if (isDefault) {
      await QRTemplate.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    }

    const template = await QRTemplate.create({
      name: name.slice(0, 80),
      imageUrl: uploaded.imageUrl,
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      qrSizePct: clampNum(req.body?.qrSizePct, 44, 18, 82),
      qrCenterXPct: clampNum(req.body?.qrCenterXPct, 50, 15, 85),
      qrCenterYPct: clampNum(req.body?.qrCenterYPct, 50, 15, 85),
      showQuietZone: parseBool(req.body?.showQuietZone, true),
      showCodeText: parseBool(req.body?.showCodeText, true),
      showBusinessName: parseBool(req.body?.showBusinessName, true),
      textColor: HEX_REGEX.test(rawColor) ? rawColor : "#0F172A",
      isDefault,
      isActive: true,
      createdBy: {
        userId: req.user?._id,
        name: req.user?.fullName || req.user?.name || "Admin",
        role: req.user?.role || "",
      },
    });

    return res.status(201).json({ success: true, template });
  } catch (err) {
    if (uploaded?.publicId) {
      cloudinary.uploader.destroy(uploaded.publicId, { resource_type: "image" }).catch(() => {});
    }
    next(err);
  }
};

export const updateTemplate = async (req, res, next) => {
  const uploaded = req.uploadedTemplate;
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      if (uploaded?.publicId) {
        cloudinary.uploader.destroy(uploaded.publicId, { resource_type: "image" }).catch(() => {});
      }
      return res.status(404).json({ success: false, message: "Template not found" });
    }

    const existing = await QRTemplate.findOne({ _id: id, isActive: true });
    if (!existing) {
      if (uploaded?.publicId) {
        cloudinary.uploader.destroy(uploaded.publicId, { resource_type: "image" }).catch(() => {});
      }
      return res.status(404).json({ success: false, message: "Template not found" });
    }

    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) {
        if (uploaded?.publicId) {
          cloudinary.uploader.destroy(uploaded.publicId, { resource_type: "image" }).catch(() => {});
        }
        return res.status(400).json({ success: false, message: "Template name cannot be empty" });
      }
      updates.name = name.slice(0, 80);
    }
    if (req.body?.qrSizePct !== undefined) {
      updates.qrSizePct = clampNum(req.body.qrSizePct, existing.qrSizePct, 18, 82);
    }
    if (req.body?.qrCenterXPct !== undefined) {
      updates.qrCenterXPct = clampNum(req.body.qrCenterXPct, existing.qrCenterXPct, 15, 85);
    }
    if (req.body?.qrCenterYPct !== undefined) {
      updates.qrCenterYPct = clampNum(req.body.qrCenterYPct, existing.qrCenterYPct, 15, 85);
    }
    if (req.body?.showQuietZone !== undefined) {
      updates.showQuietZone = parseBool(req.body.showQuietZone, existing.showQuietZone);
    }
    if (req.body?.showCodeText !== undefined) {
      updates.showCodeText = parseBool(req.body.showCodeText, existing.showCodeText);
    }
    if (req.body?.showBusinessName !== undefined) {
      updates.showBusinessName = parseBool(req.body.showBusinessName, existing.showBusinessName);
    }
    if (req.body?.textColor !== undefined) {
      const c = String(req.body.textColor || "").trim();
      if (HEX_REGEX.test(c)) updates.textColor = c;
    }
    if (req.body?.isDefault !== undefined) {
      const def = parseBool(req.body.isDefault, existing.isDefault);
      if (def) {
        await QRTemplate.updateMany({ _id: { $ne: id }, isDefault: true }, { $set: { isDefault: false } });
      }
      updates.isDefault = def;
    }

    let oldPublicId = null;
    if (uploaded?.imageUrl && uploaded?.publicId) {
      oldPublicId = existing.publicId;
      updates.imageUrl = uploaded.imageUrl;
      updates.publicId = uploaded.publicId;
      updates.width = uploaded.width;
      updates.height = uploaded.height;
    }

    const template = await QRTemplate.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (oldPublicId && oldPublicId !== uploaded.publicId) {
      cloudinary.uploader.destroy(oldPublicId, { resource_type: "image" }).catch(() => {});
    }

    return res.json({ success: true, template });
  } catch (err) {
    if (uploaded?.publicId) {
      cloudinary.uploader.destroy(uploaded.publicId, { resource_type: "image" }).catch(() => {});
    }
    next(err);
  }
};

export const deleteTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }

    const existing = await QRTemplate.findByIdAndDelete(id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }

    await ReferralQR.updateMany({ templateId: id }, { $set: { templateId: null } });

    if (existing.publicId) {
      cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" }).catch(() => {});
    }

    return res.json({ success: true, deletedId: id });
  } catch (err) {
    next(err);
  }
};

export const setQrTemplate = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const { template } = await resolveTemplateOrClassic(req.body?.templateId);
    const qr = await ReferralQR.findOneAndUpdate(
      { token: code },
      { $set: { templateId: template ? template._id : null } },
      { new: true }
    )
      .select(
        "token batchName status claimedAt assignedAt createdAt updatedAt " +
          "claimDetails.businessName claimDetails.category claimDetails.location " +
          "executiveName assignedBy.name assignedBy.role templateId"
      )
      .lean();

    if (!qr) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    return res.json({ success: true, qr });
  } catch (err) {
    next(err);
  }
};

export const createDownloadLink = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const qr = await ReferralQR.findOne({ token: code }).select("token").lean();
    if (!qr) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const { templateKey } = await resolveTemplateOrClassic(
      req.body?.templateId ?? req.query?.templateId
    );
    const dt = signDownloadToken({ code, templateKey });

    const protoHeader = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const proto = protoHeader || req.protocol || "https";
    const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
    const mount = `${proto}://${host}${req.baseUrl}`;

    const q = new URLSearchParams({ templateId: templateKey, dt });
    const downloadUrl = `${mount}/qr-codes/${code}/card.png?${q.toString()}`;
    const previewUrl = `${downloadUrl}&inline=1`;

    return res.json({
      success: true,
      downloadUrl,
      previewUrl,
      expiresInSeconds: 600,
    });
  } catch (err) {
    next(err);
  }
};

export const renderQrCard = async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const templateKeyParam = String(req.query?.templateId || "classic").trim() || "classic";
    const dt = String(req.query?.dt || "").trim();

    const tokenValid = verifyDownloadToken(dt, code, templateKeyParam);
    if (!tokenValid) {
      const authed = await hasDashboardViewPermission(req);
      if (!authed) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }
    }

    const qr = await ReferralQR.findOne({ token: code })
      .select("token status claimDetails.businessName templateId")
      .lean();
    if (!qr) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const { template } = await resolveTemplateOrClassic(templateKeyParam);
    const businessName = qr.claimDetails?.businessName || "";
    const pngBuffer = await renderQrCardPng({
      token: qr.token,
      businessName,
      template,
    });

    const slugSource = (template?.name || businessName || "card")
      .replace(/[^A-Za-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    const filename = `MySawari-QR-${qr.token}${slugSource ? `-${slugSource}` : ""}.png`;
    const isInline = String(req.query?.inline || "") === "1";

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Disposition",
      `${isInline ? "inline" : "attachment"}; filename="${filename}"`
    );
    return res.send(pngBuffer);
  } catch (err) {
    next(err);
  }
};
