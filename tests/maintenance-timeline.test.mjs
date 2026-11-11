import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

test("maintenance timeline returns only the fields required by calendar and revenue views", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const { token } = await createUserAndLogin(ctx.base);
  const { default: Maintenance } = await import("../src/models/maintenance.model.js");
  const vehicle = new ctx.mongoose.Types.ObjectId();
  const row = await Maintenance.create({
    vehicle,
    startDate: new Date("2026-11-08T00:00:00.000Z"),
    endDate: new Date("2026-11-09T00:00:00.000Z"),
    status: "Scheduled",
    title: "Projection fixture",
    garage: { name: "Sensitive detail" },
  });

  const response = await client(ctx.base, token)("GET", "/dashboard/maintenance/timeline");
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 1);
  assert.deepEqual(Object.keys(response.json.data[0]).sort(), [
    "_id",
    "endDate",
    "startDate",
    "status",
    "vehicle",
  ]);
  assert.equal(response.json.data[0]._id, String(row._id));
  assert.equal(response.json.data[0].vehicle, String(vehicle));
  assert.equal(response.json.data[0].status, "Scheduled");
});
