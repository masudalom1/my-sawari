import { test } from "node:test";
import assert from "node:assert/strict";
import RolePermission from "../src/models/rolePermission.model.js";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("revenue-only access cannot read dashboard vehicle, booking, or maintenance imports", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const finance = await createUserAndLogin(ctx.base, {
    role: "FINANCE_EXECUTIVE",
  });
  await RolePermission.create({
    businessName: finance.user.businessName,
    role: "FINANCE_EXECUTIVE",
    permissions: { "page.revenue.view": true },
    updatedBy: admin.user.id,
  });
  const financeApi = client(ctx.base, finance.token);

  for (const path of [
    "/dashboard/import",
    "/dashboard/bookings/import",
    "/dashboard/maintenance",
  ]) {
    const response = await financeApi("GET", path);
    assert.equal(response.status, 403, `${path} requires dashboard.view`);
  }

  const revenuePayments = await financeApi("GET", "/dashboard/payments/import");
  assert.equal(revenuePayments.status, 200, revenuePayments.json.message);
});

test("Fleet Manager View is assignable without granting vehicle create or edit", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const staff = await createUserAndLogin(ctx.base, { role: "ADMIN" });
  const adminApi = client(ctx.base, admin.token);
  const staffApi = client(ctx.base, staff.token);

  assert.equal((await staffApi("GET", "/vehicles/fleet-manager")).status, 403);

  const initialPolicy = await adminApi(
    "PUT",
    "/auth/roles/ADMIN/permissions",
    {
      permissions: {
        "page.dashboard.view": true,
        "page.vehicleManager.view": false,
      },
    },
  );
  assert.equal(initialPolicy.status, 200);
  assert.equal((await staffApi("GET", "/vehicles/all")).status, 200);
  assert.equal((await staffApi("GET", "/vehicles/fleet-manager")).status, 403);

  const grantedPolicy = await adminApi(
    "PUT",
    "/auth/roles/ADMIN/permissions",
    {
      permissions: {
        "page.dashboard.view": false,
        "page.vehicleManager.view": true,
      },
    },
  );
  assert.equal(grantedPolicy.status, 200);
  assert.equal(
    grantedPolicy.json.data.permissions["page.vehicleManager.view"],
    true,
  );
  const savedPolicies = await adminApi("GET", "/auth/roles/permissions");
  assert.equal(savedPolicies.status, 200);
  assert.equal(
    savedPolicies.json.data.roles.find(({ role }) => role === "ADMIN")
      .permissions["page.vehicleManager.view"],
    true,
  );
  const fleetManager = await staffApi("GET", "/vehicles/fleet-manager");
  assert.equal(fleetManager.status, 200);
  assert.ok(Array.isArray(fleetManager.json.stats));
  assert.equal((await staffApi("GET", "/vehicles/all")).status, 403);

  assert.equal((await staffApi("POST", "/vehicles/create")).status, 403);
  assert.equal((await staffApi("PUT", "/vehicles/update/not-an-id")).status, 403);

  const createPermission = await adminApi(
    "PUT",
    "/auth/roles/ADMIN/permissions",
    { permissions: { "page.dashboard.create": true } },
  );
  assert.equal(createPermission.status, 200);
  const vehicleForm = new FormData();
  vehicleForm.append("vehicleName", "Fleet Manager E2E Car");
  vehicleForm.append("vehicleNumber", "KA01FM1091");
  vehicleForm.append("manufacturer", "Maruti");
  vehicleForm.append("category", "car");
  vehicleForm.append("vehicleType", "SUV");
  vehicleForm.append("fuelType", "Petrol");
  vehicleForm.append("transmission", "Manual");
  vehicleForm.append("seatingCapacity", "5");
  vehicleForm.append("pricePerDay", "1000");
  const createdVehicle = await staffApi("POST", "/vehicles/create", vehicleForm);
  assert.equal(createdVehicle.status, 201, createdVehicle.json.message);
  const refreshedFleet = await staffApi(
    "GET",
    "/vehicles/fleet-manager?search=Fleet%20Manager%20E2E%20Car",
  );
  assert.equal(refreshedFleet.status, 200);
  assert.equal(refreshedFleet.json.total, 1);
  assert.equal(refreshedFleet.json.data[0]._id, createdVehicle.json.data._id);
  assert.equal(
    refreshedFleet.json.stats.find(({ _id }) => _id === "available")?.count,
    1,
  );
  assert.equal(
    (await staffApi("PUT", `/vehicles/update/${createdVehicle.json.data._id}`)).status,
    403,
  );

  const revokedPolicy = await adminApi(
    "PUT",
    "/auth/roles/ADMIN/permissions",
    { permissions: { "page.vehicleManager.view": false } },
  );
  assert.equal(revokedPolicy.status, 200);
  assert.equal(
    revokedPolicy.json.data.permissions["page.vehicleManager.view"],
    false,
  );
  const reloadedRevokedPolicy = await adminApi("GET", "/auth/roles/permissions");
  assert.equal(
    reloadedRevokedPolicy.json.data.roles.find(({ role }) => role === "ADMIN")
      .permissions["page.vehicleManager.view"],
    false,
  );
  assert.equal((await staffApi("GET", "/vehicles/fleet-manager")).status, 403);

  const allowedOverride = await adminApi(
    "PUT",
    `/auth/employees/${staff.user.id}/permissions`,
    { overrides: { "page.vehicleManager.view": "allow" } },
  );
  assert.equal(allowedOverride.status, 200);
  assert.equal(
    allowedOverride.json.data.effectivePermissions["page.vehicleManager.view"],
    true,
  );
  assert.equal((await staffApi("GET", "/vehicles/fleet-manager")).status, 200);

  const deniedOverride = await adminApi(
    "PUT",
    `/auth/employees/${staff.user.id}/permissions`,
    { overrides: { "page.vehicleManager.view": "deny" } },
  );
  assert.equal(deniedOverride.status, 200);
  assert.equal(
    deniedOverride.json.data.effectivePermissions["page.vehicleManager.view"],
    false,
  );
  assert.equal((await staffApi("GET", "/vehicles/fleet-manager")).status, 403);
});
