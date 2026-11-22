import mongoose from "mongoose";
import Booking from "../models/booking.model.js";
import Customer from "../models/customer.model.js";
import CustomerActivity from "../models/customerActivity.model.js";
import Lead from "../models/lead.model.js";
import LeadActivity from "../models/leadActivity.model.js";
import LeadHistory from "../models/leadHistory.model.js";
import User from "../models/user.model.js";
import Vehicle from "../models/vehicle.model.js";
import { INTENT_SCORING_CONFIG } from "../config/intentScoring.js";
import { computeIntentScore } from "../services/intentScoring.js";
import { normalizeMobileNumber } from "../services/membershipLookup.js";
import { currentIndiaDate, resolveIndiaDateRange, shiftIndiaDate } from "../utils/indiaDateRange.js";
import ApiError from "../utils/ApiError.js";

const ACTIONS = [
  "APP_OPENED",
  "trip_search",
  "search_query",
  "view_car",
  "select_dates",
  "apply_filter",
  "check_availability",
  "initiate_checkout",
];
const FUNNEL_ACTIVITY_ACTIONS = [
  ...ACTIONS,
  "AUTH_LOGIN",
  "AUTH_LOGOUT",
  "click_car",
  "select_location",
  "view_destination",
  "payment_started",
  "payment_success",
  "payment_failed",
  "payment_unconfirmed",
  "contact_support",
];
const FUNNEL_STAGE_ACTIONS = new Set([
  "APP_OPENED",
  "trip_search",
  "search_query",
  "view_car",
  "select_dates",
  "check_availability",
  "initiate_checkout",
]);
const CONFIRMED_BOOKING_STATUSES = [
  "confirmed",
  "handover_pending",
  "vehicle_handover",
  "active",
  "completed",
];
const CONVERSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const INTEREST_STATUSES = [
  "New",
  "Contacted",
  "Interested",
  "Follow-up Scheduled",
  "Converted",
  "Not Interested",
];
const MAX_PAGE_SIZE = 50;
const MAX_FUNNEL_SESSION_FILTERS = 2000;
const HISTORY_LIMIT = 100;
const SESSION_ATTRIBUTABLE_ACTIONS = [
  "select_dates",
  "apply_filter",
  "check_availability",
  "initiate_checkout",
];
const INDEX_OPTIONS = {
  unique: true,
  partialFilterExpression: {
    isCustomerInterestLead: true,
    customerId: { $type: "objectId" },
    isDeleted: false,
  },
  name: "unique_customer_interest_lead",
};

function companyIdFor(user) {
  const raw = user?.company || user?.createdBy || user?._id;
  const value = raw?._id || raw;
  return mongoose.isObjectIdOrHexString(value) ? new mongoose.Types.ObjectId(value) : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-IN") : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function vehicleLabel(vehicle) {
  return vehicle?.displayName?.trim() || vehicle?.vehicleName || "Vehicle unavailable";
}

function mobileForms(value) {
  const normalized = normalizeMobileNumber(value);
  if (!normalized) return [];
  return [normalized, `91${normalized}`, `+91${normalized}`, `0${normalized}`];
}

function isMongoAuthorizationError(error) {
  return error?.code === 13 ||
    error?.codeName === "Unauthorized" ||
    /not authorized|unauthorized/i.test(error?.message || "");
}

function isCollectionMissing(error) {
  return error?.code === 26 ||
    error?.codeName === "NamespaceNotFound" ||
    /collection .* does not exist|ns does not exist/i.test(error?.message || "");
}

async function activityAvailability() {
  try {
    const collections = await CustomerActivity.db.db
      .listCollections({ name: CustomerActivity.collection.name }, { nameOnly: true })
      .toArray();
    return collections.length
      ? { status: "available", reason: null }
      : { status: "unavailable", reason: "customer_activity_collection_missing" };
  } catch (error) {
    if (isMongoAuthorizationError(error)) {
      return { status: "denied", reason: "customer_activity_read_denied" };
    }
    throw error;
  }
}

function validDate(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseActivityDate(value) {
  const parsed = validDate(value);
  return parsed?.toISOString() || null;
}

function eventProjectionPipeline(
  start,
  endExclusive,
  actions = ACTIONS,
  requireIdentity = true,
  attributionFilters = null,
  extraMatch = null,
) {
  const match = {
    createdAt: { $gte: start, $lt: endExclusive },
    action: { $in: actions },
  };
  const and = [];
  if (requireIdentity) {
    and.push({
      $or: [
        { customerId: { $exists: true, $ne: null } },
        { mobileNumber: { $exists: true, $nin: ["", null] } },
      ],
    });
  }
  if (attributionFilters?.length) and.push({ $or: attributionFilters });
  if (extraMatch) and.push(extraMatch);
  if (and.length) match.$and = and;
  return [
    {
      $match: match,
    },
    {
      $project: {
        identityKey: {
          $cond: [
            { $ne: [{ $ifNull: ["$customerId", null] }, null] },
            { $concat: ["id:", { $toString: "$customerId" }] },
            {
              $concat: [
                "mobile:",
                {
                  $convert: {
                    input: "$mobileNumber",
                    to: "string",
                    onError: "",
                    onNull: "",
                  },
                },
              ],
            },
          ],
        },
        customerId: 1,
        mobileNumber: 1,
        action: 1,
        sessionId: {
          $convert: {
            input: "$sessionId",
            to: "string",
            onError: "",
            onNull: "",
          },
        },
        vehicleId: {
          $convert: { input: "$details.vehicleId", to: "string", onError: "", onNull: "" },
        },
        carId: {
          $convert: { input: "$details.carId", to: "string", onError: "", onNull: "" },
        },
        vehicleName: {
          $convert: { input: "$details.vehicleName", to: "string", onError: "", onNull: "" },
        },
        carName: {
          $convert: { input: "$details.carName", to: "string", onError: "", onNull: "" },
        },
        companyId: {
          $convert: {
            input: { $ifNull: ["$companyId", "$details.companyId"] },
            to: "string",
            onError: "",
            onNull: "",
          },
        },
        available: {
          $ifNull: ["$details.available", "$details.isAvailable"],
        },
        fromDate: {
          $ifNull: ["$details.fromDate", "$details.startDate"],
        },
        toDate: {
          $ifNull: ["$details.toDate", "$details.endDate"],
        },
        details: 1,
        createdAt: 1,
      },
    },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: {
          identityKey: "$identityKey",
          action: "$action",
          sessionId: "$sessionId",
          vehicleId: "$vehicleId",
          carId: "$carId",
          vehicleName: { $toLower: "$vehicleName" },
          carName: { $toLower: "$carName" },
          companyId: "$companyId",
        },
        customerId: { $last: "$customerId" },
        mobileNumber: { $last: "$mobileNumber" },
        count: { $sum: 1 },
        firstAt: { $min: "$createdAt" },
        lastAt: { $max: "$createdAt" },
        available: { $last: "$available" },
        unavailableCount: {
          $sum: { $cond: [{ $eq: ["$available", false] }, 1, 0] },
        },
        fromDate: { $last: "$fromDate" },
        toDate: { $last: "$toDate" },
        details: { $last: "$details" },
      },
    },
    { $sort: { lastAt: 1 } },
  ];
}

