// Real-time change notifications for the web dashboards.
//
// Detects data changes and tells connected browsers over Socket.IO, so the
// home dashboard no longer has to poll every 30 s. Events carry no data, only
// which kinds of records changed ({ topics: ["bookings", ...] }); the browser
// then re-fetches through the existing HTTP endpoints, so every response,
// rule and permission stays exactly as before.
//
// Change detection, in order of preference:
//   1. MongoDB change stream (replica sets / Atlas). Sees writes made by ANY
//      backend instance, e.g. the mobile app hitting production while this
//      server runs locally.
//   2. Fallback (standalone MongoDB, or while the stream is reconnecting):
//      every successful write request handled by THIS server.
//
// Why here and not in each controller: change-stream events exist only for
// committed writes. A failed write or an aborted transaction (lead.controller
// uses transactions) produces no event, and a transaction's writes are seen
// only after its commit, when readers can already see them. One place also
// covers every mutation path, including writes from other instances.
//
// Delivery: authenticated sockets in their server-assigned company room.
//
// The same signal invalidates the response cache (see responseCache.js).

import mongoose from "mongoose";
import { Server } from "socket.io";
import {
  DASHBOARD_ROOM,
  applyRooms,
  authenticateSocket,
  clearSocketTimers,
  companyIdForUser,
  revalidateSockets,
  scheduleTokenExpiry,
} from "./socketAuth.js";

// collection name -> topic sent to the browser
const TOPIC_BY_COLLECTION = {
  bookings: "bookings",
  handovers: "handovers",
  vehicles: "vehicles",
  maintenances: "maintenances",
  paymenthistories: "payments",
  vehiclereturns: "returns",
  // Server-side only (never sent to browsers): names in cached lists
  // ("created by") and re-checking connected accounts.
  users: "users",
  rolepermissions: "permissions",
};
const ALL_TOPICS = [
  ...new Set(
    Object.entries(TOPIC_BY_COLLECTION)
      .filter(([collection]) => collection !== "rolepermissions")
      .map(([, topic]) => topic),
  ),
];
const RESYNC_TOPICS = [...new Set([...ALL_TOPICS, "permissions"])];
const SERVER_ONLY_TOPICS = new Set(["users"]);
const PERMISSION_USER_FIELDS = new Set([
  "accountStatus",
  "businessName",
  "deletedAt",
  "permissionOverrides",
  "role",
]);

// Write requests that only touch accounts (login, roles, ...)
const ACCOUNT_WRITE_PREFIXES = ["/api/v1/auth"];

const EMIT_DEBOUNCE_MS = 300; // bursts of writes (one handover = several) -> one event
const EMIT_MAX_WAIT_MS = 1500;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

let io = null;
let mode = "off"; // "off" | "changeStream" | "requests"
let generation = 0;
let stream = null;
let stopped = false;
let retryMs = RETRY_MIN_MS;
const seqByCompany = new Map();

const invalidationListeners = new Set();

const pendingTopicsByCompany = new Map();
const pendingGlobalTopics = new Set();
let debounceTimer = null;
let maxWaitTimer = null;

// ---------- Public state ----------

// Bumped on every detected change; cached data from an older generation is stale.
export const getGeneration = () => generation;
export const getSequenceForCompany = (companyId) =>
  seqByCompany.get(String(companyId)) || 0;

// Caching is only safe while every write (from every instance) is seen.
export const isChangeStreamActive = () => mode === "changeStream";

export const onInvalidate = (fn) => {
  invalidationListeners.add(fn);
  return () => invalidationListeners.delete(fn);
};

// ---------- Change handling ----------

function flushEmit() {
  clearTimeout(debounceTimer);
  clearTimeout(maxWaitTimer);
  debounceTimer = null;
  maxWaitTimer = null;

  const pendingByCompany = new Map(pendingTopicsByCompany);
  pendingTopicsByCompany.clear();
  const globalTopics = new Set(pendingGlobalTopics);
  pendingGlobalTopics.clear();
  if ((!pendingByCompany.size && !globalTopics.size) || !io) return;

  const hasUserChanges =
    globalTopics.has("users") ||
    [...pendingByCompany.values()].some((topics) => topics.has("users"));
  if (hasUserChanges) {
    revalidateSockets(io).catch((err) =>
      console.error("[realtime] session re-check failed:", err.message),
    );
  }

  const companyIds = new Set(pendingByCompany.keys());
  if (globalTopics.size) {
    for (const socket of io.of("/").sockets.values()) {
      if (socket.data.companyId) companyIds.add(String(socket.data.companyId));
    }
  }

  for (const companyId of companyIds) {
    const topics = new Set([
      ...globalTopics,
      ...(pendingByCompany.get(companyId) || []),
    ]);
    const publicTopics = [...topics].filter(
      (topic) => !SERVER_ONLY_TOPICS.has(topic),
    );
    if (!publicTopics.length) continue;

    const seq = getSequenceForCompany(companyId) + 1;
    seqByCompany.set(companyId, seq);
    console.log(`[realtime] changed #${seq}: ${publicTopics.join(", ")}`);
    io.to(`${DASHBOARD_ROOM}:${companyId}`).emit("dashboard:changed", {
      companyId,
      topics: publicTopics,
      seq,
      at: new Date().toISOString(),
    });
  }
}

