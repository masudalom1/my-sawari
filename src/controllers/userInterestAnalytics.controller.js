import mongoose from "mongoose";
import Customer from "../models/customer.model.js";
import CustomerActivity from "../models/customerActivity.model.js";
import Vehicle from "../models/vehicle.model.js";
import ApiError from "../utils/ApiError.js";
import { normalizeMobileNumber } from "../services/membershipLookup.js";
import { resolveIndiaDateRange } from "../utils/indiaDateRange.js";

const MAX_LIMIT = 100;

function parsePositiveInteger(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, `${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new ApiError(400, `${name} must not exceed ${max}`);
  }
  return parsed;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeName(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-IN") : "";
}

function getVehicleName(vehicle) {
  return vehicle.displayName?.trim() || vehicle.vehicleName || "Unnamed vehicle";
}

function buildVehicleMaps(vehicles) {
  const byId = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
  const aliases = new Map();
  for (const vehicle of vehicles) {
    for (const alias of [vehicle.vehicleName, vehicle.displayName]) {
      const key = normalizeName(alias);
      if (!key) continue;
      const ids = aliases.get(key) || new Set();
      ids.add(String(vehicle._id));
      aliases.set(key, ids);
    }
  }
  return { byId, aliases };
}

function getEventVehicle(event, vehicleMaps) {
  const rawId = event.vehicleId;
  const id = rawId && mongoose.isObjectIdOrHexString(rawId)
    ? String(rawId)
    : "";
  if (id) {
    const vehicle = vehicleMaps.byId.get(id);
    return {
      key: `vehicle:${id}`,
      id,
      name: vehicle ? getVehicleName(vehicle) : event.vehicleName || `Vehicle ${id}`,
    };
  }
  const name = typeof event.vehicleName === "string" ? event.vehicleName.trim() : "";
  const aliasIds = vehicleMaps.aliases.get(normalizeName(name));
  if (aliasIds?.size === 1) {
    const [vehicleId] = aliasIds;
    const vehicle = vehicleMaps.byId.get(vehicleId);
    return { key: `vehicle:${vehicleId}`, id: vehicleId, name: getVehicleName(vehicle) };
  }
  if (id) return { key: `vehicle:${id}`, id, name: name || `Vehicle ${id}` };
  if (name) return { key: `legacy:${normalizeName(name)}`, id: null, name };
  return null;
}

function getSelectedVehicleFilter(vehicle, vehicleMaps) {
  const id = String(vehicle._id);
  const idValues = [id, vehicle._id];
  const legacyNames = [vehicle.vehicleName, vehicle.displayName]
    .filter((name) => {
      const ids = vehicleMaps.aliases.get(normalizeName(name));
      return ids?.size === 1 && ids.has(id);
    })
    .map((name) => name.trim());
  const legacyNamePatterns = legacyNames.map(
    (name) => new RegExp(`^${escapeRegex(name)}$`, "i"),
  );
  const noVehicleId = (field) => [
    { [field]: { $exists: false } },
    { [field]: null },
    { [field]: "" },
  ];
  return {
    $or: [
      { "details.vehicleId": { $in: idValues } },
      { "details.carId": { $in: idValues } },
      {
        $and: [
          { $or: noVehicleId("details.vehicleId") },
          { $or: noVehicleId("details.carId") },
          {
            $or: [
              { "details.carName": { $in: legacyNamePatterns } },
              { "details.vehicleName": { $in: legacyNamePatterns } },
            ],
          },
        ],
      },
    ],
  };
}

async function activityCollectionAvailability() {
  try {
    const collections = await CustomerActivity.db.db
      .listCollections({ name: CustomerActivity.collection.name }, { nameOnly: true })
      .toArray();
    return collections.length
      ? { status: "available", reason: null }
      : { status: "unavailable", reason: "customer_activity_collection_missing" };
  } catch (error) {
    if (error?.code === 13 || error?.code === 18) {
      return { status: "denied", reason: "customer_activity_read_denied" };
    }
    throw error;
  }
}

async function loadViewGroups(filter) {
  return CustomerActivity.aggregate([
    { $match: filter },
    {
      $project: {
        customerId: 1,
        mobileNumber: 1,
        createdAt: 1,
        vehicleId: {
          $ifNull: ["$details.vehicleId", { $ifNull: ["$details.carId", null] }],
        },
        vehicleName: {
          $ifNull: ["$details.carName", "$details.vehicleName"],
        },
        identity: {
          $cond: [
            { $ne: [{ $ifNull: ["$customerId", null] }, null] },
            { $concat: ["id:", { $toString: "$customerId" }] },
            { $concat: ["mobile:", { $ifNull: ["$mobileNumber", ""] }] },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          identity: "$identity",
          vehicleId: "$vehicleId",
          vehicleName: "$vehicleName",
        },
        customerId: { $first: "$customerId" },
        mobileNumber: { $first: "$mobileNumber" },
        views: { $sum: 1 },
        lastViewed: { $max: "$createdAt" },
      },
    },
    {
      $project: {
        _id: 0,
        identity: "$_id.identity",
        customerId: 1,
        mobileNumber: 1,
        vehicleId: "$_id.vehicleId",
        vehicleName: "$_id.vehicleName",
        views: 1,
        lastViewed: 1,
      },
    },
  ]);
}

function mobileForms(value) {
  const normalized = normalizeMobileNumber(value);
  if (!normalized) return [];
  return [
    value,
    normalized,
    `+91${normalized}`,
    `91${normalized}`,
    `+91 ${normalized}`,
    `${normalized.slice(0, 5)} ${normalized.slice(5)}`,
  ].filter((form, index, forms) => typeof form === "string" && form && forms.indexOf(form) === index);
}

async function resolveCustomerProfiles(groups) {
  const ids = new Set();
  const forms = new Set();
  for (const group of groups) {
    if (group.customerId && mongoose.isObjectIdOrHexString(group.customerId)) {
      ids.add(String(group.customerId));
    }
    for (const form of mobileForms(group.mobileNumber)) forms.add(form);
  }
  const filters = [];
  if (ids.size) {
    filters.push({
      _id: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) },
    });
  }
  if (forms.size) filters.push({ mobileNumber: { $in: [...forms] } });
  if (!filters.length) return { byId: new Map(), byMobile: new Map() };

  const customers = await Customer.find({ $or: filters })
    .select("customerName mobileNumber")
    .lean();
  const byId = new Map(customers.map((customer) => [String(customer._id), customer]));
  const byMobile = new Map();
  for (const customer of customers) {
    const normalized = normalizeMobileNumber(customer.mobileNumber);
    if (!normalized) continue;
    const matches = byMobile.get(normalized) || [];
    matches.push(customer);
    byMobile.set(normalized, matches);
  }
  return { byId, byMobile };
}

function resolveCustomer(group, customerMaps) {
  const id = group.customerId ? String(group.customerId) : "";
  const byId = id ? customerMaps.byId.get(id) : null;
  if (byId) return byId;
  const normalized = normalizeMobileNumber(group.mobileNumber);
  const matches = normalized ? customerMaps.byMobile.get(normalized) : null;
  return matches?.length === 1 ? matches[0] : null;
}

function getIdentityKey(group, customer) {
  if (customer) return `customer:${String(customer._id)}`;
  if (group.customerId) return `id:${String(group.customerId)}`;
  const mobile = normalizeMobileNumber(group.mobileNumber);
  return mobile ? `mobile:${mobile}` : group.identity;
}

function buildAnalytics(groups, vehicleMaps, customerMaps) {
  const users = new Map();
  const vehicles = new Map();
  let totalViews = 0;

  for (const group of groups) {
    const views = Number(group.views) || 0;
    totalViews += views;
    const profile = resolveCustomer(group, customerMaps);
    const identity = getIdentityKey(group, profile);
    let user = users.get(identity);
    if (!user) {
      user = {
        id: profile ? String(profile._id) : null,
        name: profile?.customerName || "",
        mobile: profile?.mobileNumber || group.mobileNumber || "",
        identifiable: Boolean(
          profile ||
          group.customerId ||
          normalizeMobileNumber(group.mobileNumber),
        ),
        views: 0,
        lastActivity: null,
        vehicleViews: new Map(),
        vehicleKeys: new Set(),
      };
      users.set(identity, user);
    }
    user.views += views;
    if (!user.mobile && group.mobileNumber) user.mobile = group.mobileNumber;
    if (!user.lastActivity || new Date(group.lastViewed) > user.lastActivity) {
      user.lastActivity = new Date(group.lastViewed);
    }

    const vehicle = getEventVehicle(group, vehicleMaps);
    if (!vehicle) continue;
    if (vehicle.id) user.vehicleKeys.add(vehicle.key);
    user.vehicleViews.set(
      vehicle.key,
      (user.vehicleViews.get(vehicle.key) || 0) + views,
    );
    let vehicleStats = vehicles.get(vehicle.key);
    if (!vehicleStats) {
      vehicleStats = {
        id: vehicle.id,
        name: vehicle.name,
        views: 0,
        viewers: new Map(),
        lastViewed: null,
      };
      vehicles.set(vehicle.key, vehicleStats);
    }
    vehicleStats.views += views;
    if (user.identifiable) {
      vehicleStats.viewers.set(identity, (vehicleStats.viewers.get(identity) || 0) + views);
    }
    if (!vehicleStats.lastViewed || new Date(group.lastViewed) > vehicleStats.lastViewed) {
      vehicleStats.lastViewed = new Date(group.lastViewed);
    }
  }

  return { users, vehicles, totalViews };
}

function summarizeVehicles(vehicleStats) {
  return [...vehicleStats.values()]
    .map((vehicle) => {
      const viewerCounts = [...vehicle.viewers.values()];
      return {
        id: vehicle.id,
        name: vehicle.name,
        totalViews: vehicle.views,
        uniqueViewers: vehicle.viewers.size,
        repeatViewers: viewerCounts.filter((views) => views > 1).length,
        lastViewed: vehicle.lastViewed,
      };
    })
    .sort((left, right) =>
      right.totalViews - left.totalViews ||
      String(left.name).localeCompare(String(right.name), "en-IN"),
    );
}

function summarizeLeaderboard(users, search, sortBy, page, limit) {
  const searchExpression = search ? new RegExp(escapeRegex(search), "i") : null;
  const data = [...users.values()]
    .filter((user) =>
      user.id &&
      (!searchExpression ||
        searchExpression.test(user.name) ||
        searchExpression.test(user.mobile)),
    )
    .sort((left, right) =>
      sortBy === "lastActivity"
        ? right.lastActivity - left.lastActivity || right.views - left.views
        : right.views - left.views || right.lastActivity - left.lastActivity,
    );
  const start = (page - 1) * limit;
  return {
    data: data.slice(start, start + limit).map((user, index) => {
      const mostViewedVehicle = [...user.vehicleViews.entries()]
        .sort((left, right) => right[1] - left[1])[0];
      return {
        rank: start + index + 1,
        id: user.id,
        name: user.name || "Name unavailable",
        mobile: user.mobile || "Mobile unavailable",
        totalViews: user.views,
        uniqueVehicles: user.vehicleKeys.size,
        mostViewedVehicle: mostViewedVehicle
          ? { views: mostViewedVehicle[1] }
          : null,
        lastActivity: user.lastActivity,
      };
    }),
    total: data.length,
    page,
    limit,
    totalPages: Math.ceil(data.length / limit),
  };
}

function attachMostViewedVehicle(leaderboard, vehicleStats) {
  const names = new Map(
    [...vehicleStats.entries()].map(([key, { name }]) => [key, name]),
  );
  return {
    ...leaderboard,
    data: leaderboard.data.map((user) => {
      if (!user.mostViewedVehicle) return user;
      const identity = `customer:${user.id}`;
      const source = [...vehicleStats.entries()]
        .map(([key, vehicle]) => [key, vehicle, vehicle.viewers.get(identity) || 0])
        .filter(([, , views]) => views > 0)
        .sort((left, right) => right[2] - left[2])[0];
      return {
        ...user,
        mostViewedVehicle: source
          ? { name: names.get(source[0]), views: source[2] }
          : null,
      };
    }),
  };
}

function parseSearch(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 100) {
    throw new ApiError(400, "search must be a string of at most 100 characters");
  }
  return value.trim();
}

export const getUserInterestAnalytics = async (req, res, next) => {
  try {
    const range = resolveIndiaDateRange(req.query);
    const page = parsePositiveInteger(req.query.page, "page", 1);
    const limit = parsePositiveInteger(req.query.limit, "limit", 20, MAX_LIMIT);
    const search = parseSearch(req.query.search);
    const sortBy = req.query.sortBy ?? "views";
    if (!["views", "lastActivity"].includes(sortBy)) {
      throw new ApiError(400, "sortBy must be views or lastActivity");
    }
    if (req.query.vehicleId !== undefined &&
      !mongoose.isObjectIdOrHexString(req.query.vehicleId)) {
      throw new ApiError(400, "vehicleId must be a valid vehicle ID");
    }

    const [availability, vehicleRecords] = await Promise.all([
      activityCollectionAvailability(),
      Vehicle.find({})
        .select("vehicleName displayName")
        .sort({ vehicleName: 1, _id: 1 })
        .lean(),
    ]);
    const vehicleMaps = buildVehicleMaps(vehicleRecords);
    const vehicleOptions = vehicleRecords.map((vehicle) => ({
      id: String(vehicle._id),
      name: getVehicleName(vehicle),
    }));
    const selectedVehicle = req.query.vehicleId
      ? vehicleMaps.byId.get(req.query.vehicleId)
      : null;
    if (req.query.vehicleId && !selectedVehicle) {
      throw new ApiError(404, "Vehicle not found");
    }

    if (availability.status !== "available") {
      res.set("Cache-Control", "private, no-store");
      return res.status(200).json({
        success: true,
        data: {
          availability,
          period: { from: range.from, to: range.to, timeZone: "Asia/Kolkata" },
          overview: null,
          leaderboard: { data: [], total: 0, page, limit, totalPages: 0 },
          vehicles: vehicleOptions,
          mostViewedVehicles: [],
          selectedVehicle: null,
        },
      });
    }

    const baseFilter = {
      action: "view_car",
      createdAt: { $gte: range.start, $lt: range.endExclusive },
    };
    const selectedFilter = selectedVehicle
      ? getSelectedVehicleFilter(selectedVehicle, vehicleMaps)
      : null;
    const selectedActivityFilter = selectedFilter
      ? { ...baseFilter, ...selectedFilter }
      : null;
    const [groups, selectedGroups, trend] = await Promise.all([
      loadViewGroups(baseFilter),
      selectedActivityFilter
        ? loadViewGroups(selectedActivityFilter)
        : Promise.resolve([]),
      selectedVehicle
        ? CustomerActivity.aggregate([
            { $match: selectedActivityFilter },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$createdAt",
                    timezone: "Asia/Kolkata",
                  },
                },
                views: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, date: "$_id", views: 1 } },
          ])
        : Promise.resolve([]),
    ]);
    const customerMaps = await resolveCustomerProfiles([...groups, ...selectedGroups]);
    const analytics = buildAnalytics(groups, vehicleMaps, customerMaps);
    const selectedAnalytics = buildAnalytics(
      selectedGroups,
      vehicleMaps,
      customerMaps,
    );
    const vehicleSummaries = summarizeVehicles(analytics.vehicles);
    const users = [...analytics.users.values()];
    const activeUsers = users.filter((user) => user.identifiable && user.views > 0).length;
    const repeatViewers = users.filter((user) => user.identifiable && user.views > 1).length;
    const leaderboardBase = summarizeLeaderboard(
      analytics.users,
      search,
      sortBy,
      page,
      limit,
    );
    const leaderboard = attachMostViewedVehicle(
      leaderboardBase,
      analytics.vehicles,
    );

    let selectedVehicleData = null;
    if (selectedVehicle) {
      const selectedVehicleSummaries = summarizeVehicles(selectedAnalytics.vehicles);
      const userRows = [...selectedAnalytics.users.entries()]
        .map(([identity, user]) => ({ identity, user }))
        .filter(({ user }) => user.id && user.views > 0)
        .sort((left, right) =>
          right.user.views - left.user.views ||
          right.user.lastActivity - left.user.lastActivity,
        );
      const selectedVehicleSummary = selectedVehicleSummaries[0] || {
        totalViews: 0,
        uniqueViewers: 0,
        repeatViewers: 0,
        lastViewed: null,
      };
      selectedVehicleData = {
        id: String(selectedVehicle._id),
        name: getVehicleName(selectedVehicle),
        metrics: selectedVehicleSummary,
        leaderboard: userRows.slice(0, 10).map(({ user }, index) => ({
          rank: index + 1,
          id: user.id,
          name: user.name || "Name unavailable",
          mobile: user.mobile || "Mobile unavailable",
          totalViews: user.views,
          lastActivity: user.lastActivity,
        })),
        trend,
      };
    }

    const availabilityStatus = analytics.totalViews > 0 ? "available" : "empty";
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({
      success: true,
      data: {
        availability: { status: availabilityStatus, reason: null },
        period: { from: range.from, to: range.to, timeZone: "Asia/Kolkata" },
        overview: {
          activeUsers,
          uniqueVehicleViewers: users.filter((user) => user.identifiable).length,
          totalViews: analytics.totalViews,
          uniqueVehicles: [...analytics.vehicles.values()]
            .filter((vehicle) => vehicle.id)
            .length,
          repeatViewers,
          mostViewedVehicle: vehicleSummaries[0] || null,
        },
        leaderboard,
        vehicles: vehicleOptions,
        mostViewedVehicles: vehicleSummaries.slice(0, 10),
        selectedVehicle: selectedVehicleData,
      },
    });
  } catch (error) {
    return next(error);
  }
};
