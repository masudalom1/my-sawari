import mongoose from "mongoose";
import PaymentHistory from "../models/paymentHistory.model.js"; 

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const MODES = ["cash", "phonepe", "gpay", "razorpay", "mixed"];
const TYPES = [
  "booking",
  "handover",
  "rental",
  "extension",
  "additional_charge",
  "receive",
  "refund",
];

// Which date the range filter applies to
const DATE_FIELDS = {
  created: "createdAt",
  payment: "paymentDate",
  collected: "lastCollectedAt",
};

// Allowed sort keys (whitelisted so users can't sort on arbitrary fields)
const SORT_FIELDS = {
  amount: "amount",
  created: "createdAt",
  collected: "lastCollectedAt",
  payment: "paymentDate",
};


const ROW_PROJECTION = {
  "customer.fullName": 1,
  "customer.mobileNumber": 1,
  "vehicle.vehicleName": 1,
  "vehicle.vehicleNumber": 1,
  "booking.fromDate": 1,
  "booking.toDate": 1,
  createdAt: 1,
  paymentDate: 1,
  lastCollectedAt: 1,
  lastCollectedByName: 1,
  type: 1,
  paymentMethod: 1,
  paymentBreakdown: 1,
  amount: 1,
  isCollected: 1,
  transactionId: 1,
};

const istToday = () => {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
};

const istMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);

const parseYMD = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
};

export function resolveRange(preset, from, to) {
  const t = istToday();
  switch (preset) {
    case "today":
      return { start: istMidnight(t.y, t.m, t.d), end: istMidnight(t.y, t.m, t.d + 1) };
    case "yesterday":
      return { start: istMidnight(t.y, t.m, t.d - 1), end: istMidnight(t.y, t.m, t.d) };
    case "this_month":
      return { start: istMidnight(t.y, t.m, 1), end: istMidnight(t.y, t.m + 1, 1) };
    case "last_month":
      return { start: istMidnight(t.y, t.m - 1, 1), end: istMidnight(t.y, t.m, 1) };
    case "custom": {
      const f = parseYMD(from);
      const e = parseYMD(to);
      if (!f && !e) return null;
      return {
        start: f ? istMidnight(f.y, f.m, f.d) : null,
        end: e ? istMidnight(e.y, e.m, e.d + 1) : null, // include the whole "to" day
      };
    }
    default:
      return null; // "all"
  }
}

const listParam = (value, allowed) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function getCompanyId(req) {
  const id = req.user?.company ?? req.user?._id;
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(String(id));
}

export const getPaymentsHistory = async (req, res) => {
  try {
    const {
      preset = "today",
      from,
      to,
      dateField = "created",
      mode,
      type,
      status,
      search,
      sortBy,
      order = "desc",
    } = req.query;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const field = DATE_FIELDS[dateField] || "createdAt";

    /* ---------- build $match ---------- */
    const match = {};

    const companyId = getCompanyId(req);
    if (companyId) match.company = companyId;

    const range = resolveRange(preset, from, to);
    if (range) {
      match[field] = {};
      if (range.start) match[field].$gte = range.start;
      if (range.end) match[field].$lt = range.end;
    }

    const modes = listParam(mode, MODES);
    if (modes.length) match.paymentMethod = modes.length === 1 ? modes[0] : { $in: modes };

    const types = listParam(type, TYPES);
    if (types.length) match.type = types.length === 1 ? types[0] : { $in: types };

    if (status === "collected") match.isCollected = true;
    else if (status === "pending") match.isCollected = false;

    const q = String(search || "").trim().slice(0, 50);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      match.$or = [
        { "customer.fullName": rx },
        { "customer.mobileNumber": rx },
        { "vehicle.vehicleNumber": rx },
      ];
    }

    const sortKey = SORT_FIELDS[sortBy] || field;
    const dir = order === "asc" ? 1 : -1;

    /* ---------- stats expressions ---------- */
    const isRefund = { $eq: ["$type", "refund"] };

    // Money received per channel. "mixed" rows are split using paymentBreakdown.
    const channelSum = (method, breakdownKey) => ({
      $sum: {
        $cond: [
          isRefund,
          0,
          {
            $cond: [
              { $eq: ["$paymentMethod", method] },
              "$amount",
              {
                $cond: [
                  { $eq: ["$paymentMethod", "mixed"] },
                  { $ifNull: [`$paymentBreakdown.${breakdownKey}`, 0] },
                  0,
                ],
              },
            ],
          },
        ],
      },
    });

    /* ---------- run rows + stats in parallel ---------- */
    const [rows, statsAgg] = await Promise.all([
      PaymentHistory.find(match, ROW_PROJECTION)
        .sort({ [sortKey]: dir, _id: dir })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      PaymentHistory.aggregate([
        { $match: match },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  received: { $sum: { $cond: [isRefund, 0, "$amount"] } },
                  refunded: { $sum: { $cond: [isRefund, "$amount", 0] } },
                  collected: {
                    $sum: {
                      $cond: [{ $and: ["$isCollected", { $not: [isRefund] }] }, "$amount", 0],
                    },
                  },
                  cash: channelSum("cash", "cash"),
                  phonepe: channelSum("phonepe", "phonePe"),
                  gpay: channelSum("gpay", "gpay"),
                  razorpay: channelSum("razorpay", "razorpay"),
                },
              },
            ],
            byType: [
              { $group: { _id: "$type", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
              { $sort: { amount: -1 } },
            ],
          },
        },
      ]).allowDiskUse(true),
    ]);

    const s = statsAgg?.[0]?.summary?.[0] || {};
    const total = s.count || 0;
    const received = s.received || 0;
    const refunded = s.refunded || 0;
    const collected = s.collected || 0;

    return res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
      stats: {
        count: total,
        received,
        refunded,
        net: received - refunded,
        collected,
        pending: Math.max(0, received - collected),
        byMode: {
          cash: s.cash || 0,
          phonepe: s.phonepe || 0,
          gpay: s.gpay || 0,
          razorpay: s.razorpay || 0,
        },
        byType: (statsAgg?.[0]?.byType || []).map((t) => ({
          type: t._id,
          amount: t.amount,
          count: t.count,
        })),
      },
      range: range
        ? { start: range.start, end: range.end, field }
        : { start: null, end: null, field },
    });
  } catch (err) {
    console.error("getPaymentsHistory error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to load payments history",
    });
  }
};