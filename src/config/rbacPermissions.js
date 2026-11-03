import { USER_ROLES } from "../models/user.model.js";
import {
  isRegisteredPermissionMap,
  isRegisteredUserOverrideMap,
  PERMISSIONS,
  PROTECTED_USER_OVERRIDE_KEY_SET,
  RBAC_PERMISSION_KEYS,
} from "../../shared/rbacPermissionRegistry.mjs";

export { PERMISSIONS, PROTECTED_USER_OVERRIDE_KEY_SET, RBAC_PERMISSION_KEYS };

export const RBAC_PERMISSION_KEY_SET = new Set(RBAC_PERMISSION_KEYS);
export const RBAC_ASSIGNABLE_ROLES = Object.freeze(
  USER_ROLES.filter((role) => role !== "SUPER_ADMIN"),
);

export function normalizePermissionMap(value, allowedValues = [true, false]) {
  if (!isRegisteredPermissionMap(value, allowedValues)) return null;
  const entries =
    value instanceof Map ? [...value.entries()] : Object.entries(value);
  const normalized = {};
  for (const [key, permission] of entries) normalized[key] = permission;
  return normalized;
}

export function normalizeUserPermissionOverrideMap(value) {
  if (!isRegisteredUserOverrideMap(value, ["allow", "deny", "inherit"]))
    return null;
  const entries =
    value instanceof Map ? [...value.entries()] : Object.entries(value);
  const normalized = {};
  for (const [key, permission] of entries) normalized[key] = permission;
  return normalized;
}

export function toPlainPermissionMap(value) {
  if (!value) return {};
  return value instanceof Map ? Object.fromEntries(value) : { ...value };
}

export function resolvePermissionDecision(
  rolePermissions = {},
  overrides = {},
  role,
  key,
) {
  if (!RBAC_PERMISSION_KEY_SET.has(key)) {
    return { allowed: false, configured: false, source: "unknown-permission" };
  }
  if (!USER_ROLES.includes(role)) {
    return { allowed: false, configured: false, source: "invalid-role" };
  }

  // SUPER_ADMIN is a protected virtual policy. It is independent of an
  // editable RolePermission document and any legacy stored overrides.
  if (role === "SUPER_ADMIN") {
    return { allowed: true, configured: true, source: "super-admin" };
  }

  const userOverrides = toPlainPermissionMap(overrides);
  const override = userOverrides[key];
  if (override === "deny") {
    return { allowed: false, configured: true, source: "user-override" };
  }

  if (PROTECTED_USER_OVERRIDE_KEY_SET.has(key)) {
    return { allowed: false, configured: true, source: "protected" };
  }

  const defaults = toPlainPermissionMap(rolePermissions);
  const hasRoleDefault = Object.hasOwn(defaults, key) &&
    typeof defaults[key] === "boolean";
  if (!hasRoleDefault) {
    return { allowed: false, configured: false, source: "unconfigured" };
  }

  if (override === "allow") {
    return { allowed: true, configured: true, source: "user-override" };
  }
  if (override !== undefined && override !== "inherit") {
    return { allowed: false, configured: true, source: "invalid-override" };
  }
  return {
    allowed: defaults[key] === true,
    configured: true,
    source: "role-default",
  };
}

export function getEffectivePermissions(
  rolePermissions = {},
  overrides = {},
  role,
) {
  return Object.fromEntries(
    RBAC_PERMISSION_KEYS.map((key) => [
      key,
      resolvePermissionDecision(rolePermissions, overrides, role, key).allowed,
    ]),
  );
}
