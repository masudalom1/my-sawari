import RolePermission from "../models/rolePermission.model.js";
import {
  getEffectivePermissions,
  RBAC_PERMISSION_KEYS,
  toPlainPermissionMap,
} from "../config/rbacPermissions.js";
import { USER_ROLES } from "../models/user.model.js";
import ApiError from "../utils/ApiError.js";

const requestResolutions = new WeakMap();

export async function resolveUserPermissions(user) {
  if (!user?._id || !user.role) {
    throw new ApiError(401, "Authenticated user identity is required");
  }
  if (!USER_ROLES.includes(user.role)) {
    throw new ApiError(403, "Account role is invalid");
  }

  const isSuperAdmin = user.role === "SUPER_ADMIN";
  const businessName = user.businessName;
  if (!isSuperAdmin && !businessName) {
    throw new ApiError(403, "Permission access is not configured for this account");
  }

  let policy = null;
  if (!isSuperAdmin) {
    policy = await RolePermission.findOne({
      businessName,
      role: user.role,
    })
      .select("permissions")
      .lean();
  }

  const rolePermissions = isSuperAdmin
    ? Object.fromEntries(RBAC_PERMISSION_KEYS.map((key) => [key, true]))
    : toPlainPermissionMap(policy?.permissions);
  const overrides = toPlainPermissionMap(user.permissionOverrides);
  const effectivePermissions = getEffectivePermissions(
    rolePermissions,
    overrides,
    user.role,
  );
  const rolePermissionCount = Object.keys(rolePermissions).length;
  const roleAllowedPermissionCount = Object.values(rolePermissions).filter(
    (allowed) => allowed === true,
  ).length;

  return {
    role: user.role,
    rolePermissions,
    overrides,
    effectivePermissions,
    configured: isSuperAdmin || Boolean(policy),
    policyState: isSuperAdmin
      ? "protected"
      : !policy
        ? "unconfigured"
        : roleAllowedPermissionCount === 0
          ? "no-access"
          : "configured",
    rolePermissionCount,
    roleAllowedPermissionCount,
    effectivePermissionCount: Object.values(effectivePermissions).filter(
      (allowed) => allowed === true,
    ).length,
  };
}

export function resolveRequestPermissions(req) {
  if (!req?.user) {
    return Promise.reject(
      new ApiError(401, "Authenticated user identity is required"),
    );
  }

  let resolution = requestResolutions.get(req);
  if (!resolution) {
    resolution = resolveUserPermissions(req.user);
    requestResolutions.set(req, resolution);
  }
  return resolution;
}

export default resolveUserPermissions;