function vehicleContext(vehicles, allowedAliases) {
  const byId = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
  const aliases = new Map();
  for (const vehicle of vehicles) {
    for (const alias of [vehicle.vehicleName, vehicle.displayName]) {
      const key = normalizeText(alias);
      if (!key) continue;
      if (allowedAliases && !allowedAliases.has(key)) continue;
      const ids = aliases.get(key) || new Set();
      ids.add(String(vehicle._id));
      aliases.set(key, ids);
    }
  }
  return { byId, aliases };
}

function companyVehicleContext(vehicles) {
  return vehicleContext(vehicles);
}

function companyActivityAttributionFilters(companyId, context) {
  const companyValues = [companyId, String(companyId)];
  const filters = [
    { companyId: { $in: companyValues } },
    { "details.companyId": { $in: companyValues } },
  ];
  const ids = [...context.byId.keys()]
    .filter((id) => mongoose.isObjectIdOrHexString(id));
  if (ids.length) {
    const vehicleValues = [
      ...ids.map((id) => new mongoose.Types.ObjectId(id)),
      ...ids,
    ];
    filters.push(
      { "details.vehicleId": { $in: vehicleValues } },
      { "details.carId": { $in: vehicleValues } },
    );
  }
  const aliases = [...context.aliases.keys()];
  if (aliases.length) {
    const patterns = aliases.map((alias) =>
      new RegExp(`^${escapeRegex(alias)}$`, "i"),
    );
    filters.push(
      { "details.vehicleName": { $in: patterns } },
      { "details.carName": { $in: patterns } },
    );
  }
  return filters;
}

function companyViewSessionFilters(viewBuckets) {
  const filters = new Map();
  for (const bucket of viewBuckets) {
    const sessionId = bucket._id.sessionId;
    if (!sessionId) continue;
    const identity = [];
    if (bucket.customerId) identity.push({ customerId: bucket.customerId });
    const forms = mobileForms(bucket.mobileNumber);
    if (forms.length) identity.push({ mobileNumber: { $in: forms } });
    if (!identity.length) continue;
    const key = `${String(bucket.customerId || "")}:${forms[0] || ""}:${sessionId}`;
    if (!filters.has(key)) {
      filters.set(key, { sessionId, $or: identity });
    }
  }
  const values = [...filters.values()];
  return {
    filters: values.slice(0, MAX_FUNNEL_SESSION_FILTERS),
    truncated: values.length > MAX_FUNNEL_SESSION_FILTERS,
  };
}

async function loadSessionActivityBuckets(start, endExclusive, viewBuckets) {
  const sessionLookup = companyViewSessionFilters(viewBuckets);
  if (!sessionLookup.filters.length) {
    return { buckets: [], truncated: sessionLookup.truncated };
  }
  const buckets = await CustomerActivity.aggregate(
    eventProjectionPipeline(
      start,
      endExclusive,
      SESSION_ATTRIBUTABLE_ACTIONS,
      false,
      sessionLookup.filters,
      {
        $nor: [
          { companyId: { $exists: true, $nin: [null, ""] } },
          { "details.companyId": { $exists: true, $nin: [null, ""] } },
          { "details.vehicleId": { $exists: true, $nin: [null, ""] } },
          { "details.carId": { $exists: true, $nin: [null, ""] } },
          { "details.vehicleName": { $exists: true, $nin: [null, ""] } },
          { "details.carName": { $exists: true, $nin: [null, ""] } },
        ],
      },
    ),
  ).allowDiskUse(true);
  return { buckets, truncated: sessionLookup.truncated };
}

function resolveCompanyVehicle(bucket, context) {
  const key = bucket?._id || {};
  for (const rawId of [key.vehicleId, key.carId]) {
    if (rawId && context.byId.has(rawId)) return context.byId.get(rawId);
  }
  const matches = new Set();
  for (const name of [key.vehicleName, key.carName]) {
    const alias = normalizeText(name);
    for (const id of context.aliases.get(alias) || []) matches.add(id);
  }
  return matches.size === 1 ? context.byId.get([...matches][0]) : null;
}

function mapCustomer(bucket, profilesById, profilesByMobile) {
  const id = bucket.customerId ? String(bucket.customerId) : "";
  if (id && profilesById.has(id)) return profilesById.get(id);
  const mobile = normalizeMobileNumber(bucket.mobileNumber);
  const matches = mobile ? profilesByMobile.get(mobile) : null;
  return matches?.length === 1 ? matches[0] : null;
}

function makeUserState(customer) {
  return {
    customer,
    actions: new Map(),
    lastActionAt: new Map(),
    viewsByVehicle: new Map(),
    sessionsByVehicle: new Map(),
    lastActivity: null,
    lastSelectedDates: null,
    unavailableVehicle: null,
    companyAvailabilityChecks: 0,
  };
}

function updateLatest(current, candidate) {
  if (!candidate) return current;
  if (!current || candidate.getTime() > current.getTime()) return candidate;
  return current;
}

function buildRecommendations(state, hasAnyConfirmedBooking, checkoutConverted) {
  const recommendations = [];
  const viewCounts = [...state.viewsByVehicle.values()]
    .sort((left, right) => right.views - left.views);
  const topVehicle = viewCounts[0]?.vehicle;
  const hasCheckout = (state.actions.get("initiate_checkout") || 0) > 0;
  const hasDateSelection = (state.actions.get("select_dates") || 0) > 0;

  if (state.repeatedVehicleSession && !hasAnyConfirmedBooking) {
    recommendations.push({
      key: "repeat_view_no_booking",
      text: `Viewed ${topVehicle ? vehicleLabel(topVehicle) : "a vehicle"} in more than one session; no confirmed customer-app booking was found.`,
    });
  }
  if (hasDateSelection && !hasCheckout) {
    recommendations.push({
      key: "dates_without_checkout",
      text: "Selected rental dates without a tracked checkout start.",
    });
  }
  if (hasCheckout && !checkoutConverted) {
    recommendations.push({
      key: "checkout_without_booking",
      text: "Started checkout; no confirmed customer-app booking was found.",
    });
  }
  if (state.unavailableVehicle && !hasAnyConfirmedBooking) {
    recommendations.push({
      key: "vehicle_unavailable",
      text: `Availability activity reported ${vehicleLabel(state.unavailableVehicle)} as unavailable.`,
    });
  }
  return recommendations;
}

