import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

test("dashboard calendar import includes removed vehicles and trustworthy lifecycle dates", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const owner = await createUserAndLogin(ctx.base);
  const api = client(ctx.base, owner.token);
  const { default: Vehicle } = await import("../src/models/vehicle.model.js");

  const created = await api("POST", "/vehicles/create", {
    vehicleName: "Lifecycle test vehicle",
    vehicleNumber: "KA01LC1234",
    manufacturer: "Test",
    fuelType: "Petrol",
    transmission: "Manual",
    seatingCapacity: 4,
  });
  assert.equal(created.status, 201, created.json.message);
  const vehicleId = created.json.data._id;

  const removed = await api("DELETE", `/vehicles/delete/${vehicleId}`);
  assert.equal(removed.status, 200, removed.json.message);

  const legacyId = "6a0000000000000000000001";
  await Vehicle.collection.insertOne({
    _id: new ctx.mongoose.Types.ObjectId(legacyId),
    vehicleName: "Legacy removed vehicle",
    vehicleNumber: "KA01LC5678",
    isDeleted: true,
  });

  const imported = await api("GET", "/dashboard/import");
  assert.equal(imported.status, 200, imported.json.message);
  const currentRecord = imported.json.vehicles.find((vehicle) => vehicle._id === vehicleId);
  const legacyRecord = imported.json.vehicles.find((vehicle) => vehicle._id === legacyId);

  assert.equal(currentRecord.isDeleted, true);
  assert.ok(currentRecord.createdAt);
  assert.ok(currentRecord.deletedAt);
  assert.equal(legacyRecord.isDeleted, true);
  assert.equal(legacyRecord.deletedAt, null);
});
