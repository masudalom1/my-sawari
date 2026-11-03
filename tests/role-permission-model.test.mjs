import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../src/models/user.model.js";
import RolePermission from "../src/models/rolePermission.model.js";
import {
  getEffectivePermissions,
  normalizeUserPermissionOverrideMap,
  RBAC_PERMISSION_KEYS,
  resolvePermissionDecision,
} from "../src/config/rbacPermissions.js";
import { resolveUserPermissions } from "../src/services/permissionResolver.js";

const updatedBy = new mongoose.Types.ObjectId();

function createPolicy(overrides = {}) {
  return new RolePermission({
    businessName: "Test Rentals",
    role: "BOOKING_EXECUTIVE",
    permissions: { "page.bookings.view": true },
    updatedBy,
    ...overrides,
  });
}

test("role permission model validates registry keys and boolean defaults", () => {
  assert.equal(createPolicy().validateSync(), undefined);
  assert.ok(RBAC_PERMISSION_KEYS.includes("page.bookings.view"));

  const unknownKey = createPolicy({
    permissions: { "page.unknown.view": true },
  }).validateSync();
  assert.ok(unknownKey?.errors.permissions);

  const invalidValue = createPolicy({
    permissions: { "page.bookings.view": "allow" },
  }).validateSync();
  assert.ok(invalidValue?.errors.permissions);

  const nestedMap = createPolicy({
    permissions: { bookings: { view: true } },
  }).validateSync();
  assert.ok(nestedMap?.errors.permissions);
});

test("role permission model accepts all roles while tenant scope and APIs protect Super Admin policies", () => {
  assert.equal(createPolicy({ role: "SUPER_ADMIN" }).validateSync(), undefined);
  assert.ok(createPolicy({ updatedBy: null }).validateSync()?.errors.updatedBy);
  assert.equal(RolePermission.schema.options.timestamps, true);

  const tenantRoleIndex = RolePermission.schema.indexes().find(
    ([keys]) => keys.businessName === 1 && keys.role === 1,
  );
  assert.equal(tenantRoleIndex?.[1].unique, true);
});

test("user schema and override API validate stored and incoming overrides", () => {
  const createUser = (permissionOverrides) =>
    new User({
      fullName: "Override User",
      mobileNumber: "9876543210",
      email: "override@example.test",
      businessName: "Test Rentals",
      password: "Password1!",
      role: "BOOKING_EXECUTIVE",
      permissionOverrides,
    });

  assert.equal(createUser({ "page.bookings.edit": "allow" }).validateSync(), undefined);
  assert.ok(createUser({ "page.unknown.view": "allow" }).validateSync()?.errors.permissionOverrides);
  assert.ok(createUser({ "page.bookings.edit": true }).validateSync()?.errors.permissionOverrides);
  assert.equal(
    createUser({ "page.settings.manageAccess": "allow" }).validateSync(),
    undefined,
    "existing registered values remain readable and savable",
  );
  assert.equal(normalizeUserPermissionOverrideMap({ "page.settings.manageAccess": "allow" }), null);
  assert.equal(normalizeUserPermissionOverrideMap({ "page.settings.view": "deny" }), null);
  assert.equal(
    getEffectivePermissions(
      { "page.settings.manageAccess": true },
      { "page.settings.manageAccess": "allow" },
      "BOOKING_EXECUTIVE",
    )["page.settings.manageAccess"],
    false,
  );
  assert.equal(
    getEffectivePermissions(
      { "page.settings.manageAccess": true },
      {},
      "SUPER_ADMIN",
    )["page.settings.manageAccess"],
    true,
  );
});

