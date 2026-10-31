import assert from "node:assert/strict";
import mongoose from "mongoose";

// Seed unrelated documents directly so the guard also detects accidental
// collection-wide writes, deletes, soft deletes, and replacement inserts.
export async function editIntegrityGuard() {
  const names = ["bookings", "maintenances", "paymenthistories"];
  const sentinels = [];
  const ids = new Map();
  for (const name of names) {
    const collection = mongoose.connection.collection(name);
    const sentinel = { _id: new mongoose.Types.ObjectId(), isDeleted: false, testMarker: "unrelated record" };
    await collection.insertOne(sentinel);
    sentinels.push({ collection, sentinel });
    ids.set(name, (await collection.find({}, { projection: { _id: 1 } }).toArray()).map(row => String(row._id)).sort());
  }
  return async () => {
    for (const name of names) {
      const collection = mongoose.connection.collection(name);
      const current = (await collection.find({}, { projection: { _id: 1 } }).toArray()).map(row => String(row._id)).sort();
      assert.deepEqual(current, ids.get(name), `${name}: existing IDs must remain without deletes or duplicates`);
    }
    for (const { collection, sentinel } of sentinels) {
      assert.deepEqual(await collection.findOne({ _id: sentinel._id }), sentinel);
    }
  };
}
