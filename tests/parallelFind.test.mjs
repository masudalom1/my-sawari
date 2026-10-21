// parallelFind must return exactly what one find() returns: same documents,
// same fields, same order (including null / missing sort keys).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/harness.mjs";

let ctx;
let parallelFind;
let parallelFindIn;
let Booking;
let Vehicle;

before(async () => {
  ctx = await startTestApp();
  ({ parallelFind } = await import("../src/utils/parallelFind.js"));
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: Vehicle } = await import("../src/models/vehicle.model.js"));

  const vehicles = await Vehicle.collection.insertMany(
    [1, 2, 3].map((i) => ({ vehicleName: `V${i}`, vehicleNumber: `KA0${i}`, isDeleted: false })),
  );
  const vehicleIds = Object.values(vehicles.insertedIds);
  const day = 86400000;
  const docs = [];
  for (let i = 0; i < 650; i++) {
    docs.push({
      bookingCode: `B${i}`,
      customerName: `C${i}`,
      // many ties, some null and some missing sort keys
      ...(i % 50 === 0 ? {} : { fromDate: i % 37 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + (i % 40) * day) }),
      vehicleId: vehicleIds[i % 3],
      status: i % 9 === 0 ? "cancelled" : i % 4 === 0 ? "completed" : "confirmed",
      isDeleted: i % 23 === 0,
      payment: { totalAmount: i },
    });
  }
  await Booking.collection.insertMany(docs);
});

after(async () => {
  await ctx?.stop();
});

const plain = (filter, { select, sort, populate }) => {
  let q = Booking.find(filter);
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  if (sort) q = q.sort({ ...sort, _id: 1 }); // _id: deterministic ties for comparing
  return q.lean();
};

const sameDocsSameOrder = async (filter, opts) => {
  const expected = await plain(filter, opts);
  const actual = await parallelFind(Booking, filter, opts);

  assert.equal(actual.length, expected.length);
  assert.ok(actual.length > 100, "test must exercise the parallel path");
  // same documents and fields
  const byId = (list) => JSON.stringify([...list].sort((a, b) => String(a._id).localeCompare(String(b._id))));
  assert.equal(byId(actual), byId(expected));
  // same order of sort keys (ties may be in any order, as in MongoDB)
  const key = Object.keys(opts.sort)[0];
  const keys = (list) => list.map((d) => (d[key] == null ? null : String(d[key])));
  assert.deepEqual(keys(actual), keys(expected));
};

test("same result as find(): filter, projection, sort with null / missing keys", async () => {
  await sameDocsSameOrder(
    { isDeleted: false, status: { $ne: "cancelled" } },
    { select: "_id bookingCode customerName fromDate status payment", sort: { fromDate: 1 } },
  );
});

test("same result with descending sort and populate", async () => {
  await sameDocsSameOrder(
    { isDeleted: false },
    {
      select: "_id bookingCode fromDate vehicleId",
      sort: { fromDate: -1 },
      populate: { path: "vehicleId", select: "_id vehicleName vehicleNumber" },
    },
  );
});

test("same result for $or / $nor filters (as used by the live timeline)", async () => {
  const rules = [{ status: "completed" }, { fromDate: null }];
  const all = await parallelFind(Booking, { isDeleted: false }, { select: "_id", sort: { _id: 1 } });
  const a = await parallelFind(Booking, { isDeleted: false, $or: rules }, { select: "_id", sort: { _id: 1 } });
  const b = await parallelFind(Booking, { isDeleted: false, $nor: rules }, { select: "_id", sort: { _id: 1 } });
  assert.equal(a.length + b.length, all.length);
  assert.deepEqual(
    [...a, ...b].map((d) => String(d._id)).sort(),
    all.map((d) => String(d._id)).sort(),
  );
});

test("string ids in the filter are cast like find() does", async () => {
  const all = await Booking.find({ isDeleted: false }).select("_id vehicleId").lean();
  const vid = String(all[0].vehicleId); // string, stored as ObjectId
  const expected = all.filter((b) => String(b.vehicleId) === vid).length;
  const actual = await parallelFind(Booking, { isDeleted: false, vehicleId: vid }, { select: "_id" });
  assert.ok(expected > 100);
  assert.equal(actual.length, expected);
  const byIds = await parallelFind(Booking, { _id: { $in: all.slice(0, 150).map((b) => String(b._id)) } }, { select: "_id" });
  assert.equal(byIds.length, 150);
});

test("parallelFindIn: same result as one $in query (duplicate values, sort, extra filter)", async () => {
  ({ parallelFindIn } = await import("../src/utils/parallelFind.js"));
  const all = await Booking.find({}).select("_id").lean();
  const values = all.slice(0, 400).map((b) => b._id);
  values.push(...values.slice(0, 20)); // duplicates must not duplicate results
  const opts = { select: "_id bookingCode fromDate status", sort: { fromDate: -1 } };
  const expected = await plain({ isDeleted: false, _id: { $in: values } }, opts);
  const actual = await parallelFindIn(Booking, "_id", values, { isDeleted: false }, opts);
  assert.equal(actual.length, expected.length);
  const ids = (list) => list.map((d) => String(d._id)).sort();
  assert.deepEqual(ids(actual), ids(expected));
  const keys = (list) => list.map((d) => (d.fromDate == null ? null : d.fromDate.getTime()));
  assert.deepEqual(keys(actual), keys(expected));
  assert.deepEqual(await parallelFindIn(Booking, "_id", [], {}, opts), []);
});

test("small and empty result sets", async () => {
  assert.deepEqual(await parallelFind(Booking, { bookingCode: "nope" }, { sort: { fromDate: 1 } }), []);
  const few = await parallelFind(Booking, { bookingCode: { $in: ["B1", "B2"] } }, { select: "_id bookingCode", sort: { bookingCode: 1 } });
  assert.deepEqual(few.map((d) => d.bookingCode), ["B1", "B2"]);
});
