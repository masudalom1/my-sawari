import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { resolveRequestPermissions } from "../services/permissionResolver.js";
import {
  PERMISSIONS,
  RBAC_PERMISSION_KEY_SET,
  resolvePermissionDecision,
} from "../config/rbacPermissions.js";

function normalizePermissionKeys(moduleOrKey, action) {
  const keys = action === undefined
    ? Array.isArray(moduleOrKey)
      ? moduleOrKey
      : [moduleOrKey]
    : [PERMISSIONS[moduleOrKey]?.[action]];

  if (
    keys.length === 0 ||
    keys.some((key) => typeof key !== "string" || !RBAC_PERMISSION_KEY_SET.has(key))
  ) {
    throw new TypeError("requirePermission must reference registered permission keys");
  }
  return keys;
}

export function requirePermission(moduleOrKey, action) {
  const permissionKeys = normalizePermissionKeys(moduleOrKey, action);
  return asyncHandler(async (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, "Authentication required");
    }

    const access = await resolveRequestPermissions(req);
    if (req.user.role !== "SUPER_ADMIN" && !req.user.businessName) {
      throw new ApiError(403, "Permission access is not configured for this account");
    }

    const allowedKey = permissionKeys.find(
      (key) => access.effectivePermissions[key] === true,
    );

    if (!allowedKey) {
      throw new ApiError(403, "You do not have permission to perform this action");
    }

    req.permission = {
      key: allowedKey,
      allowed: true,
      source: resolvePermissionDecision(
        access.rolePermissions,
        access.overrides,
        access.role,
        allowedKey,
      ).source,
    };
    return next();
  });
}

export default requirePermission;
