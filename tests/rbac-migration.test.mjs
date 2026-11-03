import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";
import {
  PERMISSIONS,
  RBAC_ASSIGNABLE_ROLES,
  RBAC_PERMISSION_KEYS,
} from "../src/config/rbacPermissions.js";
import { getRbacEnforcementMode } from "../src/config/rbacEnforcement.js";
import {
  seedRolePermissionCompatibility,
  validateCompatibilityPermissionMap,
} from "../src/services/rolePermissionMigration.service.js";

function makeReviewedMapping() {
  return Object.fromEntries(
    RBAC_ASSIGNABLE_ROLES.map((role) => [
      role,
      Object.fromEntries(
        RBAC_PERMISSION_KEYS.map((key) => [
          key,
          false,
        ]),
      ),
    ]),
  );
}

test("permissions are enforced in every environment, including deprecated legacy configuration", () => {
  const previousMode = process.env.RBAC_ENFORCEMENT_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    delete process.env.RBAC_ENFORCEMENT_MODE;
    assert.equal(getRbacEnforcementMode(), "enforce");
    process.env.NODE_ENV = "production";
    assert.equal(getRbacEnforcementMode(), "enforce");
    process.env.RBAC_ENFORCEMENT_MODE = "unexpected";
    assert.throws(() => getRbacEnforcementMode(), /must be enforce/);
    process.env.RBAC_ENFORCEMENT_MODE = "legacy";
    assert.equal(getRbacEnforcementMode(), "enforce");
  } finally {
    if (previousMode === undefined) delete process.env.RBAC_ENFORCEMENT_MODE;
    else process.env.RBAC_ENFORCEMENT_MODE = previousMode;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("compatibility mapping requires explicit complete role policies and protects Settings", () => {
  const mapping = makeReviewedMapping();
  assert.deepEqual(validateCompatibilityPermissionMap(mapping), mapping);
  assert.throws(
    () => validateCompatibilityPermissionMap({ ...mapping, SUPER_ADMIN: {} }),
    /include every assignable role/,
  );

  const missingPermission = structuredClone(mapping);
  delete missingPermission.BOOKING_EXECUTIVE[RBAC_PERMISSION_KEYS[0]];
  assert.throws(
    () => validateCompatibilityPermissionMap(missingPermission),
    /explicitly define every registered key/,
  );

  const settingsGrant = structuredClone(mapping);
  settingsGrant.ADMIN[PERMISSIONS.settings.view] = true;
  assert.throws(
    () => validateCompatibilityPermissionMap(settingsGrant),
    /reserved for SUPER_ADMIN/,
  );

});

test("legacy configuration cannot bypass saved permissions or revocation on an existing JWT", async (t) => {
  const ctx = await startTestApp({ RBAC_ENFORCEMENT_MODE: "legacy" });
  t.after(() => ctx.stop());

  const employee = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const admin = await createUserAndLogin(ctx.base);
  const adminApi = client(ctx.base, admin.token);
  const employeeApi = client(ctx.base, employee.token);
  const dashboard = await employeeApi("GET", "/dashboard/stats");
  assert.equal(dashboard.status, 403, "missing policy denies access even with legacy configured");
  assert.equal((await employeeApi("GET", "/auth/roles/permissions")).status, 403);
  assert.equal((await client(ctx.base)("GET", "/dashboard/stats")).status, 401);

  const currentAccess = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(currentAccess.status, 200);
  assert.equal(currentAccess.json.data.enforcementMode, "enforce");
  assert.equal(currentAccess.json.data.configured, false);

  const save = (permissions) => adminApi("PUT", "/auth/roles/BOOKING_EXECUTIVE/permissions", { permissions });
  assert.equal((await save({
    [PERMISSIONS.dashboard.view]: true,
    [PERMISSIONS.bookings.view]: true,
    [PERMISSIONS.revenue.view]: false,
    [PERMISSIONS.paymentsHistory.view]: false,
    [PERMISSIONS.verifyUpiCollections.view]: false,
    [PERMISSIONS.pendingToCollect.view]: false,
  })).status, 200);
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 200);
  assert.equal((await employeeApi("GET", "/leads/booking")).status, 200);
  const deniedEndpoints = [
    ["GET", "/dashboard/bookingrevenue"],
    ["GET", "/dashboard/payments/import"],
    ["GET", "/dashboard/revenue/vehicles"],
    ["GET", "/dashboard/payments-history"],
    ["GET", "/dashboard/payments-history/upi"],
    ["GET", "/dashboard/payments-history/cash"],
    ["POST", "/dashboard/payments-history/upi/000000000000000000000001/verify"],
    ["POST", "/dashboard/payments-history/cash/000000000000000000000001/collect"],
  ];
  for (const [method, path] of deniedEndpoints) {
    assert.equal((await employeeApi(method, path, method === "POST" ? {} : undefined)).status, 403, `${method} ${path}`);
  }
  assert.equal((await save({ [PERMISSIONS.dashboard.view]: false })).status, 200);
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 403);
  assert.equal((await employeeApi("GET", "/leads/booking")).status, 403);
  const revoked = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(revoked.json.data.effectivePermissionCount, 0);
});

test("compatibility seeding is idempotent and never overwrites an existing policy", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = await createUserAndLogin(ctx.base);
  const { default: RolePermission } = await import(
    "../src/models/rolePermission.model.js"
  );
  const { default: RbacAuditLog } = await import(
    "../src/models/rbacAuditLog.model.js"
  );
  const permissionsByRole = makeReviewedMapping();
  const migration = {
    businessName: "Test Rentals",
    actorId: admin.user.id,
    permissionsByRole,
  };

  const first = await seedRolePermissionCompatibility(migration);
  assert.equal(first.inserted, RBAC_ASSIGNABLE_ROLES.length);
  assert.equal(first.preserved, 0);
  assert.equal(first.ready, true);
  assert.equal(await RbacAuditLog.countDocuments({ action: "role.permissions.updated" }), RBAC_ASSIGNABLE_ROLES.length);

  const second = await seedRolePermissionCompatibility(migration);
  assert.equal(second.inserted, 0);
  assert.equal(second.preserved, RBAC_ASSIGNABLE_ROLES.length);
  assert.equal(second.ready, true);
  assert.equal(await RbacAuditLog.countDocuments({ action: "role.permissions.updated" }), RBAC_ASSIGNABLE_ROLES.length);

  const existingPolicy = await RolePermission.findOne({
    businessName: migration.businessName,
    role: "OPERATIONS",
  }).lean();
  await RolePermission.updateOne(
    { businessName: migration.businessName, role: "OPERATIONS" },
    {
      $set: {
        permissions: {
          ...existingPolicy.permissions,
          [PERMISSIONS.dashboard.view]: true,
        },
      },
    },
  );
  const drifted = await seedRolePermissionCompatibility(migration);
  assert.equal(drifted.inserted, 0);
  assert.ok(drifted.mismatches.includes("OPERATIONS"));
  assert.equal(
    (await RolePermission.findOne({
      businessName: migration.businessName,
      role: "OPERATIONS",
    }).lean()).permissions[PERMISSIONS.dashboard.view],
    true,
    "existing policy remains unchanged for explicit review",
  );
});

test("compatibility seeding only accepts an active Super Admin in the target business", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = await createUserAndLogin(ctx.base, {
    businessName: "Another Rentals",
  });

  await assert.rejects(
    seedRolePermissionCompatibility({
      businessName: "Test Rentals",
      actorId: admin.user.id,
      permissionsByRole: makeReviewedMapping(),
    }),
    /active Super Admin in this business/,
  );
});
