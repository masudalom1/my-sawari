// Change-invalidated cache for the heavy dashboard reads.
//
// The Atlas cluster is bandwidth-limited (~90 KB/s), so re-reading the same
// documents for every request / every open dashboard is what makes the pages
// slow. Results are reused only while NOTHING has changed:
//   - active only while the MongoDB change stream is running (changeFeed.js),
//     so writes from every backend instance are seen;
//   - any change bumps the generation and drops every entry;
//   - a result computed while a change happened is never stored;
//   - entries also expire after `maxAgeMs` (shorter for responses that depend
//     on the current time, e.g. "on rent now").
// Concurrent identical requests share one database read.
// Set DASHBOARD_CACHE=off to disable.

import {
  getGeneration,
  isChangeStreamActive,
  onInvalidate,
} from "./changeFeed.js";

const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;

const store = new Map(); // key -> { value, gen, at }
const inflight = new Map(); // key -> Promise<entry | null>

onInvalidate(() => store.clear());

const enabled = () =>
  process.env.DASHBOARD_CACHE !== "off" && isChangeStreamActive();

function getFresh(key, maxAgeMs) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.gen !== getGeneration() || Date.now() - hit.at >= maxAgeMs) {
    store.delete(key);
    return null;
  }
  // refresh LRU position
  store.delete(key);
  store.set(key, hit);
  return hit;
}

function put(key, value, gen) {
  if (gen !== getGeneration() || !enabled()) return null;
  const entry = { value, gen, at: Date.now() };
  store.set(key, entry);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  return entry;
}

// Cache any async computation (e.g. the booking ledger).
export async function cachedValue(key, compute, { maxAgeMs }) {
  if (!enabled()) return compute();

  const hit = getFresh(key, maxAgeMs);
  if (hit) return hit.value;

  const pending = inflight.get(key);
  if (pending) {
    const entry = await pending;
    if (entry) return entry.value;
    return compute();
  }

  const gen = getGeneration();
  let resolveShared;
  const shared = new Promise((r) => (resolveShared = r));
  inflight.set(key, shared);
  try {
    const value = await compute();
    resolveShared(put(key, value, gen));
    return value;
  } catch (err) {
    resolveShared(null);
    throw err;
  } finally {
    inflight.delete(key);
  }
}

function sendEntry(res, entry) {
  res.set("X-Dashboard-Cache", "hit");
  res.type("application/json").send(entry.value);
}

// Express middleware for GET routes. Only successful JSON responses
// (HTTP 200 and success !== false) are stored, as the exact bytes sent.
// `maxAgeMs` may be a number or (req) => number.
export function cacheResponse({ maxAgeMs: maxAge }) {
  return (req, res, next) => {
    if (req.method !== "GET" || !enabled()) return next();

    const maxAgeMs = typeof maxAge === "function" ? maxAge(req) : maxAge;
    const key = req.originalUrl;
    const hit = getFresh(key, maxAgeMs);
    if (hit) return sendEntry(res, hit);

    const pending = inflight.get(key);
    if (pending) {
      pending.then((entry) => (entry ? sendEntry(res, entry) : next()));
      return;
    }

    const gen = getGeneration();
    let resolveShared;
    let settled = false;
    const settle = (entry) => {
      if (settled) return;
      settled = true;
      inflight.delete(key);
      resolveShared(entry);
    };
    inflight.set(key, new Promise((r) => (resolveShared = r)));

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.set("X-Dashboard-Cache", "miss");
      if (res.statusCode !== 200 || body?.success === false) {
        settle(null);
        return originalJson(body);
      }
      // Same bytes res.json would send (no json replacer/spaces are set)
      const text = JSON.stringify(body);
      settle(text.length <= MAX_ENTRY_BYTES ? put(key, text, gen) : null);
      return res.type("application/json").send(text);
    };
    res.on("close", () => settle(null));
    next();
  };
}
