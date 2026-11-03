import { test } from "node:test";
import assert from "node:assert/strict";
import {
  topicsFor,
  topicsForWriteRequest,
} from "../src/realtime/changeFeed.js";

test("permission writes are signaled in request-tracking fallback mode", () => {
  assert.deepEqual(
    topicsForWriteRequest("/api/v1/auth/roles/BOOKING_EXECUTIVE/permissions"),
    ["users", "permissions"],
  );
  assert.deepEqual(
    topicsForWriteRequest("/api/v1/auth/employees/123/permissions"),
    ["users", "permissions"],
  );
  assert.deepEqual(
    topicsForWriteRequest("/api/v1/auth/login"),
    ["users"],
  );
  assert.equal(
    topicsForWriteRequest("/api/v1/dashboard/maintenance").includes("permissions"),
    false,
    "unrelated data writes do not trigger access-profile refreshes",
  );
});

test("role policy changes publish permission-profile invalidations", () => {
  for (const operationType of ["insert", "update", "replace", "delete"]) {
    assert.deepEqual(
      topicsFor({ ns: { coll: "rolepermissions" }, operationType }),
      ["permissions"],
    );
  }
});

test("user access changes publish permission invalidations without exposing update data", () => {
  assert.deepEqual(
    topicsFor({
      ns: { coll: "users" },
      operationType: "update",
      updateDescription: {
        updatedFields: ["permissionOverrides.page.revenue.view", "role"],
      },
    }),
    ["users", "permissions"],
  );
  assert.deepEqual(
    topicsFor({
      ns: { coll: "users" },
      operationType: "update",
      updateDescription: { updatedFields: ["lastLoginAt"] },
    }),
    ["users"],
  );
  assert.deepEqual(
    topicsFor({
      ns: { coll: "users" },
      operationType: "update",
      updateDescription: { removedFields: ["businessName"] },
    }),
    ["users", "permissions"],
  );
});
