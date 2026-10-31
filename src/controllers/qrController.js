import ReferralQR from "../models/ReferralQR.js";

const CODE_REGEX = /^[A-HJKMNP-Z2-9]{6}$/;
const MAX_BULK = Number(process.env.QR_MAX_BULK || 1000);

// POST /api/admin/qr-codes/bulk
// body:     { batchName, codes: string[] }
// response: { inserted: string[], duplicates: string[] }
export const bulkCreate = async (req, res, next) => {
  try {
    const { batchName, codes } = req.body || {};

    if (!batchName || typeof batchName !== "string" || !batchName.trim()) {
      return res.status(400).json({ message: "Batch name is required" });
    }

    if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_BULK) {
      return res.status(400).json({ message: `Send 1–${MAX_BULK} codes` });
    }

    const unique = [...new Set(codes.map((c) => String(c).trim().toUpperCase()))];

    if (!unique.every((c) => CODE_REGEX.test(c))) {
      return res.status(400).json({ message: "Invalid code format" });
    }

    const docs = unique.map((token) => ({
      token,
      batchName: batchName.trim(),
    }));

    let duplicates = [];

    try {
      await ReferralQR.insertMany(docs, { ordered: false });
    } catch (err) {
      const writeErrors = err.writeErrors || [];
      if (!writeErrors.length) throw err;

      // 11000 = duplicate key. Anything else is a real error.
      const onlyDuplicates = writeErrors.every(
        (e) => (e.code ?? e.err?.code) === 11000
      );
      if (!onlyDuplicates) throw err;

      duplicates = writeErrors
        .map((e) => unique[e.index ?? e.err?.index])
        .filter(Boolean);
    }

    const dupSet = new Set(duplicates);
    const inserted = unique.filter((c) => !dupSet.has(c));

    return res.status(201).json({ inserted, duplicates });
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/qr/qr-codes/:code
export const getByCode = async (req, res, next) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();

    if (!CODE_REGEX.test(code)) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    const qr = await ReferralQR.findOne({ token: code })
      .select("token batchName status partnerId assignedAt createdAt updatedAt")
      .lean();

    if (!qr) {
      return res.status(404).json({ success: false, message: "QR code not found" });
    }

    return res.json({ success: true, qr });
  } catch (err) {
    next(err);
  }
};