function makeFunnelActivities(buckets, profilesById, profilesByMobile, context, companyId) {
  const activities = buckets.map((bucket) => {
    const vehicle = resolveCompanyVehicle(bucket, context);
    const rawCompanyId = bucket._id.companyId;
    const explicitCompany = rawCompanyId === String(companyId);
    const conflictingCompany = Boolean(rawCompanyId && !explicitCompany);
    const customer = mapCustomer(bucket, profilesById, profilesByMobile);
    return {
      action: bucket._id.action,
      count: bucket.count,
      customerId: customer ? String(customer._id) : null,
      sessionId: bucket._id.sessionId,
      vehicleId: vehicle ? String(vehicle._id) : null,
      firstAt: validDate(bucket.firstAt),
      lastAt: validDate(bucket.lastAt),
      fromDate: bucket.fromDate,
      toDate: bucket.toDate,
      available: bucket.available,
      unavailableCount: bucket.unavailableCount || 0,
      identityPresent: Boolean(bucket.customerId || normalizeMobileNumber(bucket.mobileNumber)),
      directlyAttributed: !conflictingCompany && (Boolean(vehicle) || explicitCompany),
      companyContextOnly: explicitCompany && !vehicle,
    };
  });

  const viewsBySession = new Map();
  for (const activity of activities) {
    if (
      activity.action !== "view_car" ||
      !activity.customerId ||
      !activity.sessionId ||
      !activity.vehicleId
    ) continue;
    const key = `${activity.customerId}:${activity.sessionId}`;
    const current = viewsBySession.get(key) || { vehicles: new Set(), firstAt: null };
    current.vehicles.add(activity.vehicleId);
    if (activity.firstAt && (!current.firstAt || activity.firstAt < current.firstAt)) {
      current.firstAt = activity.firstAt;
    }
    viewsBySession.set(key, current);
  }

  return activities.flatMap((activity) => {
    if (activity.directlyAttributed) return [activity];
    if (
      !activity.customerId ||
      !activity.sessionId ||
      !SESSION_ATTRIBUTABLE_ACTIONS.includes(activity.action)
    ) return [];
    const session = viewsBySession.get(`${activity.customerId}:${activity.sessionId}`);
    const attributedAt = activity.firstAt > session?.firstAt
      ? activity.firstAt
      : activity.lastAt;
    if (
      !session ||
      session.vehicles.size !== 1 ||
      !session.firstAt ||
      !attributedAt ||
      attributedAt < session.firstAt
    ) return [];
    return [{
      ...activity,
      firstAt: attributedAt,
      vehicleId: [...session.vehicles][0],
      sessionAttributed: true,
    }];
  });
}

function firstActionAfter(events, action, previousAt, deadline) {
  let first = null;
  for (const event of events) {
    if (event.action !== action || !event.firstAt || !event.lastAt) continue;
    const at = event.firstAt > previousAt
      ? event.firstAt
      : event.lastAt > previousAt
        ? event.lastAt
        : null;
    if (at && at <= deadline && (!first || at < first)) first = at;
  }
  return first;
}

