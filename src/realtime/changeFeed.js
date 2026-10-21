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
// Delivery: only authenticated sockets in the dashboard room (socketAuth.js).
//
// The same signal invalidates the response cache (see responseCache.js).

import mongoose from "mongoose";
import { Server } from "socket.io";
import {
  DASHBOARD_ROOM,
  applyRooms,
  authenticateSocket,
  clearSocketTimers,
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
};
const ALL_TOPICS = [...new Set(Object.values(TOPIC_BY_COLLECTION))];
const SERVER_ONLY_TOPICS = new Set(["users"]);

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
let seq = 0; // event number: lets clients spot duplicates / gaps

const invalidationListeners = new Set();

let pendingTopics = new Set();
let debounceTimer = null;
let maxWaitTimer = null;

// ---------- Public state ----------

// Bumped on every detected change; cached data from an older generation is stale.
export const getGeneration = () => generation;

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

  const changed = [...pendingTopics];
  pendingTopics = new Set();
  if (!changed.length || !io) return;

  if (changed.includes("users")) {
    revalidateSockets(io).catch((err) =>
      console.error("[realtime] session re-check failed:", err.message),
    );
  }

  const topics = changed.filter((t) => !SERVER_ONLY_TOPICS.has(t));
  if (!topics.length) return;

  seq += 1;
  console.log(`[realtime] changed #${seq}: ${topics.join(", ")}`);
  // Only to authorized sockets (room assigned at authentication). The
  // payload names what changed; no documents, customer or payment data.
  io.to(DASHBOARD_ROOM).emit("dashboard:changed", {
    topics,
    seq,
    at: new Date().toISOString(),
  });
}

function scheduleEmit(topics) {
  for (const t of topics) pendingTopics.add(t);
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
export function markChanged(topics = ALL_TOPICS) {
  invalidate();
  scheduleEmit(topics);
}

// ---------- Write-request tracking ----------
// Always invalidates the cache around writes handled here (so the client that
// made the change reads its own write immediately, without waiting for the
// change stream). Only emits browser events when no change stream is running.
// Failed requests (4xx/5xx) never produce an event.
export function trackWriteRequests(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const topics = ACCOUNT_WRITE_PREFIXES.some((p) =>
    req.originalUrl.startsWith(p),
  )
    ? ["users"]
    : ALL_TOPICS;

  invalidate();
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    if (mode === "changeStream") invalidate();
    else markChanged(topics);
  });
  next();
}

// ---------- Change stream ----------

const STRUCTURAL_EVENTS = ["drop", "rename", "dropDatabase", "invalidate"];

function topicsFor(change) {
  const topic = TOPIC_BY_COLLECTION[change?.ns?.coll];
  if (topic) return [topic];
  return STRUCTURAL_EVENTS.includes(change?.operationType) ? ALL_TOPICS : [];
}

async function runChangeStream() {
  const db = mongoose.connection.db;
  const pipeline = [
    { $match: { "ns.coll": { $in: Object.keys(TOPIC_BY_COLLECTION) } } },
    // Only what is needed to know WHAT changed: keeps traffic from a
    // bandwidth-limited cluster tiny (no document bodies, no update diffs).
    { $project: { ns: 1, operationType: 1 } },
  ];

  stream = db.watch(pipeline);

  // First round-trip: throws right away on a standalone server.
  const first = await stream.tryNext();

  const wasInactive = mode !== "changeStream";
  mode = "changeStream";
  retryMs = RETRY_MIN_MS;
  console.log("[realtime] change stream active");
  // Anything written while the stream was down was not seen: refresh all.
  if (wasInactive) markChanged(ALL_TOPICS);
  if (first) markChanged(topicsFor(first));

  for await (const change of stream) {
    const topics = topicsFor(change);
    if (topics.length) markChanged(topics);
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
    socket.emit("realtime:ready", { subscribed, seq });
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