function scheduleEmit(topics, companyId) {
  const target = companyId ? String(companyId) : null;
  const destination = target
    ? (pendingTopicsByCompany.get(target) || new Set())
    : pendingGlobalTopics;
  for (const topic of topics) destination.add(topic);
  if (target) pendingTopicsByCompany.set(target, destination);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushEmit, EMIT_DEBOUNCE_MS);
  if (!maxWaitTimer) maxWaitTimer = setTimeout(flushEmit, EMIT_MAX_WAIT_MS);
}

function invalidate() {
  generation += 1;
  for (const fn of invalidationListeners) {
    try {
      fn();
    } catch (err) {
      console.error("[realtime] invalidate listener error:", err);
    }
  }
}

// Something changed: drop cached data now, tell browsers shortly.
export function markChanged(topics = ALL_TOPICS, companyId = null) {
  invalidate();
  scheduleEmit(topics, companyId);
}

// ---------- Write-request tracking ----------
// Always invalidates the cache around writes handled here (so the client that
// made the change reads its own write immediately, without waiting for the
// change stream). Only emits browser events when no change stream is running.
// Failed requests (4xx/5xx) never produce an event.
export function topicsForWriteRequest(originalUrl) {
  const isAccountWrite = ACCOUNT_WRITE_PREFIXES.some((p) =>
    originalUrl.startsWith(p),
  );
  const isPermissionWrite =
    /^\/api\/v1\/auth\/roles\/[^/?]+\/permissions(?:[/?]|$)/.test(
      originalUrl,
    ) ||
    /^\/api\/v1\/auth\/employees\/[^/?]+(?:\/(?:role|permissions|status))?(?:[/?]|$)/.test(
      originalUrl,
    );
  return isAccountWrite
    ? ["users", ...(isPermissionWrite ? ["permissions"] : [])]
    : ALL_TOPICS;
}

export function trackWriteRequests(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const topics = topicsForWriteRequest(req.originalUrl);
  invalidate();
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    if (mode === "changeStream") invalidate();
    else markChanged(topics, companyIdForUser(req.user));
  });
  next();
}

// ---------- Change stream ----------

const STRUCTURAL_EVENTS = ["drop", "rename", "dropDatabase", "invalidate"];

export function topicsFor(change) {
  const topic = TOPIC_BY_COLLECTION[change?.ns?.coll];
  if (topic === "users") {
    if (change.operationType !== "update") return ["users", "permissions"];
    const updatedFields = change.updateDescription?.updatedFields || {};
    const changedFields = [
      ...(Array.isArray(updatedFields)
        ? updatedFields
        : Object.keys(updatedFields)),
      ...(change.updateDescription?.removedFields || []),
    ];
    const changesAccess = changedFields.some((field) =>
      PERMISSION_USER_FIELDS.has(field.split(".")[0]),
    );
    return changesAccess ? ["users", "permissions"] : ["users"];
  }
  if (topic) return [topic];
  return STRUCTURAL_EVENTS.includes(change?.operationType) ? ALL_TOPICS : [];
}

function companyIdFromDocument(collection, document) {
  if (!document) return null;
  if (collection === "users") return companyIdForUser(document);
  if (collection === "rolepermissions") return null;
  const companyId = document.company?._id || document.company;
  return companyId ? String(companyId) : null;
}

async function companyIdForChange(change) {
  const collection = change?.ns?.coll;
  let document = change?.fullDocument || change?.fullDocumentBeforeChange;
  if (!document && change?.documentKey?._id && collection) {
    document = await mongoose.connection.db
      .collection(collection)
      .findOne(
        { _id: change.documentKey._id },
        { projection: { company: 1, createdBy: 1, updatedBy: 1, vehicle: 1 } },
      );
  }
  const directCompany = companyIdFromDocument(collection, document);
  if (directCompany) return directCompany;

  if (collection === "maintenances" && document?.vehicle) {
    const vehicle = await mongoose.connection.db
      .collection("vehicles")
      .findOne(
        { _id: document.vehicle?._id || document.vehicle },
        { projection: { company: 1 } },
      );
    return companyIdFromDocument("vehicles", vehicle);
  }

  if (collection === "rolepermissions" && document?.updatedBy) {
    const user = await mongoose.connection.db
      .collection("users")
      .findOne(
        { _id: document.updatedBy },
        { projection: { _id: 1, company: 1, createdBy: 1 } },
      );
    return companyIdForUser(user);
  }

  return null;
}

