import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("App Users view is Super Admin-only by default and follows RBAC grants and revocations", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const permissionKey = "page.appUsers.view";
  const superAdmin = await createUserAndLogin(ctx.base);
  const grantedStaff = await createUserAndLogin(ctx.base, {
    role: "BOOKING_EXECUTIVE",
  });
  const revokedStaff = await createUserAndLogin(ctx.base, {
    role: "BOOKING_EXECUTIVE",
  });
  const superAdminApi = client(ctx.base, superAdmin.token);
  const grantedStaffApi = client(ctx.base, grantedStaff.token);
  const revokedStaffApi = client(ctx.base, revokedStaff.token);

  const superAdminProfile = await superAdminApi("GET", "/auth/permissions/me");
  assert.equal(superAdminProfile.status, 200);
  assert.equal(
    superAdminProfile.json.data.effectivePermissions[permissionKey],
    true,
  );

  const ungrantedProfile = await grantedStaffApi("GET", "/auth/permissions/me");
  assert.equal(ungrantedProfile.status, 200);
  assert.equal(
    ungrantedProfile.json.data.effectivePermissions[permissionKey],
    false,
  );

  const grantedPolicy = await superAdminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    {
      permissions: {
        "page.bookings.view": true,
        [permissionKey]: true,
      },
    },
  );
  assert.equal(grantedPolicy.status, 200);

  const grantedProfile = await grantedStaffApi("GET", "/auth/permissions/me");
  assert.equal(
    grantedProfile.json.data.effectivePermissions[permissionKey],
    true,
  );
  const roleGrantedProfile = await revokedStaffApi(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(
    roleGrantedProfile.json.data.effectivePermissions[permissionKey],
    true,
  );

  const revokedOverride = await superAdminApi(
    "PUT",
    `/auth/employees/${revokedStaff.user.id}/permissions`,
    { overrides: { [permissionKey]: "deny" } },
  );
  assert.equal(revokedOverride.status, 200);
  const individuallyRevokedProfile = await revokedStaffApi(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(
    individuallyRevokedProfile.json.data.effectivePermissions[permissionKey],
    false,
  );
  assert.equal(
    individuallyRevokedProfile.json.data.effectivePermissions["page.bookings.view"],
    true,
  );

  const revokedPolicy = await superAdminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    {
      permissions: {
        "page.bookings.view": true,
        [permissionKey]: false,
      },
    },
  );
  assert.equal(revokedPolicy.status, 200);
  const roleRevokedProfile = await grantedStaffApi(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(
    roleRevokedProfile.json.data.effectivePermissions[permissionKey],
    false,
  );
  assert.equal(
    roleRevokedProfile.json.data.effectivePermissions["page.bookings.view"],
    true,
  );
});