function makeFunnel(activities, confirmedBookings, period, sessionLookupTruncated = false) {
  const stageDefinitions = [
    { key: "appOpen", label: "App Open", actions: ["APP_OPENED"], unattributableByDefault: true },
    { key: "search", label: "Search", actions: ["trip_search", "search_query"], unattributableByDefault: true },
    { key: "vehicleView", label: "Vehicle View", actions: ["view_car"] },
    { key: "dateSelection", label: "Date Selection", actions: ["select_dates"] },
    { key: "availabilityCheck", label: "Availability Check", actions: ["check_availability"] },
    { key: "checkoutStarted", label: "Checkout Started", actions: ["initiate_checkout"] },
    { key: "bookingConfirmed", label: "Booking Confirmed", actions: [] },
  ];
  const usersByStage = new Map();
  const eventsByStage = new Map();
  const observedActions = new Set();

  for (const activity of activities) {
    observedActions.add(activity.action);
    for (const definition of stageDefinitions) {
      if (!definition.actions.includes(activity.action)) continue;
      const users = usersByStage.get(definition.key) || new Set();
      if (activity.customerId) users.add(activity.customerId);
      usersByStage.set(definition.key, users);
      eventsByStage.set(
        definition.key,
        (eventsByStage.get(definition.key) || 0) + activity.count,
      );
    }
  }

  const confirmedUsers = new Set(
    confirmedBookings.map(({ customerId }) => customerId).filter(Boolean),
  );
  const activityStages = stageDefinitions.map((definition) => {
    if (definition.key === "bookingConfirmed") {
      const identified = confirmedBookings.length === 0 || confirmedUsers.size > 0;
      return {
        key: definition.key,
        label: definition.label,
        status: identified ? "available" : "identity_unavailable",
        uniqueUsers: identified ? confirmedUsers.size : null,
        records: confirmedBookings.length,
        conversionRate: null,
        dropOff: null,
      };
    }

    const eventCount = eventsByStage.get(definition.key) || 0;
    const users = usersByStage.get(definition.key) || new Set();
    let status = "unobserved";
    let uniqueUsers = null;
    if (eventCount > 0 && users.size > 0) {
      status = "available";
      uniqueUsers = users.size;
    } else if (eventCount > 0) {
      status = "identity_unavailable";
    } else if (definition.unattributableByDefault) {
      status = "not_attributable";
    }
    return {
      key: definition.key,
      label: definition.label,
      status,
      uniqueUsers,
      records: eventCount,
      conversionRate: null,
      dropOff: null,
    };
  });

  const sequenceTracks = new Map();
  for (const activity of activities) {
    if (!activity.customerId || !activity.vehicleId) continue;
    const key = `${activity.customerId}:${activity.vehicleId}`;
    const events = sequenceTracks.get(key) || [];
    events.push(activity);
    sequenceTracks.set(key, events);
  }
  const reachedUsers = new Map([
    ["vehicleView", new Set()],
    ["dateSelection", new Set()],
    ["availabilityCheck", new Set()],
    ["checkoutStarted", new Set()],
    ["bookingConfirmed", new Set()],
  ]);
  const matchedCheckoutKeys = new Set();
  for (const booking of confirmedBookings) {
    if (!booking.customerId || !booking.vehicleId || !booking.createdAt) continue;
    const checkoutAt = firstActionAfter(
      activities.filter((activity) =>
        activity.customerId === booking.customerId &&
        activity.vehicleId === booking.vehicleId,
      ),
      "initiate_checkout",
      new Date(booking.createdAt.getTime() - CONVERSION_WINDOW_MS),
      booking.createdAt,
    );
    if (checkoutAt && checkoutAt < booking.createdAt) {
      matchedCheckoutKeys.add(String(booking.id));
    }
  }
  for (const [trackKey, events] of sequenceTracks) {
    const [customerId, vehicleId] = trackKey.split(":");
    const vehicleViews = events
      .filter(({ action, firstAt }) => action === "view_car" && firstAt)
      .sort((left, right) => left.firstAt - right.firstAt);
    const entryAt = vehicleViews[0]?.firstAt;
    if (!entryAt) continue;
    reachedUsers.get("vehicleView").add(customerId);
    const deadline = new Date(entryAt.getTime() + CONVERSION_WINDOW_MS);
    const datesAt = firstActionAfter(events, "select_dates", entryAt, deadline);
    if (!datesAt) continue;
    reachedUsers.get("dateSelection").add(customerId);
    const availabilityAt = firstActionAfter(events, "check_availability", datesAt, deadline);
    if (!availabilityAt) continue;
    reachedUsers.get("availabilityCheck").add(customerId);
    const checkoutAt = firstActionAfter(events, "initiate_checkout", availabilityAt, deadline);
    if (!checkoutAt) continue;
    reachedUsers.get("checkoutStarted").add(customerId);

    const linkedBooking = confirmedBookings.find((booking) =>
      booking.customerId === customerId &&
      String(booking.vehicleId || "") === vehicleId &&
      booking.createdAt > checkoutAt &&
      booking.createdAt <= deadline,
    );
    if (linkedBooking) {
      reachedUsers.get("bookingConfirmed").add(customerId);
    }
  }

  const sequentialDefinitions = [
    { key: "appOpen", label: "App Open", sourceKey: "appOpen", statusOverride: "not_attributable" },
    { key: "search", label: "Search", sourceKey: "search", statusOverride: "not_attributable" },
    { key: "vehicleView", label: "Vehicle View", sourceKey: "vehicleView", userKey: "vehicleView" },
    { key: "dateSelection", label: "Date Selection", sourceKey: "dateSelection", userKey: "dateSelection" },
    { key: "availabilityCheck", label: "Availability Check", sourceKey: "availabilityCheck", userKey: "availabilityCheck" },
    { key: "checkoutStarted", label: "Checkout Started", sourceKey: "checkoutStarted", userKey: "checkoutStarted" },
    { key: "bookingConfirmed", label: "Booking Confirmed", sourceKey: "bookingConfirmed", userKey: "bookingConfirmed" },
  ];
  const sequenceActions = {
    vehicleView: ["view_car"],
    dateSelection: ["select_dates"],
    availabilityCheck: ["check_availability"],
    checkoutStarted: ["initiate_checkout"],
  };
  let previousUsers = null;
  let sequenceBlocked = false;
  const sequentialStages = sequentialDefinitions.map((definition) => {
    if (definition.statusOverride) {
      return {
        key: definition.key,
        label: definition.label,
        status: definition.statusOverride,
        uniqueUsers: null,
        conversionRate: null,
        dropOff: null,
      };
    }

    const activitySource = activityStages.find(({ key }) => key === definition.sourceKey);
    const sourceObserved = definition.key === "bookingConfirmed"
      ? confirmedBookings.length === 0 ||
        confirmedBookings.every((booking) => booking.customerId && booking.vehicleId)
      : (sequenceActions[definition.key] || []).some((action) =>
          activities.some((activity) =>
            activity.action === action && activity.customerId && activity.vehicleId,
          ),
        ) && activitySource?.status === "available";
    if (!sourceObserved || sequenceBlocked) {
      sequenceBlocked = true;
      return {
        key: definition.key,
        label: definition.label,
        status: "insufficient_tracking_data",
        uniqueUsers: null,
        conversionRate: null,
        dropOff: null,
      };
    }

    const users = reachedUsers.get(definition.userKey);
    const count = users.size;
    const conversionRate = previousUsers > 0
      ? Math.round((count / previousUsers) * 10000) / 100
      : null;
    const result = {
      key: definition.key,
      label: definition.label,
      status: "available",
      uniqueUsers: count,
      conversionRate,
      dropOff: conversionRate === null ? null : Math.round((100 - conversionRate) * 100) / 100,
    };
    previousUsers = count;
    return result;
  });

  const eventTypeCounts = new Map();
  let attributedEventCount = 0;
  let eventsMissingUserId = 0;
  for (const activity of activities) {
    eventTypeCounts.set(
      activity.action,
      (eventTypeCounts.get(activity.action) || 0) + activity.count,
    );
    attributedEventCount += activity.count;
    if (!activity.identityPresent) eventsMissingUserId += activity.count;
  }
  const unmatchedConfirmedBookings = confirmedBookings.filter(({ id }) =>
    !matchedCheckoutKeys.has(String(id)),
  );
  const eventTypes = [...eventTypeCounts]
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((left, right) => right.count - left.count || left.eventType.localeCompare(right.eventType));
  const unmappedEventTypes = eventTypes
    .filter(({ eventType }) => !FUNNEL_STAGE_ACTIONS.has(eventType));

  return {
    availability: {
      status: activities.length || confirmedBookings.length ? "available" : "insufficient_tracking_data",
    },
    scope: "events_attributed_to_company_vehicles_or_explicit_company_context",
    period,
    entryEvent: "Vehicle View",
    progression: "Customer-and-vehicle based; stages must occur in timestamp order within seven days. Explicit vehicle events can progress across sessions; context-only events are associated only within the same session.",
    note: "App Open and Search events without explicit company context are not attributable and are excluded. Date selection, availability, and checkout events are attributed by explicit company vehicle details or a later event in the same session after a single company vehicle view. No event is attributed from an unrelated later vehicle view.",
    conversionWindowDays: 7,
    stages: activityStages,
    sequential: {
      status: sequentialStages.some(({ status }) => status === "insufficient_tracking_data")
        ? "insufficient_tracking_data"
        : "available",
      stages: sequentialStages,
    },
    diagnostics: {
      generatedAt: new Date().toISOString(),
      attributableEventCount: attributedEventCount,
      eventTypes,
      unmappedEventTypes,
      eventsMissingUserId,
      eventsMissingCompanyAttribution: null,
      eventsMissingCompanyAttributionStatus: "not_measurable_from_tenant_scope",
      companyAttributionNote: "A tenant-specific count for legacy events without vehicle or company context cannot be measured safely; those records are excluded rather than assigned to a company.",
      sessionLookupTruncated,
      checkoutEventsFound: eventTypeCounts.get("initiate_checkout") || 0,
      confirmedBookingsFound: confirmedBookings.length,
      confirmedBookingsWithTrackedCheckout: confirmedBookings.length - unmatchedConfirmedBookings.length,
      confirmedBookingsWithoutTrackedCheckout: unmatchedConfirmedBookings.length,
      confirmedBookingRecords: confirmedBookings.length,
    },
  };
}

function parsePagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new ApiError(400, "page must be a positive integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ApiError(400, `limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return { page, limit };
}

function followUpSummary(lead) {
  return lead
    ? {
        id: String(lead._id),
        status: lead.interestStatus || "New",
        assignedTo: lead.interestAssignedTo
          ? {
              id: String(lead.interestAssignedTo._id || lead.interestAssignedTo),
              name: lead.interestAssignedTo.fullName || "Staff member",
            }
          : null,
        nextFollowupDate: lead.interestNextFollowupDate || null,
      }
    : null;
}

