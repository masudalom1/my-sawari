import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";
import { verifyAccessToken } from "../src/services/token.service.js";
import jwt from "jsonwebtoken";

test("RBAC management is tenant-scoped, protected, and enforced on dashboard APIs", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const employee = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const otherAdmin = await createUserAndLogin(ctx.base, {
    businessName: "Another Rentals",
  });
  const otherEmployee = await createUserAndLogin(ctx.base, {
    role: "BOOKING_EXECUTIVE",
    businessName: "Another Rentals",
  });
  const adminApi = client(ctx.base, admin.token);
  const employeeApi = client(ctx.base, employee.token);
  const otherAdminApi = client(ctx.base, otherAdmin.token);
  const otherEmployeeApi = client(ctx.base, otherEmployee.token);
  const anonymousApi = client(ctx.base);

  const ordinaryAdmin = await createUserAndLogin(ctx.base, { role: "ADMIN" });
  const ordinaryAdminApi = client(ctx.base, ordinaryAdmin.token);
  const adminRolePolicy = await adminApi(
    "PUT",
    "/auth/roles/ADMIN/permissions",
    {
      permissions: {
        "page.settings.view": true,
        "page.settings.create": true,
        "page.settings.edit": true,
        "page.settings.manageAccess": true,
      },
    },
  );
  assert.equal(adminRolePolicy.status, 200);
  const ordinaryAdminProfile = await ordinaryAdminApi(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(
    ordinaryAdminProfile.json.data.effectivePermissions["page.settings.manageAccess"],
    false,
    "protected Settings permissions remain denied even when granted in the ADMIN role policy",
  );
  for (const [method, path, body] of [
    ["GET", "/auth/roles/permissions"],
    ["GET", "/auth/employees"],
    ["POST", "/auth/employees", {}],
    ["PUT", "/auth/roles/BOOKING_EXECUTIVE/permissions", { permissions: {} }],
    ["PUT", `/auth/employees/${employee.user.id}/permissions`, { overrides: {} }],
    ["PATCH", `/auth/employees/${employee.user.id}/role`, { role: "ADMIN" }],
    ["PATCH", `/auth/employees/${employee.user.id}/role`, { role: "SUPER_ADMIN" }],
    ["DELETE", `/auth/employees/${employee.user.id}`],
  ]) {
    assert.equal(
      (await ordinaryAdminApi(method, path, body)).status,
      403,
      `${method} ${path} remains Super Admin-only even with settings grants`,
    );
  }

  const roleList = await adminApi("GET", "/auth/roles/permissions");
  assert.equal(roleList.status, 200);
  assert.equal(roleList.json.data.roles.length, 17);
  const { USER_ROLES } = await import("../src/models/user.model.js");
  assert.deepEqual(roleList.json.data.roles.map(({ role }) => role), USER_ROLES);
  assert.equal(roleList.json.data.roles.find(({ role }) => role === "SUPER_ADMIN").protected, true);
  const missingPolicy = roleList.json.data.roles.find(
    ({ role }) => role === "BOOKING_EXECUTIVE",
  );
  assert.equal(missingPolicy.configured, false);
  assert.equal(missingPolicy.policyState, "unconfigured");
  assert.equal(missingPolicy.allowedPermissionCount, 0);

  const missingAccess = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(missingAccess.json.data.configured, false);
  assert.equal(missingAccess.json.data.policyState, "unconfigured");
  assert.equal(missingAccess.json.data.effectivePermissionCount, 0);

  const overrideWithoutPolicy = await adminApi(
    "PUT",
    `/auth/employees/${employee.user.id}/permissions`,
    { overrides: { "page.revenue.view": "allow" } },
  );
  assert.equal(overrideWithoutPolicy.status, 200);
  assert.equal(
    overrideWithoutPolicy.json.data.effectivePermissions["page.revenue.view"],
    false,
    "an override cannot grant a permission missing from the role policy",
  );
  assert.equal((await employeeApi("GET", "/dashboard/bookingrevenue")).status, 403);
  assert.equal(
    (
      await adminApi(
        "PUT",
        `/auth/employees/${employee.user.id}/permissions`,
        { overrides: {} },
      )
    ).status,
    200,
  );

  const emptyPolicy = await adminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    { permissions: {} },
  );
  assert.equal(emptyPolicy.status, 200);
  assert.equal(emptyPolicy.json.data.configured, true);
  assert.equal(emptyPolicy.json.data.policyState, "no-access");
  assert.equal(emptyPolicy.json.data.allowedPermissionCount, 0);
  const emptyAccess = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(emptyAccess.json.data.configured, true);
  assert.equal(emptyAccess.json.data.policyState, "no-access");
  assert.equal(emptyAccess.json.data.rolePermissionCount, 0);
  assert.equal(emptyAccess.json.data.roleAllowedPermissionCount, 0);
  assert.equal(emptyAccess.json.data.effectivePermissionCount, 0);

  for (const [method, path, body] of [
    ["GET", "/auth/employees"],
    ["GET", "/auth/roles/permissions"],
    ["GET", "/auth/audit-history"],
    ["GET", `/auth/employees/${employee.user.id}/permissions`],
    ["POST", "/auth/employees", {}],
    ["PATCH", `/auth/employees/${employee.user.id}/role`, { role: "ADMIN" }],
    ["DELETE", `/auth/employees/${employee.user.id}`],
    ["PATCH", `/auth/employees/${employee.user.id}/status`, { accountStatus: "SUSPENDED" }],
    ["PUT", "/auth/roles/BOOKING_EXECUTIVE/permissions", { permissions: {} }],
    ["PUT", `/auth/employees/${employee.user.id}/permissions`, { overrides: {} }],
  ]) {
    assert.equal(
      (await anonymousApi(method, path, body)).status,
      401,
      `${method} ${path} requires authentication`,
    );
  }

  const forbiddenRead = await employeeApi("GET", "/auth/roles/permissions");
  assert.equal(forbiddenRead.status, 403);
  assert.equal((await employeeApi("GET", "/auth/audit-history")).status, 403);
  for (const [method, path, body] of [
    ["GET", "/auth/employees"],
    ["GET", `/auth/employees/${employee.user.id}`],
    ["GET", `/auth/employees/${employee.user.id}/permissions`],
    ["POST", "/auth/employees", {}],
    ["PATCH", `/auth/employees/${employee.user.id}/role`, { role: "ADMIN" }],
    ["DELETE", `/auth/employees/${employee.user.id}`],
    ["PATCH", `/auth/employees/${employee.user.id}/status`, { accountStatus: "SUSPENDED" }],
    ["PUT", "/auth/roles/BOOKING_EXECUTIVE/permissions", { permissions: {} }],
    ["PUT", `/auth/employees/${employee.user.id}/permissions`, { overrides: {} }],
  ]) {
    assert.equal(
      (await employeeApi(method, path, body)).status,
      403,
      `${method} ${path} is Super Admin-only`,
    );
  }
  const employeeCreateDenied = await employeeApi(
    "POST",
    "/auth/employees",
    {
      fullName: "Unauthorized User",
      mobileNumber: "9876501114",
      email: "unauthorized-user@example.test",
      password: "Password1!",
      role: "BOOKING_EXECUTIVE",
    },
  );
  assert.equal(employeeCreateDenied.status, 403);
  assert.equal(
    employeeCreateDenied.json.message,
    "You do not have permission to perform this action",
    "employee creation is rejected at the route's Super Admin boundary",
  );
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 403);
  assert.equal((await employeeApi("GET", "/qr/qr-codes")).status, 403);
  assert.equal((await employeeApi("POST", "/qr/qr-codes/bulk", {})).status, 403);

  const policy = await adminApi("PUT", "/auth/roles/BOOKING_EXECUTIVE/permissions", {
    permissions: {
      "page.dashboard.view": true,
      "page.dashboard.edit": true,
      "page.bookings.view": true,
      "page.bookings.edit": true,
      "page.revenue.view": false,
      "page.qrCodes.view": true,
      "page.qrCodes.create": true,
      "page.settings.manageAccess": true,
    },
  });
  assert.equal(policy.status, 200, policy.json.message);
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 200);
  for (const [method, path] of [
    ["GET", "/dashboard/bookingrevenue"],
    ["GET", "/dashboard/payments-history"],
    ["GET", "/dashboard/payments-history/upi"],
    ["GET", "/dashboard/payments-history/cash"],
    ["POST", "/dashboard/payments-history/upi/000000000000000000000001/verify"],
    ["POST", "/dashboard/payments-history/cash/000000000000000000000001/collect"],
  ]) {
    assert.equal(
      (await employeeApi(method, path, method === "GET" ? undefined : {})).status,
      403,
      `${method} ${path} must reject a role without its page or action grant`,
    );
  }
  const { default: requirePermission } = await import(
    "../src/middlewares/requirePermission.middleware.js"
  );
  assert.throws(() => requirePermission("missingModule", "view"), TypeError);
  const twoPartGate = requirePermission("bookings", "view");
  const gateRequest = {
    user: {
      ...employee.user,
      _id: employee.user.id,
      businessName: "Test Rentals",
      permissionOverrides: {},
    },
  };
  const middlewareResult = await new Promise((resolve) => {
    twoPartGate(
      gateRequest,
      {},
      (error) => resolve(error || null),
    );
  });
  assert.equal(middlewareResult, null);
  assert.equal(gateRequest.permission.key, "page.bookings.view");
  assert.equal(
    (await employeeApi("DELETE", "/vehicles/delete/000000000000000000000001")).status,
    403,
    "record deletion requires dashboard.delete rather than dashboard.edit",
  );
  assert.equal(
    (await employeeApi("DELETE", "/handover/delete/000000000000000000000001")).status,
    403,
    "handover deletion requires bookings.delete rather than bookings.edit",
  );
  const { default: RolePermission } = await import("../src/models/rolePermission.model.js");
  const originalFindOne = RolePermission.findOne;
  let permissionPolicyReads = 0;
  RolePermission.findOne = function (...args) {
    permissionPolicyReads += 1;
    return originalFindOne.apply(this, args);
  };
  let handoverList;
  try {
    handoverList = await employeeApi("GET", "/handover/receive-list");
  } finally {
    RolePermission.findOne = originalFindOne;
  }
  assert.equal(handoverList.status, 200, handoverList.json.message);
  assert.equal(
    permissionPolicyReads,
    1,
    "multiple route guards in one request reuse a single permission resolution",
  );
  const originalPolicy = await RolePermission.findOne({
    businessName: "Test Rentals",
    role: "BOOKING_EXECUTIVE",
  }).lean();
  assert.equal(originalPolicy.updatedBy.toString(), admin.user.id);

  const revokedPermission = await adminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    { permissions: { "page.dashboard.view": false } },
  );
  assert.equal(revokedPermission.status, 200);
  assert.equal(
    (await employeeApi("GET", "/dashboard/stats")).status,
    403,
    "role default changes apply to the existing access token on its next request",
  );
  const restoredPermission = await adminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    { permissions: originalPolicy.permissions },
  );
  assert.equal(restoredPermission.status, 200);
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 200);

  const otherTenantPolicy = await otherAdminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    { permissions: { "page.dashboard.view": false } },
  );
  assert.equal(otherTenantPolicy.status, 200, otherTenantPolicy.json.message);
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 200);
  const employeeAccessProfile = await employeeApi(
    "GET",
    `/auth/permissions/me?userId=${encodeURIComponent(otherEmployee.user.id)}`,
  );
  assert.equal(employeeAccessProfile.status, 200);
  assert.deepEqual(employeeAccessProfile.json.data.user, {
    id: employee.user.id,
    role: employee.user.role,
  });
  assert.equal(employeeAccessProfile.json.data.role, employee.user.role);
  assert.equal(
    employeeAccessProfile.json.data.rolePermissions["page.revenue.view"],
    false,
  );
  assert.equal(
    employeeAccessProfile.json.data.effectivePermissions["page.settings.view"],
    false,
    "a Booking Executive profile never receives the Super Admin policy",
  );
  assert.equal(
    employeeAccessProfile.json.data.effectivePermissions["page.dashboard.view"],
    true,
    "another business's role policy does not alter this user's profile",
  );
  assert.deepEqual(Object.keys(employeeAccessProfile.json.data.user).sort(), ["id", "role"]);
  assert.match(employeeAccessProfile.headers.get("cache-control"), /private/);
  assert.match(employeeAccessProfile.headers.get("cache-control"), /no-store/);
  assert.match(employeeAccessProfile.headers.get("vary"), /Authorization/);
  assert.match(employeeAccessProfile.headers.get("vary"), /Cookie/);

  const otherTenantAccessProfile = await otherEmployeeApi(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(otherTenantAccessProfile.status, 200);
  assert.deepEqual(otherTenantAccessProfile.json.data.user, {
    id: otherEmployee.user.id,
    role: otherEmployee.user.role,
  });
  assert.equal(
    otherTenantAccessProfile.json.data.effectivePermissions["page.dashboard.view"],
    false,
    "the profile uses the authenticated user's own business role policy",
  );
  assert.equal(
    otherTenantAccessProfile.json.data.rolePermissions["page.dashboard.view"],
    false,
  );
  assert.equal("businessName" in otherTenantAccessProfile.json.data.user, false);

  const isolatedPolicy = await RolePermission.findOne({
    businessName: "Another Rentals",
    role: "BOOKING_EXECUTIVE",
  }).lean();
  assert.equal(isolatedPolicy.updatedBy.toString(), otherAdmin.user.id);
  assert.equal(isolatedPolicy.permissions["page.dashboard.view"], false);
  assert.equal(
    (await RolePermission.findById(originalPolicy._id).lean()).permissions[
      "page.dashboard.view"
    ],
    true,
  );
  const otherTenantAudit = await otherAdminApi("GET", "/auth/audit-history");
  assert.equal(otherTenantAudit.status, 200);
  assert.ok(
    otherTenantAudit.json.data.events.every(
      (event) => event.businessName === "Another Rentals",
    ),
  );

  assert.equal((await employeeApi("GET", "/qr/qr-codes")).status, 200);
  const qrCreate = await employeeApi("POST", "/qr/qr-codes/bulk", {
    batchName: "RBAC test",
    codes: ["A2BCDE"],
  });
  assert.equal(qrCreate.status, 201);
  const publicClaim = await client(ctx.base)(
    "POST",
    "/qr/qr-codes/A2BCDE/claim",
    {
      businessName: "Public Claim",
      ownerName: "QR User",
      mobile: "9876543210",
      category: "Travel",
      location: "Bengaluru",
    },
  );
  assert.equal(publicClaim.status, 201);

  const customEmployee = await adminApi("POST", "/auth/employees", {
    fullName: "Custom Access User",
    mobileNumber: "9876501111",
    email: "custom.access@example.test",
    password: "Password1!",
    role: "BOOKING_EXECUTIVE",
    overrides: { "page.dashboard.view": "allow" },
  });
  assert.equal(customEmployee.status, 201, customEmployee.json.message);
  const { default: User } = await import("../src/models/user.model.js");
  const createdOverrideUser = await User.findById(customEmployee.json.data.user.id).lean();
  assert.equal(createdOverrideUser.permissionOverridesUpdatedBy.toString(), admin.user.id);
  assert.ok(createdOverrideUser.permissionOverridesUpdatedAt instanceof Date);

  const protectedCreateOverride = await adminApi("POST", "/auth/employees", {
    fullName: "Protected Override User",
    mobileNumber: "9876501112",
    email: "protected.override@example.test",
    password: "Password1!",
    role: "BOOKING_EXECUTIVE",
    overrides: { "page.settings.manageAccess": "allow" },
  });
  assert.equal(protectedCreateOverride.status, 400);

  const customLogin = await client(ctx.base)("POST", "/auth/login", {
    emailOrMobile: "custom.access@example.test",
    password: "Password1!",
  });
  assert.equal(customLogin.status, 200, customLogin.json.message);
  const existingCustomSession = client(
    ctx.base,
    customLogin.json.data.accessToken,
  );
  const customToken = customLogin.json.data.accessToken;
  const customTokenClaims = verifyAccessToken(customToken);
  assert.equal(String(customTokenClaims.userId), customEmployee.json.data.user.id);
  assert.equal(customTokenClaims.role, undefined);
  assert.equal(customTokenClaims.email, undefined);
  const customAccess = await client(ctx.base, customLogin.json.data.accessToken)(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(customLogin.json.data.user.role, "BOOKING_EXECUTIVE");
  assert.equal(customAccess.json.data.user.id, customEmployee.json.data.user.id);
  assert.equal(customAccess.json.data.user.role, customLogin.json.data.user.role);
  assert.equal(
    customAccess.json.data.effectivePermissions["page.dashboard.view"],
    true,
  );

  const employeeId = employee.user.id;
  const selfOverride = await adminApi(
    "PUT",
    `/auth/employees/${admin.user.id}/permissions`,
    { overrides: { "page.bookings.view": "allow" } },
  );
  assert.equal(selfOverride.status, 403);

  const override = await adminApi("PUT", `/auth/employees/${employeeId}/permissions`, {
    overrides: {
      "page.dashboard.view": "deny",
      "page.revenue.view": "allow",
    },
  });
  assert.equal(override.status, 200, override.json.message);
  assert.equal(override.json.data.effectivePermissions["page.dashboard.view"], false);
  assert.equal(override.json.data.effectivePermissions["page.revenue.view"], true);
  assert.equal(override.json.data.overridesUpdatedBy, admin.user.id);
  assert.ok(override.json.data.overridesUpdatedAt);
  assert.equal((await employeeApi("GET", "/dashboard/stats")).status, 403);
  assert.equal(
    (await employeeApi("GET", "/dashboard/import")).status,
    403,
    "a revenue override cannot expose dashboard vehicle data",
  );
  assert.equal(
    (await employeeApi("GET", "/dashboard/payments/import")).status,
    200,
    "the same revenue grant remains usable on revenue endpoints",
  );

  const protectedOverride = await adminApi(
    "PUT",
    `/auth/employees/${employeeId}/permissions`,
    { overrides: { "page.settings.manageAccess": "allow" } },
  );
  assert.equal(protectedOverride.status, 400);
  const inherited = await adminApi(
    "PUT",
    `/auth/employees/${employeeId}/permissions`,
    { overrides: { "page.dashboard.view": "inherit" } },
  );
  assert.equal(inherited.status, 200);
  assert.equal(inherited.json.data.overrides["page.dashboard.view"], undefined);
  assert.equal(inherited.json.data.effectivePermissions["page.dashboard.view"], true);

  const currentAccess = await employeeApi("GET", "/auth/permissions/me");
  assert.equal(currentAccess.status, 200);
  assert.equal(currentAccess.json.data.effectivePermissions["page.revenue.view"], false);
  assert.equal(
    currentAccess.json.data.effectivePermissions["page.settings.manageAccess"],
    false,
  );
  assert.equal(
    (await employeeApi("GET", "/auth/roles/permissions")).status,
    403,
    "role grants cannot bypass Super Admin-only RBAC APIs",
  );
  const overrideBeforeRoleChange = await adminApi(
    "PUT",
    `/auth/employees/${employeeId}/permissions`,
    { overrides: { "page.revenue.view": "allow" } },
  );
  assert.equal(overrideBeforeRoleChange.status, 200);

  const invalidKey = await adminApi("PUT", "/auth/roles/BOOKING_EXECUTIVE/permissions", {
    permissions: { "page.unknown.view": true },
  });
  assert.equal(invalidKey.status, 400);

  const otherTenant = await otherAdminApi(
    "GET",
    `/auth/employees/${employeeId}/permissions`,
  );
  assert.equal(otherTenant.status, 404);
  const crossTenantRoleUpdate = await otherAdminApi(
    "PATCH",
    `/auth/employees/${employeeId}/role`,
    { role: "ADMIN" },
  );
  assert.equal(crossTenantRoleUpdate.status, 404);
  assert.equal((await User.findById(employeeId).lean()).role, "BOOKING_EXECUTIVE");
  const overridesBeforeRoleChange = await adminApi(
    "GET",
    `/auth/employees/${employeeId}/permissions`,
  );
  assert.equal(overridesBeforeRoleChange.status, 200);

  const promotion = await adminApi("PATCH", `/auth/employees/${employeeId}/role`, {
    role: "SUPER_ADMIN",
  });
  assert.equal(promotion.status, 200, promotion.json.message);
  assert.equal(promotion.json.data.role, "SUPER_ADMIN");
  const promotionReversed = await adminApi(
    "PATCH",
    `/auth/employees/${employeeId}/role`,
    { role: "BOOKING_EXECUTIVE" },
  );
  assert.equal(promotionReversed.status, 200, promotionReversed.json.message);
  const promotedEmployeeAccess = await adminApi(
    "GET",
    `/auth/employees/${employeeId}/permissions`,
  );
  assert.equal(promotedEmployeeAccess.status, 200);
  assert.deepEqual(
    promotedEmployeeAccess.json.data.overrides,
    overridesBeforeRoleChange.json.data.overrides,
    "promotion and demotion preserve user-specific permission overrides",
  );

  const unconfiguredSuperAdminPermissions = await adminApi(
    "PUT",
    "/auth/roles/SUPER_ADMIN/permissions",
    { permissions: {} },
  );
  assert.equal(unconfiguredSuperAdminPermissions.status, 403);

  const publicSuperAdminRegistration = await client(ctx.base)("POST", "/auth/register", {
    fullName: "Untrusted Admin",
    mobileNumber: "9876543210",
    email: "untrusted-admin@example.test",
    businessName: "Test Rentals",
    password: "Password1!",
    confirmPassword: "Password1!",
    role: "SUPER_ADMIN",
  });
  assert.equal(publicSuperAdminRegistration.status, 401);
  const publicAdminRegistration = await client(ctx.base)("POST", "/auth/register", {
    fullName: "Untrusted Tenant Admin",
    mobileNumber: "9876543211",
    email: "untrusted-tenant-admin@example.test",
    businessName: "Test Rentals",
    password: "Password1!",
    confirmPassword: "Password1!",
    role: "ADMIN",
  });
  assert.equal(publicAdminRegistration.status, 401);
  assert.equal(
    await User.findOne({ email: "untrusted-tenant-admin@example.test" }),
    null,
  );
  assert.equal(
    (await client(ctx.base)("POST", "/auth/reset-password", {
      email: admin.email,
      password: "AttackerPassword1!",
    })).status,
    401,
  );

  const createdSuperAdmin = await adminApi("POST", "/auth/employees", {
    fullName: "Another Admin",
    mobileNumber: "9876500000",
    email: "another-admin@example.test",
    password: "Password1!",
    role: "SUPER_ADMIN",
  });
  assert.equal(createdSuperAdmin.status, 400);
  const scopedRegistration = await adminApi("POST", "/auth/register", {
    fullName: "Scoped Registration",
    mobileNumber: "9876501113",
    email: "scoped-registration@example.test",
    businessName: "Another Rentals",
    password: "Password1!",
    role: "BOOKING_EXECUTIVE",
  });
  assert.equal(scopedRegistration.status, 403);
  assert.equal(await User.findOne({ email: "scoped-registration@example.test" }), null);

  const validCreatedEmployee = await adminApi("POST", "/auth/employees", {
    fullName: "Validated API User",
    mobileNumber: "9876501113",
    email: "validated-api-user@example.test",
    businessName: "Test Rentals",
    password: "Password1!",
    role: "BOOKING_EXECUTIVE",
  });
  assert.equal(validCreatedEmployee.status, 201, validCreatedEmployee.json.message);
  assert.deepEqual(
    Object.keys(validCreatedEmployee.json.data.user).sort(),
    ["email", "fullName", "id", "mobileNumber", "role"],
  );
  const validatedUserRecord = await User.findById(
    validCreatedEmployee.json.data.user.id,
  ).select("+password");
  assert.equal(validatedUserRecord.businessName, "Test Rentals");
  assert.notEqual(validatedUserRecord.password, "Password1!");
  assert.equal(await validatedUserRecord.comparePassword("Password1!"), true);
  const listedEmployees = await adminApi("GET", "/auth/employees");
  assert.equal(listedEmployees.status, 200);
  const listedCreatedUser = listedEmployees.json.data.find(
    ({ _id }) => _id === validCreatedEmployee.json.data.user.id,
  );
  assert.ok(listedCreatedUser);
  assert.equal("password" in listedCreatedUser, false);
  assert.equal(
    listedEmployees.json.data.some(({ _id }) => _id === admin.user.id),
    false,
  );
  const createdUserDetails = await adminApi(
    "GET",
    `/auth/employees/${validCreatedEmployee.json.data.user.id}`,
  );
  assert.equal(createdUserDetails.status, 200);
  assert.equal(createdUserDetails.json.data.user.role, "BOOKING_EXECUTIVE");

  const createApiUser = (overrides = {}) =>
    adminApi("POST", "/auth/employees", {
      fullName: "Invalid API User",
      mobileNumber: "9876501115",
      email: "invalid-api-user@example.test",
      password: "Password1!",
      role: "BOOKING_EXECUTIVE",
      ...overrides,
    });
  assert.equal((await createApiUser({ fullName: "x" })).status, 400);
  assert.equal((await createApiUser({ email: "invalid-email" })).status, 400);
  assert.equal((await createApiUser({ mobileNumber: "123" })).status, 400);
  assert.equal((await createApiUser({ role: "UNKNOWN_ROLE" })).status, 400);
  assert.equal((await createApiUser({ password: "password" })).status, 400);
  assert.equal((await createApiUser({ confirmPassword: "DifferentPassword2!" })).status, 400);
  assert.equal((await createApiUser({ branchId: "000000000000000000000001" })).status, 400);
  assert.equal(
    (
      await adminApi("POST", "/auth/employees", {
        fullName: "Cross Tenant API User",
        mobileNumber: "9876501116",
        email: "cross-tenant-api-user@example.test",
        password: "Password1!",
        role: "BOOKING_EXECUTIVE",
        businessName: "Another Rentals",
      })
    ).status,
    403,
  );
  assert.equal(
    (await createApiUser({ email: "validated-api-user@example.test" })).status,
    409,
    "duplicate email is rejected according to the existing global unique index",
  );
  assert.equal(
    (await createApiUser({ mobileNumber: "9876501113" })).status,
    409,
    "duplicate mobile numbers are rejected according to the existing global unique index",
  );

  const peerSuperAdmin = await createUserAndLogin(ctx.base);
  assert.equal(
    (
      await adminApi("PATCH", "/auth/employees/not-an-object-id/role", {
        role: "ADMIN",
      })
    ).status,
    400,
    "malformed employee IDs are rejected before database lookup",
  );
  assert.equal(
    (
      await adminApi("PATCH", `/auth/employees/${peerSuperAdmin.user.id}/role`, {
        role: "UNKNOWN_ROLE",
      })
    ).status,
    400,
    "role changes validate against the backend role allowlist",
  );
  assert.equal(
    (await adminApi("DELETE", "/auth/employees/not-an-object-id")).status,
    400,
    "malformed employee IDs are rejected",
  );
  assert.equal(
    (await adminApi("DELETE", `/auth/employees/${admin.user.id}`)).status,
    403,
    "a Super Admin cannot delete their own account",
  );
  assert.equal(
    (await adminApi("DELETE", "/auth/employees/ffffffffffffffffffffffff")).status,
    404,
    "a valid ID with no matching employee returns not found",
  );
  assert.equal(
    (
      await adminApi("PATCH", `/auth/employees/${peerSuperAdmin.user.id}/status`, {
        accountStatus: "SUSPENDED",
      })
    ).status,
    403,
    "a Super Admin cannot deactivate another Super Admin, including the last active administrator",
  );
  const peerDemoted = await adminApi(
    "PATCH",
    `/auth/employees/${peerSuperAdmin.user.id}/role`,
    { role: "ADMIN" },
  );
  assert.equal(peerDemoted.status, 200, peerDemoted.json.message);
  assert.equal(peerDemoted.json.data.role, "ADMIN");
  const peerPromoted = await adminApi(
    "PATCH",
    `/auth/employees/${peerSuperAdmin.user.id}/role`,
    { role: "SUPER_ADMIN" },
  );
  assert.equal(peerPromoted.status, 200, peerPromoted.json.message);
  assert.equal(peerPromoted.json.data.role, "SUPER_ADMIN");
  const selfDemoted = await adminApi(
    "PATCH",
    `/auth/employees/${admin.user.id}/role`,
    { role: "ADMIN" },
  );
  assert.equal(selfDemoted.status, 200, selfDemoted.json.message);
  assert.equal(
    (await adminApi("GET", "/auth/employees")).status,
    403,
    "a role change takes effect on subsequent requests using the existing access token",
  );
  const selfPromoted = await client(ctx.base, peerSuperAdmin.token)(
    "PATCH",
    `/auth/employees/${admin.user.id}/role`,
    { role: "SUPER_ADMIN" },
  );
  assert.equal(selfPromoted.status, 200, selfPromoted.json.message);
  const peerDeleteResults = await Promise.all([
    adminApi("DELETE", `/auth/employees/${peerSuperAdmin.user.id}`),
    adminApi("DELETE", `/auth/employees/${peerSuperAdmin.user.id}`),
  ]);
  assert.equal(peerDeleteResults.filter(({ status }) => status === 200).length, 1);
  assert.equal(
    peerDeleteResults.filter(({ status }) => status === 404 || status === 409).length,
    1,
  );
  const peerDelete = peerDeleteResults.find(({ status }) => status === 200);
  assert.equal(peerDelete.json.data.user.accountStatus, "DELETED");
  const deletedPeer = await User.findById(peerSuperAdmin.user.id)
    .select("accountStatus deletedAt refreshToken")
    .lean();
  assert.equal(deletedPeer.accountStatus, "DELETED");
  assert.ok(deletedPeer.deletedAt);
  assert.equal(deletedPeer.refreshToken, null);
  assert.equal((await client(ctx.base, peerSuperAdmin.token)("GET", "/auth/me")).status, 403);
  const auditLogModel = (await import("../src/models/rbacAuditLog.model.js")).default;
  assert.equal(
    await auditLogModel.countDocuments({
      action: "user.deleted",
      targetUser: peerSuperAdmin.user.id,
      actor: admin.user.id,
    }),
    1,
    "the successful deletion is audited exactly once with its actor and target",
  );

  const soloSuperAdmin = await createUserAndLogin(ctx.base, {
    businessName: "Solo Rentals",
  });
  const soloAdminApi = client(ctx.base, soloSuperAdmin.token);
  const lastAdminDelete = await soloAdminApi(
    "DELETE",
    `/auth/employees/${soloSuperAdmin.user.id}`,
  );
  assert.equal(lastAdminDelete.status, 403);
  assert.match(lastAdminDelete.json.message, /cannot delete your own account/);
  const soloAdminRoleChange = await soloAdminApi(
    "PATCH",
    `/auth/employees/${soloSuperAdmin.user.id}/role`,
    { role: "ADMIN" },
  );
  assert.equal(soloAdminRoleChange.status, 409);
  assert.match(soloAdminRoleChange.json.message, /last active Super Admin/);

  const roleUpdated = await adminApi(
    "PATCH",
    `/auth/employees/${customEmployee.json.data.user.id}/role`,
    { role: "SALES_EXECUTIVE" },
  );
  assert.equal(roleUpdated.status, 200);
  const legacyTokenWithStaleRole = jwt.sign(
    {
      userId: customTokenClaims.userId,
      email: customLogin.json.data.user.email,
      role: "BOOKING_EXECUTIVE",
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "1h" },
  );
  const legacySession = client(ctx.base, legacyTokenWithStaleRole);
  const mongoUserAfterRoleChange = await User.findById(
    customEmployee.json.data.user.id,
  ).select("fullName email mobileNumber businessName role accountStatus permissionOverrides").lean();
  assert.equal(mongoUserAfterRoleChange.role, "SALES_EXECUTIVE");
  assert.equal(mongoUserAfterRoleChange.fullName, "Custom Access User");
  assert.equal(mongoUserAfterRoleChange.email, "custom.access@example.test");
  assert.equal(mongoUserAfterRoleChange.mobileNumber, "9876501111");
  assert.equal(mongoUserAfterRoleChange.businessName, "Test Rentals");
  assert.equal(mongoUserAfterRoleChange.accountStatus, "ACTIVE");
  assert.deepEqual(
    mongoUserAfterRoleChange.permissionOverrides,
    { "page.dashboard.view": "allow" },
  );
  assert.equal(roleUpdated.json.data._id, customEmployee.json.data.user.id);
  assert.equal(roleUpdated.json.data.role, "SALES_EXECUTIVE");

  const legacyTokenAccess = await legacySession("GET", "/auth/permissions/me");
  assert.equal(legacyTokenAccess.status, 200);
  assert.equal(legacyTokenAccess.json.data.role, "SALES_EXECUTIVE");
  assert.equal(
    legacyTokenAccess.json.data.user.id,
    customEmployee.json.data.user.id,
  );

  const currentUserAfterRoleChange = await existingCustomSession(
    "GET",
    "/auth/me",
  );
  assert.equal(currentUserAfterRoleChange.status, 200);
  assert.equal(
    currentUserAfterRoleChange.json.data.user.id,
    customEmployee.json.data.user.id,
  );
  assert.equal(currentUserAfterRoleChange.json.data.user.role, "SALES_EXECUTIVE");

  const roleAfterChange = await existingCustomSession(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(roleAfterChange.status, 200);
  assert.equal(
    roleAfterChange.json.data.role,
    "SALES_EXECUTIVE",
    "an existing token resolves the user's current database role",
  );
  assert.deepEqual(roleAfterChange.json.data.user, {
    id: customEmployee.json.data.user.id,
    role: "SALES_EXECUTIVE",
  });
  assert.equal(roleAfterChange.json.data.role, "SALES_EXECUTIVE");
  assert.equal(verifyAccessToken(customToken).role, undefined);

  const profileUpdated = await adminApi(
    "PATCH",
    `/auth/employees/${employeeId}`,
    { fullName: "Updated Test Employee" },
  );
  assert.equal(profileUpdated.status, 200);

  const suspended = await adminApi("PATCH", `/auth/employees/${employeeId}/status`, {
    accountStatus: "SUSPENDED",
  });
  assert.equal(suspended.status, 200);
  assert.equal(
    (await employeeApi("GET", "/auth/permissions/me")).status,
    403,
    "deactivation immediately rejects an already-issued access token",
  );
  const reactivated = await adminApi("PATCH", `/auth/employees/${employeeId}/status`, {
    accountStatus: "ACTIVE",
  });
  assert.equal(reactivated.status, 200);
  assert.equal(
    (await employeeApi("GET", "/auth/permissions/me")).status,
    200,
    "reactivation allows the still-valid session to resolve current permissions",
  );
  const suspendedAgain = await adminApi(
    "PATCH",
    `/auth/employees/${employeeId}/status`,
    { accountStatus: "SUSPENDED" },
  );
  assert.equal(suspendedAgain.status, 200);
  const login = await client(ctx.base)("POST", "/auth/login", {
    emailOrMobile: employee.email,
    password: employee.password,
  });
  assert.equal(login.status, 403);

  assert.equal((await employeeApi("GET", "/auth/audit-history")).status, 403);
  const wrongCurrentPassword = await adminApi("POST", "/auth/reset-password", {
    currentPassword: "WrongCurrentPassword1!",
    newPassword: "UpdatedPassword2!",
    email: employee.email,
  });
  assert.equal(wrongCurrentPassword.status, 401);
  const changedPassword = await adminApi("POST", "/auth/reset-password", {
    currentPassword: admin.password,
    newPassword: "UpdatedPassword2!",
    email: employee.email,
  });
  assert.equal(changedPassword.status, 200);
  assert.equal(
    await (await User.findById(employeeId).select("+password")).comparePassword(employee.password),
    true,
    "a submitted email cannot redirect a password change to another account",
  );
  assert.equal(
    (await client(ctx.base)("POST", "/auth/login", {
      emailOrMobile: admin.email,
      password: admin.password,
    })).status,
    401,
  );
  assert.equal(
    (await client(ctx.base)("POST", "/auth/login", {
      emailOrMobile: admin.email,
      password: "UpdatedPassword2!",
    })).status,
    200,
  );

  const auditHistory = await adminApi("GET", "/auth/audit-history?limit=100");
  assert.equal(auditHistory.status, 200);
  const auditActions = new Set(
    auditHistory.json.data.events.map(({ action }) => action),
  );
  for (const action of [
    "user.created",
    "user.updated",
    "user.role.updated",
    "user.status.updated",
    "user.overrides.updated",
    "user.password.changed",
    "role.permissions.updated",
  ]) {
    assert.ok(auditActions.has(action), `audit history includes ${action}`);
  }
  const events = auditHistory.json.data.events;
  const createdEvent = events.find(
    ({ action, targetUser }) =>
      action === "user.created" &&
      String(targetUser) === validCreatedEmployee.json.data.user.id,
  );
  assert.ok(createdEvent, "employee creation has an audit event");
  assert.equal(createdEvent.actor, admin.user.id);
  assert.equal(createdEvent.businessName, admin.user.businessName);
  assert.deepEqual(createdEvent.changes.role, {
    from: null,
    to: "BOOKING_EXECUTIVE",
  });
  assert.equal("password" in createdEvent.changes, false);

  const statusEvents = events.filter(
    ({ action, targetUser }) =>
      action === "user.status.updated" && String(targetUser) === employeeId,
  );
  assert.deepEqual(
    statusEvents.map(({ actor, businessName, changes }) => ({
      actor,
      businessName,
      from: changes.accountStatus.from,
      to: changes.accountStatus.to,
    })),
    [
      {
        actor: admin.user.id,
        businessName: admin.user.businessName,
        from: "ACTIVE",
        to: "SUSPENDED",
      },
      {
        actor: admin.user.id,
        businessName: admin.user.businessName,
        from: "SUSPENDED",
        to: "ACTIVE",
      },
      {
        actor: admin.user.id,
        businessName: admin.user.businessName,
        from: "ACTIVE",
        to: "SUSPENDED",
      },
    ],
  );
  const roleChangeEvent = events.find(
    ({ action, targetUser }) =>
      action === "user.role.updated" &&
      String(targetUser) === customEmployee.json.data.user.id,
  );
  assert.deepEqual(roleChangeEvent.changes.role, {
    from: "BOOKING_EXECUTIVE",
    to: "SALES_EXECUTIVE",
  });
  const rolePermissionEvent = events.find(
    ({ action, targetRole }) =>
      action === "role.permissions.updated" &&
      targetRole === "BOOKING_EXECUTIVE",
  );
  assert.ok(rolePermissionEvent.changes.permissions.from);
  assert.ok(rolePermissionEvent.changes.permissions.to);
  const overrideEvent = events.find(
    ({ action, targetUser }) =>
      action === "user.overrides.updated" &&
      String(targetUser) === employeeId,
  );
  assert.ok(overrideEvent, "user override changes retain previous/new values");
  assert.equal(overrideEvent.targetType, "user");
  assert.ok(overrideEvent.targetUser);
  assert.equal(overrideEvent.actor, admin.user.id);
  assert.equal(overrideEvent.businessName, admin.user.businessName);
  assert.deepEqual(overrideEvent.changes.overrides, {
    from: {},
    to: { "page.revenue.view": "allow" },
  });
  assert.equal(
    JSON.stringify(events).includes("UpdatedPassword2!"),
    false,
    "audit history never records password values",
  );
  assert.equal(
    JSON.stringify(events).includes("Password1!"),
    false,
    "audit history never records created or login passwords",
  );
  assert.equal(
    (await adminApi("GET", "/auth/audit-history?limit=101")).status,
    400,
  );

  const { default: RbacAuditLog } = await import("../src/models/rbacAuditLog.model.js");
  const auditEvent = auditHistory.json.data.events[0];
  await assert.rejects(
    RbacAuditLog.updateOne(
      { _id: auditEvent._id },
      { $set: { action: "user.created" } },
    ).exec(),
    /append-only/,
  );

  const unscopedAdmin = await createUserAndLogin(ctx.base, {
    businessName: "Legacy Unscoped Rentals",
  });
  await User.updateOne(
    { _id: unscopedAdmin.user.id },
    { $unset: { businessName: 1 } },
  );
  const unscopedAdminApi = client(ctx.base, unscopedAdmin.token);
  assert.equal((await unscopedAdminApi("GET", "/auth/employees")).status, 403);
  assert.equal(
    (
      await unscopedAdminApi("PATCH", `/auth/employees/${employeeId}/role`, {
        role: "ADMIN",
      })
    ).status,
    403,
  );
  assert.equal((await User.findById(employeeId).lean()).role, "BOOKING_EXECUTIVE");
});