test("effective permissions fail closed for unknown keys and malformed overrides", () => {
  const permissions = getEffectivePermissions(
    {
      "page.bookings.view": true,
      "page.unknown.view": true,
    },
    {
      "page.bookings.view": "invalid",
      "page.unknown.view": "allow",
    },
    "BOOKING_EXECUTIVE",
  );

  assert.equal(permissions["page.bookings.view"], false);
  assert.equal("page.unknown.view" in permissions, false);
  assert.equal(
    getEffectivePermissions(
      { "page.bookings.view": false },
      { "page.bookings.view": "allow" },
      "BOOKING_EXECUTIVE",
    )["page.bookings.view"],
    true,
    "an explicit user allow remains an intentional per-user exception",
  );
  assert.equal(
    getEffectivePermissions(
      { "page.bookings.view": true },
      { "page.bookings.view": "inherit" },
      "BOOKING_EXECUTIVE",
    )["page.bookings.view"],
    true,
  );
  assert.equal(
    getEffectivePermissions(
      { "page.bookings.view": true },
      { "page.bookings.view": "deny" },
      "BOOKING_EXECUTIVE",
    )["page.bookings.view"],
    false,
  );
});

test("the authoritative decision order distinguishes explicit defaults from missing permissions", () => {
  assert.deepEqual(
    resolvePermissionDecision(
      { "page.bookings.view": true },
      { "page.bookings.view": "deny" },
      "BOOKING_EXECUTIVE",
      "page.bookings.view",
    ),
    { allowed: false, configured: true, source: "user-override" },
    "an explicit user deny takes precedence over an allowed role default",
  );
  assert.deepEqual(
    resolvePermissionDecision(
      {},
      { "page.bookings.view": "deny" },
      "BOOKING_EXECUTIVE",
      "page.bookings.view",
    ),
    { allowed: false, configured: true, source: "user-override" },
    "an explicit user deny remains effective when the role has no configured default",
  );
  assert.deepEqual(
    resolvePermissionDecision(
      {},
      { "page.bookings.view": "allow" },
      "BOOKING_EXECUTIVE",
      "page.bookings.view",
    ),
    { allowed: false, configured: false, source: "unconfigured" },
    "a user allow cannot turn a missing role permission into a grant",
  );
  assert.deepEqual(
    resolvePermissionDecision(
      { "page.bookings.view": false },
      { "page.bookings.view": "allow" },
      "BOOKING_EXECUTIVE",
      "page.bookings.view",
    ),
    { allowed: true, configured: true, source: "user-override" },
    "a valid allow can override an explicit role deny",
  );
  assert.equal(
    resolvePermissionDecision(
      { "page.bookings.view": true },
      { "page.bookings.view": "deny" },
      "BOOKING_EXECUTIVE",
      "page.bookings.view",
    ).allowed,
    false,
  );
  assert.equal(
    resolvePermissionDecision(
      { "page.bookings.view": false },
      { "page.bookings.view": "inherit" },
      "BOOKING_EXECUTIVE",
      "page.bookings.view",
    ).allowed,
    false,
  );
  assert.equal(
    getEffectivePermissions(
      { "page.bookings.view": true },
      { "page.bookings.view": "deny" },
      "SUPER_ADMIN",
    )["page.bookings.view"],
    true,
    "stored overrides cannot weaken the protected Super Admin policy",
  );
  assert.equal(
    getEffectivePermissions(
      { "page.bookings.view": true },
      {},
      "UNKNOWN_ROLE",
    )["page.bookings.view"],
    false,
  );
  assert.deepEqual(
    resolvePermissionDecision(
      { "page.settings.manageAccess": true },
      { "page.settings.manageAccess": "allow" },
      "BOOKING_EXECUTIVE",
      "page.settings.manageAccess",
    ),
    { allowed: false, configured: true, source: "protected" },
  );
});

test("non-Super-Admin permission resolution requires tenant scope", async () => {
  await assert.rejects(
    resolveUserPermissions({
      _id: new mongoose.Types.ObjectId(),
      role: "BOOKING_EXECUTIVE",
      permissionOverrides: { "page.bookings.view": "allow" },
    }),
    { statusCode: 403, message: "Permission access is not configured for this account" },
  );

  await assert.rejects(
    resolveUserPermissions({
      _id: new mongoose.Types.ObjectId(),
      role: "UNKNOWN_ROLE",
      businessName: "Test Rentals",
    }),
    { statusCode: 403, message: "Account role is invalid" },
  );
});
