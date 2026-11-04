import ReferralQR from "../models/ReferralQR.js";

const CODE_REGEX = /^[A-HJKMNP-Z2-9]{6}$/;
const MAX_BULK = Number(process.env.QR_MAX_BULK || 1000);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  "executiveName assignedBy.name assignedBy.role";

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