async function runChangeStream() {
  const db = mongoose.connection.db;
  const pipeline = [
    { $match: { "ns.coll": { $in: Object.keys(TOPIC_BY_COLLECTION) } } },
    // Project only tenant-routing references and changed field names. Record
    // contents and customer/payment data are never sent to browsers.
    {
      $project: {
        ns: 1,
        operationType: 1,
        "updateDescription.updatedFields": {
          $map: {
            input: {
              $objectToArray: {
                $ifNull: ["$updateDescription.updatedFields", {}],
              },
            },
            as: "field",
            in: "$$field.k",
          },
        },
        "updateDescription.removedFields": 1,
        "fullDocument.company": 1,
        "fullDocument.createdBy": 1,
        "fullDocument.updatedBy": 1,
        "fullDocument.businessName": 1,
        "fullDocument._id": 1,
        "fullDocument.vehicle": 1,
        "fullDocumentBeforeChange.company": 1,
        "fullDocumentBeforeChange.createdBy": 1,
        "fullDocumentBeforeChange.updatedBy": 1,
        "fullDocumentBeforeChange.businessName": 1,
        "fullDocumentBeforeChange._id": 1,
        "fullDocumentBeforeChange.vehicle": 1,
      },
    },
  ];

  stream = db.watch(pipeline, {
    fullDocument: "updateLookup",
    fullDocumentBeforeChange: "whenAvailable",
  });

  // First round-trip: throws right away on a standalone server.
  const first = await stream.tryNext();

  const wasInactive = mode !== "changeStream";
  mode = "changeStream";
  retryMs = RETRY_MIN_MS;
  console.log("[realtime] change stream active");
  // Anything written while the stream was down was not seen: refresh all.
  if (wasInactive) markChanged(RESYNC_TOPICS);
  if (first) {
    const topics = topicsFor(first);
    if (topics.length) markChanged(topics, await companyIdForChange(first));
  }

  for await (const change of stream) {
    const topics = topicsFor(change);
    if (topics.length) markChanged(topics, await companyIdForChange(change));
  }
}

async function superviseChangeStream() {
  while (!stopped) {
    try {
      await runChangeStream();
      if (stopped) return;
      throw new Error("change stream ended");
    } catch (err) {
      if (stopped) return;
      const wasActive = mode === "changeStream";
      mode = "requests";
      invalidate(); // cache can no longer be trusted
      if (wasActive) {
        console.warn(`[realtime] change stream lost: ${err.message}`);
      } else {
        console.warn(
          `[realtime] change stream unavailable (${err.message}); ` +
            "using write-request notifications",
        );
      }
      try {
        await stream?.close();
      } catch {
        // already closed
      }
      stream = null;
      await new Promise((r) => setTimeout(r, retryMs).unref());
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}

// ---------- Bootstrap ----------

export function startRealtime(httpServer) {
  io = new Server(httpServer, {
    // Same origins as the REST API (app.js). Access is decided by the Bearer
    // token checked below, not by the origin or cookies.
    cors: { origin: true, credentials: true },
  });

  io.engine.on("connection_error", (err) => {
    console.warn(`[realtime] transport error: ${err.message}`);
  });

  // Every connection must present a valid token for an active account.
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const subscribed = applyRooms(socket);
    scheduleTokenExpiry(socket);
    socket.on("disconnect", () => clearSocketTimers(socket));
    // No client -> server events are handled: clients cannot pick rooms.
    // `seq` is the last event number; the client resyncs over REST anyway.
    socket.emit("realtime:ready", {
      subscribed,
      companyId: socket.data.companyId,
      seq: getSequenceForCompany(socket.data.companyId),
    });
  });

  mode = "requests";
  stopped = false;

  const begin = () => {
    superviseChangeStream().catch((err) =>
      console.error("[realtime] supervisor crashed:", err),
    );
  };
  if (mongoose.connection.readyState === 1) begin();
  else mongoose.connection.once("open", begin);

  return io;
}

export async function stopRealtime() {
  stopped = true;
  mode = "off";
  flushEmit();
  try {
    await stream?.close();
  } catch {
    // ignore
  }
  stream = null;
  // Not io.close(): that would also close the HTTP server, which the caller
  // shuts down itself.
  if (io) {
    io.disconnectSockets(true);
    io.engine.close();
  }
  io = null;
}
