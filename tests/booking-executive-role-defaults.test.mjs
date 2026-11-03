import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  client,
  createUserAndLogin,
  dayFromToday,
} from "./helpers/harness.mjs";

test("Booking Executive role defaults deny revenue and payment pages while allowing booking creation", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const superAdmin = await createUserAndLogin(ctx.base);
  const employee = await createUserAndLogin(ctx.base, {
    role: "BOOKING_EXECUTIVE",
  });
  const superAdminApi = client(ctx.base, superAdmin.token);
  const employeeApi = client(ctx.base, employee.token);
  const revenueOverrideUrl = `/auth/employees/${employee.user.id}/permissions`;

  const savedPolicy = await superAdminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    {
      permissions: {
        "page.dashboard.view": true,
        "page.bookings.view": true,
        "page.bookings.create": true,
        "page.revenue.view": false,
        "page.paymentsHistory.view": false,
        "page.pendingToCollect.view": false,
        "page.verifyUpiCollections.view": false,
      },
    },
  );
  assert.equal(savedPolicy.status, 200, savedPolicy.json.message);
  assert.deepEqual(savedPolicy.json.data.permissions, {
    "page.dashboard.view": true,
    "page.bookings.view": true,
    "page.bookings.create": true,
    "page.revenue.view": false,
    "page.paymentsHistory.view": false,
    "page.pendingToCollect.view": false,
    "page.verifyUpiCollections.view": false,
  });

  const { default: User } = await import("../src/models/user.model.js");
  const storedEmployee = await User.findById(employee.user.id)
    .select("role permissionOverrides businessName")
    .lean();
  assert.equal(storedEmployee.role, "BOOKING_EXECUTIVE");
  assert.deepEqual(storedEmployee.permissionOverrides || {}, {});
  assert.equal(
    Object.values(storedEmployee.permissionOverrides || {}).includes("allow"),
    false,
  );
  assert.equal(storedEmployee.businessName, employee.user.businessName);

  const profile = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(profile.status, 200, profile.json.message);
  assert.equal(profile.json.data.user.id, employee.user.id);
  assert.deepEqual(profile.json.data.overrides, {});
  for (const [key, expected] of [
    ["page.dashboard.view", true],
    ["page.bookings.view", true],
    ["page.bookings.create", true],
    ["page.revenue.view", false],
    ["page.paymentsHistory.view", false],
    ["page.pendingToCollect.view", false],
    ["page.verifyUpiCollections.view", false],
  ]) {
    assert.equal(profile.json.data.effectivePermissions[key], expected, key);
  }

  for (const path of [
    "/dashboard/bookingrevenue",
    "/dashboard/payments-history",
    "/dashboard/payments-history/cash",
    "/dashboard/payments-history/upi",
  ]) {
    const response = await employeeApi("GET", path);
    assert.equal(response.status, 403, `${path} must be denied`);
  }

  const allowRevenue = await superAdminApi("PUT", revenueOverrideUrl, {
    overrides: { "page.revenue.view": "allow" },
  });
  assert.equal(allowRevenue.status, 200, allowRevenue.json.message);
  assert.equal(
    allowRevenue.json.data.effectivePermissions["page.revenue.view"],
    true,
  );
  assert.deepEqual(allowRevenue.json.data.overrides, {
    "page.revenue.view": "allow",
  });
  const revenueAllowedProfile = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(revenueAllowedProfile.status, 200);
  assert.equal(
    revenueAllowedProfile.json.data.effectivePermissions["page.revenue.view"],
    true,
    "an existing session resolves the new allow override",
  );
  assert.deepEqual(revenueAllowedProfile.json.data.overrides, {
    "page.revenue.view": "allow",
  });
  const revenueAllowedApi = await employeeApi("GET", "/dashboard/bookingrevenue");
  assert.equal(revenueAllowedApi.status, 200, revenueAllowedApi.json.message);

  const denyRevenue = await superAdminApi("PUT", revenueOverrideUrl, {
    overrides: { "page.revenue.view": "deny" },
  });
  assert.equal(denyRevenue.status, 200, denyRevenue.json.message);
  assert.equal(denyRevenue.json.data.effectivePermissions["page.revenue.view"], false);
  const revenueDeniedProfile = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(
    revenueDeniedProfile.json.data.effectivePermissions["page.revenue.view"],
    false,
    "an explicit user deny wins over the role default",
  );
  assert.equal(
    (await employeeApi("GET", "/dashboard/bookingrevenue")).status,
    403,
    "revocation takes effect on an already-issued access token",
  );

  const inheritRevenue = await superAdminApi("PUT", revenueOverrideUrl, {
    overrides: { "page.revenue.view": "inherit" },
  });
  assert.equal(inheritRevenue.status, 200, inheritRevenue.json.message);
  assert.equal(
    inheritRevenue.json.data.overrides["page.revenue.view"],
    undefined,
  );
  assert.equal(
    inheritRevenue.json.data.effectivePermissions["page.revenue.view"],
    false,
    "inherit restores the saved role default deny",
  );
  const revenueInheritedProfile = await employeeApi("GET", "/auth/permissions/me");
  assert.deepEqual(revenueInheritedProfile.json.data.overrides, {});
  assert.equal(
    revenueInheritedProfile.json.data.effectivePermissions["page.revenue.view"],
    false,
  );
  assert.equal(
    (await employeeApi("GET", "/dashboard/bookingrevenue")).status,
    403,
  );

  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 200);
  assert.equal((await employeeApi("GET", "/leads/booking")).status, 200);
  assert.equal((await employeeApi("GET", "/bookings/vehicles")).status, 200);

  const vehicle = await superAdminApi("POST", "/vehicles/create", {
    vehicleName: "RBAC Booking Fixture",
    vehicleNumber: "KA01RB1301",
    manufacturer: "Test",
    fuelType: "Petrol",
    transmission: "Manual",
    seatingCapacity: 5,
  });
  assert.equal(vehicle.status, 201, vehicle.json.message);
  const vehicleId = vehicle.json.data._id;
  assert.equal(
    (await superAdminApi("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status,
    200,
  );

  const booking = await employeeApi("POST", "/leads/create", {
    customerName: "RBAC Booking Customer",
    mobileNumber: "9876501301",
    vehicleId,
    vehicleType: "car",
    paymentMethod: "cash",
    flexibleTime: true,
    fromDate: dayFromToday(2),
    toDate: dayFromToday(3),
    pickupTime: "08:00 AM",
    dropTime: "08:00 AM",
    bookingAmount: 100,
  });
  assert.equal(booking.status, 201, booking.json.message);
  assert.ok(booking.json.booking?._id);
});
