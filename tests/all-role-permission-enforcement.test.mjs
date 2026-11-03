import { test } from "node:test";
import assert from "node:assert/strict";
import { USER_ROLES } from "../shared/userRoles.mjs";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("all 17 roles resolve their defaults and enforce user overrides on existing sessions", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const superAdmin = await createUserAndLogin(ctx.base);
  const superAdminApi = client(ctx.base, superAdmin.token);

  for (const role of USER_ROLES) {
    const employee = await createUserAndLogin(ctx.base, { role });
    const employeeApi = client(ctx.base, employee.token);

    if (role === "SUPER_ADMIN") {
      const profile = await employeeApi("GET", "/auth/permissions/me");
      assert.equal(profile.status, 200);
      assert.equal(profile.json.data.user.role, role);
      assert.equal(profile.json.data.role, role);
      assert.equal(profile.json.data.configured, true);
      assert.deepEqual(profile.json.data.overrides, {});
      assert.equal(profile.json.data.rolePermissions["page.dashboard.view"], true);
      assert.equal(profile.json.data.effectivePermissions["page.dashboard.view"], true);
      assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 200);
      assert.equal((await employeeApi("GET", "/dashboard/bookingrevenue")).status, 200);
      assert.equal((await employeeApi("GET", "/auth/roles/permissions")).status, 200);
      continue;
    }

    const roleDefaults = {
      "page.dashboard.view": true,
      "page.bookings.view": true,
      "page.bookings.create": true,
      "page.revenue.view": false,
      "page.paymentsHistory.view": false,
      "page.pendingToCollect.view": false,
      "page.verifyUpiCollections.view": false,
    };
    const policy = await superAdminApi(
      "PUT",
      `/auth/roles/${role}/permissions`,
      { permissions: roleDefaults },
    );
    assert.equal(policy.status, 200, `${role} policy saves`);

    const overrides = await superAdminApi(
      "PUT",
      `/auth/employees/${employee.user.id}/permissions`,
      {
        overrides: {
          "page.bookings.view": "deny",
          "page.revenue.view": "allow",
        },
      },
    );
    assert.equal(overrides.status, 200, `${role} user overrides save`);

    const profile = await employeeApi("GET", "/auth/permissions/me");
    assert.equal(profile.status, 200, `${role} access profile resolves`);
    assert.equal(profile.json.data.user.id, employee.user.id);
    assert.equal(profile.json.data.user.role, role);
    assert.equal(profile.json.data.role, role);
    assert.deepEqual(profile.json.data.rolePermissions, roleDefaults);
    assert.deepEqual(profile.json.data.overrides, {
      "page.bookings.view": "deny",
      "page.revenue.view": "allow",
    });
    assert.equal(profile.json.data.effectivePermissions["page.dashboard.view"], true);
    assert.equal(profile.json.data.effectivePermissions["page.bookings.view"], false);
    assert.equal(profile.json.data.effectivePermissions["page.revenue.view"], true);
    assert.equal(profile.json.data.effectivePermissions["page.paymentsHistory.view"], false);
    assert.equal(profile.json.data.effectivePermissions["page.pendingToCollect.view"], false);
    assert.equal(profile.json.data.effectivePermissions["page.verifyUpiCollections.view"], false);

    assert.equal(
      (await employeeApi("GET", "/dashboard/stats")).status,
      200,
      `${role} retains explicitly granted dashboard access`,
    );
    assert.equal(
      (await employeeApi("GET", "/dashboard/bookingrevenue")).status,
      200,
      `${role} user allow overrides the denied role revenue default`,
    );
    for (const path of [
      "/leads/booking",
      "/dashboard/payments-history",
      "/dashboard/payments-history/cash",
      "/dashboard/payments-history/upi",
    ]) {
      assert.equal(
        (await employeeApi("GET", path)).status,
        403,
        `${role} is denied ${path} by its role default or user override`,
      );
    }
  }
});
