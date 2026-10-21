// Reads one large result set as several parallel _id-range queries.
//
// The Atlas cluster throttles each query cursor to roughly 90 KB/s, but not
// the cluster as a whole: 1,700 bookings take ~15.5 s as one query and
// ~3-5 s as 8 parallel range queries (measured 2026-10-20). Same filter,
// projection and populate per part; the requested sort is restored after
// merging, so callers get the same documents in the same order.

import mongoose from "mongoose";

const MAX_PARTS = 8;
const DOCS_PER_PART = 100; // below ~100 docs one query is as fast

// BSON comparison order for the value types used in sort keys
// (missing/null < numbers < strings < objects < ObjectId < booleans < dates).
function typeRank(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  if (v instanceof mongoose.Types.ObjectId) return 7;
  if (typeof v === "boolean") return 8;
  if (v instanceof Date) return 9;
  return 3;
}

function compareValues(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 9) return a.getTime() - b.getTime();
  if (ra === 1 || ra === 8) return Number(a) - Number(b);
  if (ra === 7) [a, b] = [String(a), String(b)]; // hex order = byte order
  return a < b ? -1 : a > b ? 1 : 0;
}

const getPath = (doc, path) =>
  path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), doc);

// Sorts plain documents the way MongoDB would for `sort` (stable for ties).
export function sortLikeMongo(docs, sort) {
  const keys = Object.entries(sort || {});
  if (!keys.length) return docs;
  // Array#sort is stable: ties keep their _id-range order
  return docs.sort((x, y) => {
    for (const [path, dir] of keys) {
      const c = compareValues(getPath(x, path), getPath(y, path));
      if (c) return dir < 0 ? -c : c;
    }
    return 0;
  });
}

function runner(Model, filter, { select, sort, populate }) {
  return (extra) => {
    let q = Model.find(extra ? { $and: [filter, extra] } : filter);
    if (select) q = q.select(select);
    if (populate) q = q.populate(populate);
    if (sort) q = q.sort(sort);
    return q.lean();
  };
}

/**
 * Same result as
 *   Model.find({ ...filter, [field]: { $in: values } }) (+ select/populate/sort)
 * with the value list split into up to 8 parallel parts. No extra round trip:
 * each document has one value for `field`, so the parts never overlap.
 */
export async function parallelFindIn(Model, field, values, filter = {}, opts = {}) {
  const run = runner(Model, filter, opts);
  const list = [...new Map(values.map((v) => [String(v), v])).values()];
  if (!list.length) return [];

  const parts = Math.min(MAX_PARTS, Math.ceil(list.length / (DOCS_PER_PART / 2)));
  if (parts <= 1) return run({ [field]: { $in: list } });

  const size = Math.ceil(list.length / parts);
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));

  const results = await Promise.all(chunks.map((chunk) => run({ [field]: { $in: chunk } })));
  return sortLikeMongo(results.flat(), opts.sort);
}

/**
 * Same result as
 *   Model.find(filter).select(select).populate(populate).sort(sort).lean()
 * fetched as up to 8 parallel parts.
 */
export async function parallelFind(Model, filter, opts = {}) {
  const { sort } = opts;
  const run = runner(Model, filter, opts);

  // Split points: evenly sized _id buckets of the matching documents
  // (computed in the database, a few small documents come back).
  // aggregate() does not cast like find() does, so cast the filter first.
  const buckets = await Model.aggregate([
    { $match: Model.find(filter).cast() },
    { $bucketAuto: { groupBy: "$_id", buckets: MAX_PARTS } },
  ]);
  const total = buckets.reduce((s, b) => s + b.count, 0);
  // Ranges are open-ended, so a miscount can only unbalance the parts;
  // zero is the one case that must not be trusted: ask find() itself.
  if (!total) return run(null);

  const parts = Math.min(MAX_PARTS, Math.ceil(total / DOCS_PER_PART));
  if (parts <= 1) return run(null);

  // Merge neighbouring buckets down to `parts` ranges
  const per = Math.ceil(buckets.length / parts);
  const starts = [];
  for (let i = 0; i < buckets.length; i += per) starts.push(buckets[i]._id.min);

  // First and last ranges are open-ended, so together the ranges cover every
  // _id: a document that starts matching meanwhile is never skipped.
  const last = starts.length - 1;
  const results = await Promise.all(
    starts.map((min, i) => {
      const range = {};
      if (i > 0) range.$gte = min;
      if (i < last) range.$lt = starts[i + 1];
      return run({ _id: range });
    }),
  );

  return sortLikeMongo(results.flat(), sort);
}
