import User from "../models/user.model.js";
import RolePermission from "../models/rolePermission.model.js";
import { recordRbacAudit } from "./rbacAudit.service.js";
import {
  RBAC_ASSIGNABLE_ROLES,
  RBAC_PERMISSION_KEYS,
  PERMISSIONS,
  toPlainPermissionMap,
} from "../config/rbacPermissions.js";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateCompatibilityPermissionMap(value) {
  if (!isPlainObject(value)) {
    throw new TypeError("Compatibility mapping must be a role-to-permission object");
  }

  const suppliedRoles = Object.keys(value).sort();
  const expectedRoles = [...RBAC_ASSIGNABLE_ROLES].sort();
  if (
    suppliedRoles.length !== expectedRoles.length ||
    suppliedRoles.some((role, index) => role !== expectedRoles[index])
  ) {
    throw new TypeError(
      "Compatibility mapping must include every assignable role and exclude SUPER_ADMIN",
    );
  }

  const normalized = {};
  for (const role of RBAC_ASSIGNABLE_ROLES) {
    const permissions = value[role];
    if (!isPlainObject(permissions)) {
      throw new TypeError(`Compatibility permissions for ${role} must be an object`);
    }

    const suppliedKeys = Object.keys(permissions).sort();
    const expectedKeys = [...RBAC_PERMISSION_KEYS].sort();
    if (
      suppliedKeys.length !== expectedKeys.length ||
      suppliedKeys.some((key, index) => key !== expectedKeys[index]) ||
      !RBAC_PERMISSION_KEYS.every((key) => typeof permissions[key] === "boolean")
    ) {
      throw new TypeError(
        `Compatibility permissions for ${role} must explicitly define every registered key`,
      );
    }

    if (Object.values(permissions).every(Boolean)) {
      throw new TypeError(`${role} cannot receive an all-allow compatibility policy`);
    }

    for (const key of Object.values(PERMISSIONS.settings)) {
      if (permissions[key] !== false) {
        throw new TypeError(`Settings permission ${key} is reserved for SUPER_ADMIN`);
      }
    }

    normalized[role] = Object.fromEntries(
      RBAC_PERMISSION_KEYS.map((key) => [key, permissions[key]]),
    );
  }

  return normalized;
}

function policyMatches(policy, expectedPermissions) {
  const actual = toPlainPermissionMap(policy.permissions);
  return (
    Object.keys(actual).length === RBAC_PERMISSION_KEYS.length &&
    RBAC_PERMISSION_KEYS.every(
      (key) => actual[key] === expectedPermissions[key],
    )
  );
}

export async function verifyRolePermissionCompatibility({
  businessName,
  permissionsByRole,
}) {
  const policies = await RolePermission.find({ businessName })
    .select("role permissions")
    .lean();
  const policyByRole = new Map(policies.map((policy) => [policy.role, policy]));
  const mismatches = RBAC_ASSIGNABLE_ROLES.filter((role) => {
    const policy = policyByRole.get(role);
    return !policy || !policyMatches(policy, permissionsByRole[role]);
  });

  return {
    ready: mismatches.length === 0,
    configuredRoles: RBAC_ASSIGNABLE_ROLES.length - mismatches.length,
    requiredRoles: RBAC_ASSIGNABLE_ROLES.length,
    mismatches,
  };
}

export async function seedRolePermissionCompatibility({
  businessName,
  actorId,
  permissionsByRole: inputPermissions,
}) {
  const normalizedBusinessName =
    typeof businessName === "string" ? businessName.trim() : "";
  if (!normalizedBusinessName) {
    throw new TypeError("A business scope is required");
  }

  const permissionsByRole = validateCompatibilityPermissionMap(inputPermissions);
  const actor = await User.findOne({
    _id: actorId,
    businessName: normalizedBusinessName,
    role: "SUPER_ADMIN",
    accountStatus: "ACTIVE",
    deletedAt: null,
  }).select("_id businessName");
  if (!actor) {
    throw new Error("The migration actor must be an active Super Admin in this business");
  }

  let inserted = 0;
  let preserved = 0;
  for (const role of RBAC_ASSIGNABLE_ROLES) {
    const result = await RolePermission.updateOne(
      { businessName: normalizedBusinessName, role },
      {
        $setOnInsert: {
          permissions: permissionsByRole[role],
          updatedBy: actor._id,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    if (result.upsertedCount) {
      inserted += 1;
      await recordRbacAudit({
        actor,
        action: "role.permissions.updated",
        targetType: "role",
        targetRole: role,
        changes: {
          source: "compatibility-seed",
          from: null,
          to: permissionsByRole[role],
        },
      });
    } else {
      preserved += 1;
    }
  }

  const verification = await verifyRolePermissionCompatibility({
    businessName: normalizedBusinessName,
    permissionsByRole,
  });
  return { inserted, preserved, ...verification };
}
