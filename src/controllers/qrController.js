import mongoose from "mongoose";
import ReferralQR from "../models/ReferralQR.js";
import Customer from "../models/customer.model.js";

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