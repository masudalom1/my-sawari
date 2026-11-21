import { test } from "node:test";
import assert from "node:assert/strict";
import ApiActivityLog from "../src/models/apiActivityLog.model.js";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

test("API activity logs require Super Admin and support safe search, sort, and pagination", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const staff = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const adminApi = client(ctx.base, admin.token);
  const staffApi = client(ctx.base, staff.token);
  const path = "/activity-logs";

  assert.equal((await client(ctx.base)("GET", path)).status, 401);
  assert.equal((await staffApi("GET", path)).status, 403);

  await ApiActivityLog.create([
    {
      action: "updated",
      actorName: "Anisul",
      actorRole: "SUPER_ADMIN",
      entityType: "booking",
      entityId: "booking-1",
      summary: "Updated Venue booking",
      path: "/api/v1/bookings/booking-1",
      createdAt: new Date("2026-11-16T10:00:00.000Z"),
      changes: [{ field: "Vehicle Name", oldValue: "Venue Black", newValue: "Venue White" }],
    },
    {
      action: "created",
      actorName: "Mindar",
      actorRole: "OPERATIONS_EXECUTIVE",
      entityType: "handover",
      entityId: "handover-1",
      summary: "Created handover",
      createdAt: new Date("2026-11-17T10:00:00.000Z"),
    },
  ]);

  const defaultResponse = await adminApi("GET", path);
  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultResponse.json.pagination.total, 2);
  assert.equal(defaultResponse.json.data[0].actorName, "Mindar");

  const filtered = await adminApi(
    "GET",
    `${path}?search=Venue%20Black&entityType=booking&page=1&limit=1&sortBy=createdAt&sortOrder=asc`,
  );
  assert.equal(filtered.status, 200);
  assert.equal(filtered.json.pagination.total, 1);
  assert.equal(filtered.json.data[0].entityId, "booking-1");

  const literalSearch = await adminApi("GET", `${path}?search=%5B`);
  assert.equal(literalSearch.status, 200);
  assert.equal(literalSearch.json.pagination.total, 0);

  assert.equal((await adminApi("GET", `${path}?limit=101`)).status, 400);
  assert.equal((await adminApi("GET", `${path}?sortBy=__proto__`)).status, 400);
});
