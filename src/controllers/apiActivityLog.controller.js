import mongoose from "mongoose";
import ApiActivityLog from "../models/apiActivityLog.model.js";
import ApiError from "../utils/ApiError.js";

const SORTABLE_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "action",
  "actorName",
  "actorRole",
  "entityType",
  "entityId",
  "method",
  "statusCode",
  "outcome",
  "summary",
]);
const FILTERABLE_FIELDS = new Set(["action", "actorRole", "entityType", "outcome", "method"]);
const MAX_LIMIT = 100;

const parsePositiveInteger = (value, name, fallback, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new ApiError(400, `${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new ApiError(400, `${name} must not exceed ${max}`);
  }
  return parsed;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getApiActivityLogs = async (req, res) => {
  const {
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
    from,
    to,
    entityId,
    actorUserId,
  } = req.query;
  const page = parsePositiveInteger(req.query.page, "page", 1);
  const limit = parsePositiveInteger(req.query.limit, "limit", 25, MAX_LIMIT);

  if (typeof sortBy !== "string" || !SORTABLE_FIELDS.has(sortBy)) {
    throw new ApiError(400, "Invalid sortBy field");
  }
  if (typeof sortOrder !== "string" || !["asc", "desc"].includes(sortOrder)) {
    throw new ApiError(400, "sortOrder must be asc or desc");
  }
  if (search !== undefined && (typeof search !== "string" || search.length > 100)) {
    throw new ApiError(400, "search must be a string of at most 100 characters");
  }
  if (actorUserId !== undefined && !mongoose.isValidObjectId(actorUserId)) {
    throw new ApiError(400, "actorUserId must be a valid ObjectId");
  }

  const filter = {};
  for (const field of FILTERABLE_FIELDS) {
    const value = req.query[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 100) {
        throw new ApiError(400, `${field} must be a string of at most 100 characters`);
      }
      filter[field] = value;
    }
  }
  if (entityId !== undefined) {
    if (typeof entityId !== "string" || entityId.length > 100) {
      throw new ApiError(400, "entityId must be a string of at most 100 characters");
    }
    filter.entityId = entityId;
  }
  if (actorUserId) filter.actorUserId = new mongoose.Types.ObjectId(actorUserId);
  if (from !== undefined || to !== undefined) {
    const createdAt = {};
    for (const [name, value, operator] of [["from", from, "$gte"], ["to", to, "$lte"]]) {
      if (value === undefined) continue;
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new ApiError(400, `${name} must be a valid date`);
      }
      createdAt[operator] = new Date(value);
    }
    if (createdAt.$gte && createdAt.$lte && createdAt.$gte > createdAt.$lte) {
      throw new ApiError(400, "from must be earlier than or equal to to");
    }
    filter.createdAt = createdAt;
  }

  const normalizedSearch = search?.trim();
  if (normalizedSearch) {
    const expression = new RegExp(escapeRegex(normalizedSearch), "i");
    filter.$or = [
      { actorName: expression },
      { actorRole: expression },
      { entityType: expression },
      { entityId: expression },
      { summary: expression },
      { path: expression },
      { vehicleName: expression },
      { vehicleNumber: expression },
      { "changes.field": expression },
      { "changes.oldValue": expression },
      { "changes.newValue": expression },
    ];
  }

  const sortDirection = sortOrder === "asc" ? 1 : -1;
  const sort = { [sortBy]: sortDirection, _id: sortDirection };
  const skip = (page - 1) * limit;
  const [total, data] = await Promise.all([
    ApiActivityLog.countDocuments(filter),
    ApiActivityLog.find(filter).sort(sort).skip(skip).limit(limit).lean(),
  ]);
  const totalPages = Math.ceil(total / limit);

  res.set("Cache-Control", "private, no-store");
  return res.status(200).json({
    success: true,
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1 && total > 0,
    },
  });
};