function formatLeadHistory(change) {
  if (change.action === "created") return "Smart Lead follow-up started";
  if (change.field === "interestStatus") {
    return `Lead status changed to ${change.newValue || "New"}`;
  }
  if (change.field === "interestAssignedTo") {
    return change.newValue ? "Staff assignment updated" : "Staff assignment cleared";
  }
  if (change.field === "interestNextFollowupDate") {
    const date = change.newValue ? validDate(change.newValue) : null;
    return date
      ? `Follow-up scheduled for ${date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
      : "Follow-up schedule cleared";
  }
  return `${change.field} updated`;
}

async function ensureInterestLeadIndex() {
  await Lead.collection.createIndex(
    { company: 1, customerId: 1 },
    INDEX_OPTIONS,
  );
}

async function loadCompanyViewContext(customer, vehicles, start) {
  if (!vehicles.length) return null;
  const context = vehicleContext(vehicles);
  const vehicleIds = [...context.byId.keys()]
    .filter((id) => mongoose.isObjectIdOrHexString(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const uniqueVehicleIds = new Set(
    [...context.aliases.values()]
      .filter((ids) => ids.size === 1)
      .map((ids) => [...ids][0]),
  );
  const names = vehicles
    .filter((vehicle) => uniqueVehicleIds.has(String(vehicle._id)))
    .flatMap((vehicle) => [vehicle.vehicleName, vehicle.displayName])
    .filter((name) => typeof name === "string" && name.trim());
  const namePatterns = names.map((name) =>
    new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
  );
  const identity = [{ customerId: customer._id }];
  const customerMobileForms = mobileForms(customer.mobileNumber);
  if (customerMobileForms.length) {
    const matchingCustomers = await Customer.find({
      mobileNumber: { $in: customerMobileForms },
    })
      .select("_id")
      .limit(2)
      .lean();
    if (
      matchingCustomers.length === 1 &&
      String(matchingCustomers[0]._id) === String(customer._id)
    ) {
      identity.push({ mobileNumber: { $in: customerMobileForms } });
    }
  }
  const vehicleConditions = [
    { "details.vehicleId": { $in: vehicleIds } },
    { "details.carId": { $in: vehicleIds } },
    ...(namePatterns.length
      ? [
          { "details.carName": { $in: namePatterns } },
          { "details.vehicleName": { $in: namePatterns } },
        ]
      : []),
  ];
  const event = await CustomerActivity.findOne({
    action: "view_car",
    createdAt: { $gte: start },
    $and: [
      { $or: identity },
      { $or: vehicleConditions },
    ],
  })
    .sort({ createdAt: -1 })
    .select("details createdAt")
    .lean();
  if (!event) return null;
  const bucket = {
    _id: {
      vehicleId: String(event.details?.vehicleId || event.details?.carId || ""),
      vehicleName: String(event.details?.vehicleName || event.details?.carName || ""),
    },
  };
  return resolveCompanyVehicle(bucket, context)
    ? { event, context }
    : null;
}

export async function getSmartLeadInsights(req, res, next) {
  try {
    const companyId = companyIdFor(req.user);
    if (!companyId) throw new ApiError(403, "Company scope could not be verified");
    const { page, limit } = parsePagination(req.query);
    const search = typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 100)
      : "";
    const today = currentIndiaDate();
    const from = shiftIndiaDate(today, -(INTENT_SCORING_CONFIG.windowDays - 1));
    const range = resolveIndiaDateRange({ from, to: today });
    const funnelRange = resolveIndiaDateRange(
      req.query.from === undefined && req.query.to === undefined
        ? { from, to: today }
        : req.query,
    );
    const funnelRangeDays = (funnelRange.endExclusive.getTime() - funnelRange.start.getTime()) /
      (24 * 60 * 60 * 1000);
    if (funnelRangeDays > 366) {
      throw new ApiError(400, "Funnel date range cannot exceed 366 days");
    }
    const sourceAvailability = await activityAvailability();
    const period = {
      from,
      to: today,
      timeZone: "Asia/Kolkata",
      scoringWindowDays: INTENT_SCORING_CONFIG.windowDays,
    };
    const funnelPeriod = {
      from: funnelRange.from,
      to: funnelRange.to,
      timeZone: "Asia/Kolkata",
      conversionWindowDays: 7,
    };
    const funnelBookingRows = await Booking.find({
      company: companyId,
      bookingSource: "customer_app",
      isDeleted: { $ne: true },
      status: { $in: CONFIRMED_BOOKING_STATUSES },
      createdAt: { $gte: funnelRange.start, $lt: funnelRange.endExclusive },
    })
      .select("mobileNumber status createdAt vehicleId")
      .lean();
    if (sourceAvailability.status !== "available") {
      const bookingForms = [...new Set(
        funnelBookingRows.flatMap((booking) => mobileForms(booking.mobileNumber)),
      )];
      const bookingProfiles = bookingForms.length
        ? await Customer.find({ mobileNumber: { $in: bookingForms } })
            .select("_id mobileNumber")
            .lean()
        : [];
      const profilesByMobile = new Map();
      for (const profile of bookingProfiles) {
        const mobile = normalizeMobileNumber(profile.mobileNumber);
        if (!mobile) continue;
        const matches = profilesByMobile.get(mobile) || [];
        matches.push(profile);
        profilesByMobile.set(mobile, matches);
      }
      const funnelConfirmedBookings = funnelBookingRows.map((booking) => {
        const mobile = normalizeMobileNumber(booking.mobileNumber);
        const matches = mobile ? profilesByMobile.get(mobile) : null;
        return {
          id: String(booking._id),
          customerId: matches?.length === 1 ? String(matches[0]._id) : null,
          vehicleId: booking.vehicleId ? String(booking.vehicleId) : null,
          createdAt: validDate(booking.createdAt),
        };
      });
      const funnel = makeFunnel([], funnelConfirmedBookings, funnelPeriod);
      return res.status(200).json({
        success: true,
        data: {
          availability: sourceAvailability,
          period,
          hotLeads: {
            data: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
            diagnostics: {
              activityStatus: sourceAvailability.status,
              companyAttributableActivityEvents: null,
              companyVehicleViewEvents: null,
              identifiableVehicleViewers: null,
              hotLeadCandidates: null,
              sessionLookupTruncated: false,
            },
          },
          funnel: {
            ...funnel,
            activityAvailability: sourceAvailability,
          },
        },
      });
    }

    const vehicles = await Vehicle.find({ company: companyId, isDeleted: { $ne: true } })
      .select("_id vehicleName displayName category")
      .lean();
    const context = companyVehicleContext(vehicles);
    const companyAttributionFilters = companyActivityAttributionFilters(companyId, context);
    const [leadDirectBuckets, directFunnelBuckets] = await Promise.all([
      CustomerActivity.aggregate(
        eventProjectionPipeline(
          range.start,
          range.endExclusive,
          ACTIONS,
          true,
          companyAttributionFilters,
        ),
      ).allowDiskUse(true),
      CustomerActivity.aggregate(
        eventProjectionPipeline(
          funnelRange.start,
          funnelRange.endExclusive,
          FUNNEL_ACTIVITY_ACTIONS,
          false,
          companyAttributionFilters,
        ),
      ).allowDiskUse(true),
    ]);
    const leadCompanyViews = leadDirectBuckets.filter((bucket) =>
      bucket._id.action === "view_car" && resolveCompanyVehicle(bucket, context),
    );
    const funnelCompanyViews = directFunnelBuckets.filter((bucket) =>
      bucket._id.action === "view_car" && resolveCompanyVehicle(bucket, context),
    );
    const [leadSessionResult, funnelSessionResult] = await Promise.all([
      loadSessionActivityBuckets(range.start, range.endExclusive, leadCompanyViews),
      loadSessionActivityBuckets(
        funnelRange.start,
        funnelRange.endExclusive,
        funnelCompanyViews,
      ),
    ]);
    const leadBuckets = [...leadDirectBuckets, ...leadSessionResult.buckets];
    const funnelBuckets = [...directFunnelBuckets, ...funnelSessionResult.buckets];
    const sessionLookupTruncated =
      leadSessionResult.truncated || funnelSessionResult.truncated;
    const customerActivityBuckets = [...leadBuckets, ...funnelBuckets];
    const customerIds = [...new Set(
      customerActivityBuckets
        .map((bucket) => bucket.customerId)
        .filter((id) => mongoose.isObjectIdOrHexString(id))
        .map(String),
    )].map((id) => new mongoose.Types.ObjectId(id));
    const mobileLookupForms = [...new Set(
      [
        ...customerActivityBuckets.flatMap((bucket) => mobileForms(bucket.mobileNumber)),
        ...funnelBookingRows.flatMap((booking) => mobileForms(booking.mobileNumber)),
      ],
    )];
    const profiles = customerIds.length || mobileLookupForms.length
      ? await Customer.find({
          $or: [
            ...(customerIds.length ? [{ _id: { $in: customerIds } }] : []),
            ...(mobileLookupForms.length ? [{ mobileNumber: { $in: mobileLookupForms } }] : []),
          ],
        })
          .select("_id customerName mobileNumber")
          .lean()
      : [];
    const profilesById = new Map(profiles.map((profile) => [String(profile._id), profile]));
    const profilesByMobile = new Map();
    for (const profile of profiles) {
      const mobile = normalizeMobileNumber(profile.mobileNumber);
      if (!mobile) continue;
      const matches = profilesByMobile.get(mobile) || [];
      matches.push(profile);
      profilesByMobile.set(mobile, matches);
    }

    const leadActivities = makeFunnelActivities(
      leadBuckets,
      profilesById,
      profilesByMobile,
      context,
      companyId,
    );
    const states = new Map();
    const companyInterestIds = new Set();
    const now = new Date();
    const last24Hours = now.getTime() - 24 * 60 * 60 * 1000;
    for (const activity of leadActivities) {
      if (!activity.customerId) continue;
      const customer = profilesById.get(activity.customerId);
      if (!customer) continue;
      const action = activity.action;
      const customerId = String(customer._id);
      let state = states.get(customerId);
      if (!state) {
        state = makeUserState(customer);
        states.set(customerId, state);
      }
      state.actions.set(action, (state.actions.get(action) || 0) + activity.count);
      state.lastActionAt.set(
        action,
        updateLatest(state.lastActionAt.get(action), activity.lastAt),
      );
      state.lastActivity = updateLatest(state.lastActivity, activity.lastAt);
      if (action === "select_dates") {
        state.lastSelectedDates = {
          from: parseActivityDate(activity.fromDate),
          to: parseActivityDate(activity.toDate),
          at: activity.lastAt,
        };
      }
      const vehicle = activity.vehicleId
        ? context.byId.get(activity.vehicleId)
        : null;
      if (action === "check_availability") {
        state.companyAvailabilityChecks += activity.count;
        if (vehicle && activity.unavailableCount > 0) state.unavailableVehicle = vehicle;
      }
      if (action !== "view_car" || !vehicle) continue;
      companyInterestIds.add(customerId);
      const vehicleId = String(vehicle._id);
      const viewRecord = state.viewsByVehicle.get(vehicleId) || {
        vehicle,
        views: 0,
        lastViewed: null,
      };
      viewRecord.views += activity.count;
      viewRecord.lastViewed = updateLatest(viewRecord.lastViewed, activity.lastAt);
      state.viewsByVehicle.set(vehicleId, viewRecord);
      if (activity.sessionId) {
        const sessions = state.sessionsByVehicle.get(vehicleId) || new Set();
        sessions.add(activity.sessionId);
        state.sessionsByVehicle.set(vehicleId, sessions);
      }
    }
    for (const customerId of companyInterestIds) {
      const state = states.get(customerId);
      state.repeatedVehicleSession = [...state.sessionsByVehicle.values()]
        .some((sessions) => sessions.size > 1);
      state.totalVehicleViews = [...state.viewsByVehicle.values()]
        .reduce((total, view) => total + view.views, 0);
      state.lastVehicleActivityWithin24Hours = Boolean(
        state.lastActivity && state.lastActivity.getTime() >= last24Hours,
      );
    }
    const leadActivityEventCount = leadActivities.reduce(
      (total, activity) => total + activity.count,
      0,
    );
    const companyVehicleViewEvents = leadActivities.reduce(
      (total, activity) =>
        total + (activity.action === "view_car" && activity.vehicleId ? activity.count : 0),
      0,
    );

    const candidateMobiles = [...new Set(
      [...companyInterestIds]
        .map((id) => normalizeMobileNumber(states.get(id)?.customer.mobileNumber))
        .filter(Boolean),
    )];
    const bookingForms = [...new Set(candidateMobiles.flatMap(mobileForms))];
    const bookings = bookingForms.length
      ? await Booking.find({
          company: companyId,
          bookingSource: "customer_app",
          isDeleted: { $ne: true },
          mobileNumber: { $in: bookingForms },
        })
          .select("mobileNumber status createdAt vehicleId")
          .sort({ createdAt: -1 })
          .lean()
      : [];
    const funnelActivities = makeFunnelActivities(
      funnelBuckets,
      profilesById,
      profilesByMobile,
      context,
      companyId,
    );
    const bookingByMobile = new Map();
    const checkoutConfirmedIds = new Set();
    for (const booking of bookings) {
      const mobile = normalizeMobileNumber(booking.mobileNumber);
      const matches = mobile ? profilesByMobile.get(mobile) : null;
      if (!matches || matches.length !== 1) continue;
      const customerId = String(matches[0]._id);
      const bookingCreatedAt = validDate(booking.createdAt);
      if (
        CONFIRMED_BOOKING_STATUSES.includes(booking.status) &&
        bookingCreatedAt &&
        bookingCreatedAt >= range.start &&
        bookingCreatedAt < range.endExclusive
      ) {
        const state = states.get(customerId);
        const checkoutAt = state?.lastActionAt.get("initiate_checkout");
        const bookingVehicleMatches = !booking.vehicleId ||
          state?.viewsByVehicle.has(String(booking.vehicleId));
        if (
          checkoutAt &&
          bookingCreatedAt > checkoutAt &&
          bookingCreatedAt <= checkoutAt.getTime() + CONVERSION_WINDOW_MS &&
          bookingVehicleMatches
        ) {
          checkoutConfirmedIds.add(customerId);
        }
      }
      const latest = bookingByMobile.get(mobile);
      if (!latest || new Date(booking.createdAt) > new Date(latest.createdAt)) {
        bookingByMobile.set(mobile, booking);
      }
    }
    const confirmedBookingIds = new Set();
    for (const [mobile, booking] of bookingByMobile) {
      if (!CONFIRMED_BOOKING_STATUSES.includes(booking.status)) continue;
      const customerId = profilesByMobile.get(mobile)?.[0]?._id;
      if (!customerId) continue;
      const id = String(customerId);
      confirmedBookingIds.add(id);
    }
    const funnelConfirmedBookings = funnelBookingRows.map((booking) => {
      const mobile = normalizeMobileNumber(booking.mobileNumber);
      const matches = mobile ? profilesByMobile.get(mobile) : null;
      return {
        id: String(booking._id),
        customerId: matches?.length === 1 ? String(matches[0]._id) : null,
        vehicleId: booking.vehicleId ? String(booking.vehicleId) : null,
        createdAt: validDate(booking.createdAt),
      };
    });

    const scoredLeads = [...companyInterestIds].map((customerId) => {
      const state = states.get(customerId);
      const mobile = normalizeMobileNumber(state.customer.mobileNumber);
      const booking = mobile ? bookingByMobile.get(mobile) : null;
      const score = computeIntentScore({
        vehicleViews: state.totalVehicleViews,
        repeatVehicleSession: state.repeatedVehicleSession,
        selectedRentalDates: (state.actions.get("select_dates") || 0) > 0,
        appliedSearchFilters: (state.actions.get("apply_filter") || 0) > 0,
        checkedAvailability: state.companyAvailabilityChecks > 0,
        startedCheckout: (state.actions.get("initiate_checkout") || 0) > 0,
        activeLast24Hours: state.lastVehicleActivityWithin24Hours,
      });
      const viewsByVehicle = [...state.viewsByVehicle.values()]
        .sort((left, right) => right.views - left.views);
      const hasConfirmedBooking = confirmedBookingIds.has(customerId);
      const checkoutConverted = checkoutConfirmedIds.has(customerId);
      return {
        id: customerId,
        name: state.customer.customerName || "Name unavailable",
        mobile: state.customer.mobileNumber || null,
        ...score,
        totalVehicleViews: state.totalVehicleViews,
        uniqueVehicles: state.viewsByVehicle.size,
        mostViewedVehicle: viewsByVehicle[0]
          ? {
              id: String(viewsByVehicle[0].vehicle._id),
              name: vehicleLabel(viewsByVehicle[0].vehicle),
              views: viewsByVehicle[0].views,
            }
          : null,
        interestedVehicles: viewsByVehicle.slice(0, 3).map(({ vehicle, views }) => ({
          id: String(vehicle._id),
          name: vehicleLabel(vehicle),
          views,
        })),
        selectedDates: state.lastSelectedDates
          ? {
              from: state.lastSelectedDates.from,
              to: state.lastSelectedDates.to,
            }
          : null,
        lastActivity: state.lastActivity,
        bookingStatus: booking?.status || "No customer-app booking",
        recommendations: buildRecommendations(
          state,
          hasConfirmedBooking,
          checkoutConverted,
        ),
      };
    }).filter((lead) =>
      lead.score >= INTENT_SCORING_CONFIG.hotThreshold &&
      Boolean(normalizeMobileNumber(lead.mobile)),
    );

    const filteredLeads = scoredLeads
      .filter((lead) => {
        if (!search) return true;
        const query = search.toLocaleLowerCase("en-IN");
        return lead.name.toLocaleLowerCase("en-IN").includes(query) ||
          String(lead.mobile || "").includes(search);
      })
      .sort((left, right) =>
        right.score - left.score ||
        new Date(right.lastActivity || 0).getTime() - new Date(left.lastActivity || 0).getTime(),
      );
    const total = filteredLeads.length;
    const pagedLeads = filteredLeads.slice((page - 1) * limit, page * limit);
    const leadIds = pagedLeads.map(({ id }) => new mongoose.Types.ObjectId(id));
    const existingLeads = leadIds.length
      ? await Lead.find({
          company: companyId,
          customerId: { $in: leadIds },
          isCustomerInterestLead: true,
          isDeleted: false,
        })
          .select("customerId interestStatus interestAssignedTo interestNextFollowupDate")
          .populate("interestAssignedTo", "fullName")
          .lean()
      : [];
    const followUps = new Map(existingLeads.map((lead) => [
      String(lead.customerId),
      followUpSummary(lead),
    ]));
    for (const lead of pagedLeads) lead.followUp = followUps.get(lead.id) || null;

    const funnel = makeFunnel(
      funnelActivities,
      funnelConfirmedBookings,
      funnelPeriod,
      sessionLookupTruncated,
    );
    return res.status(200).json({
      success: true,
      data: {
        availability: { status: "available", reason: null },
        period,
        scoring: {
          heuristic: true,
          configuration: INTENT_SCORING_CONFIG,
        },
        hotLeads: {
          data: pagedLeads,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          diagnostics: {
            activityStatus: "available",
            companyAttributableActivityEvents: leadActivityEventCount,
            companyVehicleViewEvents,
            identifiableVehicleViewers: companyInterestIds.size,
            hotLeadCandidates: scoredLeads.length,
            sessionLookupTruncated: leadSessionResult.truncated,
          },
        },
        funnel,
      },
    });
  } catch (error) {
    if (isMongoAuthorizationError(error)) {
      return next(new ApiError(503, "Customer activity data access was denied by the database"));
    }
    if (isCollectionMissing(error)) {
      return next(new ApiError(503, "Customer activity collection became unavailable during the query"));
    }
    return next(error);
  }
}

export async function getInterestLeadTeam(req, res, next) {
  try {
    const companyId = companyIdFor(req.user);
    if (!companyId) throw new ApiError(403, "Company scope could not be verified");
    const staff = await User.find({
      businessName: req.user.businessName,
      accountStatus: "ACTIVE",
      deletedAt: null,
      $or: [
        { _id: companyId, role: "SUPER_ADMIN" },
        { createdBy: companyId },
      ],
    })
      .select("fullName role")
      .sort({ fullName: 1 })
      .lean();
    return res.status(200).json({
      success: true,
      data: staff.map(({ _id, fullName, role }) => ({
        id: String(_id),
        name: fullName,
        role,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

export async function getCustomerInterestLeadHistory(req, res, next) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
      throw new ApiError(400, "Invalid customer id");
    }
    const companyId = companyIdFor(req.user);
    if (!companyId) throw new ApiError(403, "Company scope could not be verified");
    const lead = await Lead.findOne({
      company: companyId,
      customerId: req.params.id,
      isCustomerInterestLead: true,
      isDeleted: false,
    })
      .select("interestStatus interestAssignedTo interestNextFollowupDate")
      .populate("interestAssignedTo", "fullName")
      .lean();
    if (!lead) {
      return res.status(200).json({
        success: true,
        data: { availability: { status: "empty" }, lead: null, history: [] },
      });
    }
    const [activities, changes] = await Promise.all([
      LeadActivity.find({ lead: lead._id, company: companyId })
        .populate("createdBy", "fullName")
        .sort({ createdAt: -1 })
        .limit(HISTORY_LIMIT)
        .lean(),
      LeadHistory.find({ lead: lead._id, company: companyId })
        .populate("changedBy", "fullName")
        .sort({ createdAt: -1 })
        .limit(HISTORY_LIMIT)
        .lean(),
    ]);
    const history = [
      ...activities.map((activity) => ({
        id: String(activity._id),
        kind: "note",
        text: activity.activitySummary,
        at: activity.createdAt,
        by: activity.createdBy?.fullName || "Staff member",
      })),
      ...changes.map((change) => ({
        id: String(change._id),
        kind: change.action,
        field: change.field,
        text: formatLeadHistory(change),
        at: change.createdAt,
        by: change.changedBy?.fullName || "Staff member",
      })),
    ].sort((left, right) => new Date(right.at) - new Date(left.at))
      .slice(0, HISTORY_LIMIT);
    return res.status(200).json({
      success: true,
      data: {
        availability: { status: "available" },
        lead: followUpSummary(lead),
        history,
      },
    });
  } catch (error) {
    return next(error);
  }
}

export async function updateCustomerInterestLead(req, res, next) {
  let session;
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
      throw new ApiError(400, "Invalid customer id");
    }
    const companyId = companyIdFor(req.user);
    if (!companyId) throw new ApiError(403, "Company scope could not be verified");
    const customer = await Customer.findById(req.params.id)
      .select("_id customerName mobileNumber")
      .lean();
    if (!customer) throw new ApiError(404, "Customer not found");
    const vehicles = await Vehicle.find({
      company: companyId,
      isDeleted: { $ne: true },
    })
      .select("_id vehicleName displayName category")
      .lean();
    const today = currentIndiaDate();
    const from = shiftIndiaDate(today, -(INTENT_SCORING_CONFIG.windowDays - 1));
    const range = resolveIndiaDateRange({ from, to: today });
    const activitySource = await activityAvailability();
    if (activitySource.status === "denied") {
      throw new ApiError(503, "Customer activity access is denied");
    }
    if (activitySource.status !== "available") {
      throw new ApiError(503, "Customer activity is unavailable");
    }
    const interest = await loadCompanyViewContext(customer, vehicles, range.start);
    if (!interest) {
      throw new ApiError(404, "No recent vehicle interest was found in your company's fleet");
    }

    const body = req.body || {};
    if (
      body.note === undefined &&
      body.status === undefined &&
      body.assignedTo === undefined &&
      body.nextFollowupDate === undefined
    ) {
      throw new ApiError(400, "Provide a note, status, staff assignment, or follow-up date");
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (body.note !== undefined && (!note || note.length > 2000)) {
      throw new ApiError(400, "Note must be between 1 and 2000 characters");
    }
    if (body.status !== undefined && !INTEREST_STATUSES.includes(body.status)) {
      throw new ApiError(400, "Invalid customer interest status");
    }
    let nextFollowupDate;
    if (body.nextFollowupDate !== undefined && body.nextFollowupDate !== null && body.nextFollowupDate !== "") {
      nextFollowupDate = validDate(body.nextFollowupDate);
      if (!nextFollowupDate || nextFollowupDate <= new Date()) {
        throw new ApiError(400, "Follow-up must be scheduled for a future date");
      }
    }
    let assignedTo = undefined;
    if (body.assignedTo !== undefined) {
      if (body.assignedTo === null || body.assignedTo === "") {
        assignedTo = null;
      } else {
        if (!mongoose.isObjectIdOrHexString(body.assignedTo)) {
          throw new ApiError(400, "Invalid staff member");
        }
        const staff = await User.findOne({
          _id: body.assignedTo,
          businessName: req.user.businessName,
          accountStatus: "ACTIVE",
          deletedAt: null,
          $or: [
            { _id: companyId, role: "SUPER_ADMIN" },
            { createdBy: companyId },
          ],
        }).select("_id");
        if (!staff) throw new ApiError(404, "Staff member not found in your company");
        assignedTo = staff._id;
      }
    }
    if (
      body.status === "Follow-up Scheduled" &&
      !nextFollowupDate &&
      !body.nextFollowupDate
    ) {
      throw new ApiError(400, "A future follow-up date is required for this status");
    }

    await ensureInterestLeadIndex();
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const mobile = normalizeMobileNumber(customer.mobileNumber);
      const leadQuery = {
        company: companyId,
        customerId: customer._id,
        isCustomerInterestLead: true,
        isDeleted: false,
      };
      let lead = await Lead.findOne(leadQuery).session(session);
      const history = [];
      if (!lead) {
        const mobileProfiles = mobile
          ? await Customer.find({
              mobileNumber: { $in: mobileForms(customer.mobileNumber) },
            })
              .select("_id")
              .limit(2)
              .session(session)
              .lean()
          : [];
        const canAdoptExistingLead = mobileProfiles.length === 1 &&
          String(mobileProfiles[0]._id) === String(customer._id);
        const existing = canAdoptExistingLead
          ? await Lead.findOne({
              company: companyId,
              mobileNumber: { $in: mobileForms(customer.mobileNumber) },
              isDeleted: { $ne: true },
            })
              .sort({ updatedAt: -1 })
              .session(session)
          : null;
        const latestVehicle = resolveCompanyVehicle({
          _id: {
            vehicleId: String(interest.event.details?.vehicleId || interest.event.details?.carId || ""),
            vehicleName: String(interest.event.details?.vehicleName || interest.event.details?.carName || ""),
          },
        }, interest.context);
        lead = existing || new Lead({
          customerName: customer.customerName || "App User",
          mobileNumber: customer.mobileNumber || "",
          vehicleType: latestVehicle?.category === "bike"
            ? "bike"
            : "car",
          vehicleName: vehicleLabel(latestVehicle),
          source: "customer_app",
          company: companyId,
          createdBy: req.user._id,
        });
        lead.customerId = customer._id;
        lead.isCustomerInterestLead = true;
        lead.interestStatus = "New";
        history.push({
          lead: lead._id,
          company: companyId,
          field: "isCustomerInterestLead",
          oldValue: null,
          newValue: true,
          action: "created",
          changedBy: req.user._id,
        });
      }

      const recordHistory = (field, oldValue, newValue, action = "updated") => {
        if (String(oldValue ?? "") === String(newValue ?? "")) return;
        history.push({
          lead: lead._id,
          company: companyId,
          field,
          oldValue: oldValue ?? null,
          newValue: newValue ?? null,
          action,
          changedBy: req.user._id,
        });
      };

      if (body.status !== undefined) {
        recordHistory("interestStatus", lead.interestStatus, body.status, "status_changed");
        lead.interestStatus = body.status;
      }
      if (assignedTo !== undefined) {
        recordHistory("interestAssignedTo", lead.interestAssignedTo, assignedTo);
        lead.interestAssignedTo = assignedTo;
      }
      if (body.nextFollowupDate !== undefined) {
        const next = nextFollowupDate || null;
        recordHistory("interestNextFollowupDate", lead.interestNextFollowupDate, next);
        lead.interestNextFollowupDate = next;
        if (next && body.status === undefined) {
          recordHistory(
            "interestStatus",
            lead.interestStatus,
            "Follow-up Scheduled",
            "status_changed",
          );
          lead.interestStatus = "Follow-up Scheduled";
        }
      }
      if (
        body.status !== undefined &&
        body.status !== "Follow-up Scheduled" &&
        lead.interestNextFollowupDate
      ) {
        recordHistory("interestNextFollowupDate", lead.interestNextFollowupDate, null);
        lead.interestNextFollowupDate = null;
      }
      await lead.save({ session });
      if (note) {
        await LeadActivity.create([{
          lead: lead._id,
          company: companyId,
          contactType: "note",
          direction: "incoming",
          activitySummary: note,
          outcome: "internal_note",
          createdBy: req.user._id,
        }], { session });
      }
      if (history.length) await LeadHistory.insertMany(history, { session });
      result = {
        id: String(lead._id),
        status: lead.interestStatus,
        assignedTo: lead.interestAssignedTo
          ? String(lead.interestAssignedTo)
          : null,
        nextFollowupDate: lead.interestNextFollowupDate,
      };
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (isMongoAuthorizationError(error)) {
      return res.status(503).json({
        success: false,
        message: "Customer activity is unavailable for validating this lead.",
      });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
}
