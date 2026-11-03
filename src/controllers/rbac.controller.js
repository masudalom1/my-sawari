import validator from "validator";
import User, { USER_ROLES } from "../models/user.model.js";
import RolePermission from "../models/rolePermission.model.js";
import RbacAuditLog from "../models/rbacAuditLog.model.js";
import { recordRbacAudit } from "../services/rbacAudit.service.js";
import {
  resolveRequestPermissions,
  resolveUserPermissions,
} from "../services/permissionResolver.js";
import { getRbacEnforcementMode } from "../config/rbacEnforcement.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import {
  normalizePermissionMap,
  normalizeUserPermissionOverrideMap,
  RBAC_PERMISSION_KEYS,
  toPlainPermissionMap,
} from "../config/rbacPermissions.js";

function assertSuperAdmin(req) {
  if (req.user?.role !== "SUPER_ADMIN") {
    throw new ApiError(403, "Only Super Admin can manage access");
  }
  if (!req.user.businessName) {
    throw new ApiError(403, "A business scope is required to manage access");
  }
}

function serializeEmployee(user) {
  return {
    id: user._id,
    fullName: user.fullName,
    email: user.email,
    mobileNumber: user.mobileNumber,
    businessName: user.businessName,
    role: user.role,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

async function findTenantEmployee(req, id, fields) {
  assertSuperAdmin(req);
  const employee = await User.findOne({
    _id: id,
    businessName: req.user.businessName,
    deletedAt: null,
  }).select(fields);
  if (!employee) throw new ApiError(404, "Employee not found");
  return employee;
}

export const getRolePermissionConfiguration = asyncHandler(async (req, res) => {
  assertSuperAdmin(req);
  const policies = await RolePermission.find({
    businessName: req.user.businessName,
  }).select("role permissions updatedAt").lean();
  const policyByRole = new Map(policies.map((policy) => [policy.role, policy]));

  const roles = USER_ROLES.map((role) => {
    const policy = policyByRole.get(role);
    return {
      role,
      permissions: role === "SUPER_ADMIN"
        ? Object.fromEntries(RBAC_PERMISSION_KEYS.map((key) => [key, true]))
        : toPlainPermissionMap(policy?.permissions),
      configured: role === "SUPER_ADMIN" || Boolean(policy),
      policyState: role === "SUPER_ADMIN"
        ? "protected"
        : !policy
          ? "unconfigured"
          : Object.values(policy.permissions || {}).some((allowed) => allowed === true)
            ? "configured"
            : "no-access",
      permissionCount: role === "SUPER_ADMIN"
        ? RBAC_PERMISSION_KEYS.length
        : Object.keys(policy?.permissions || {}).length,
      allowedPermissionCount: role === "SUPER_ADMIN"
        ? RBAC_PERMISSION_KEYS.length
        : Object.values(policy?.permissions || {}).filter((allowed) => allowed === true).length,
      protected: role === "SUPER_ADMIN",
      updatedAt: policy?.updatedAt || null,
    };
  });

  res.status(200).json({ success: true, data: { roles } });
});

export const getCurrentEffectivePermissions = asyncHandler(async (req, res) => {
  const authenticatedUserId = String(req.user._id);
  const authenticatedRole = req.user.role;
  const access = await resolveRequestPermissions(req);
  if (access.role !== authenticatedRole) {
    throw new ApiError(500, "Resolved access profile does not match the authenticated account");
  }
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Authorization, Cookie",
  });
  res.status(200).json({
    success: true,
    data: {
      ...access,
      user: {
        id: authenticatedUserId,
        role: authenticatedRole,
      },
      enforcementMode: getRbacEnforcementMode(),
    },
  });
});

export const updateRolePermissionConfiguration = asyncHandler(
  async (req, res) => {
    assertSuperAdmin(req);
    const { role } = req.params;
    if (!USER_ROLES.includes(role)) throw new ApiError(400, "Invalid role");
    if (role === "SUPER_ADMIN") {
      throw new ApiError(403, "SUPER_ADMIN permissions are protected");
    }

    const permissions = normalizePermissionMap(req.body?.permissions);
    if (!permissions) {
      throw new ApiError(
        400,
        "Permissions must contain only registered permission keys with boolean values",
      );
    }

    const previousPolicy = await RolePermission.findOne({
      businessName: req.user.businessName,
      role,
    }).select("permissions").lean();
    const policy = await RolePermission.findOneAndUpdate(
      { businessName: req.user.businessName, role },
      {
        $set: {
          permissions,
          updatedBy: req.user._id,
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).select("role permissions updatedAt");

    await recordRbacAudit({
      actor: req.user,
      action: "role.permissions.updated",
      targetType: "role",
      targetRole: role,
      changes: {
        permissions: {
          from: toPlainPermissionMap(previousPolicy?.permissions),
          to: toPlainPermissionMap(policy.permissions),
        },
      },
    });

    res.status(200).json({
      success: true,
      message: "Role permission defaults updated",
      data: {
        role: policy.role,
        permissions: toPlainPermissionMap(policy.permissions),
        configured: true,
        policyState: Object.values(policy.permissions || {}).some(
          (allowed) => allowed === true,
        )
          ? "configured"
          : "no-access",
        permissionCount: Object.keys(policy.permissions || {}).length,
        allowedPermissionCount: Object.values(policy.permissions || {}).filter(
          (allowed) => allowed === true,
        ).length,
        updatedAt: policy.updatedAt,
      },
    });
  },
);

export const getEmployeeDetails = asyncHandler(async (req, res) => {
  const employee = await findTenantEmployee(
    req,
    req.params.id,
    "fullName email mobileNumber businessName role accountStatus createdAt lastLoginAt",
  );
  res.status(200).json({ success: true, data: { user: serializeEmployee(employee) } });
});

export const updateEmployeeDetails = asyncHandler(async (req, res) => {
  const employee = await findTenantEmployee(
    req,
    req.params.id,
    "fullName email mobileNumber businessName role accountStatus createdAt lastLoginAt",
  );
  if (employee.role === "SUPER_ADMIN") {
    throw new ApiError(403, "Super Admin accounts cannot be edited here");
  }

  const { fullName, email, mobileNumber } = req.body || {};
  const previousValues = {
    fullName: employee.fullName,
    email: employee.email,
    mobileNumber: employee.mobileNumber,
  };
  const updates = {};
  if (fullName !== undefined) {
    if (typeof fullName !== "string" || fullName.trim().length < 2 || fullName.trim().length > 100) {
      throw new ApiError(400, "Full name must be between 2 and 100 characters");
    }
    updates.fullName = fullName.trim();
  }
  if (email !== undefined) {
    if (typeof email !== "string" || !validator.isEmail(email.trim())) {
      throw new ApiError(400, "A valid email address is required");
    }
    updates.email = email.trim().toLowerCase();
    const duplicate = await User.findOne({
      email: updates.email,
      _id: { $ne: employee._id },
    }).select("_id");
    if (duplicate) throw new ApiError(409, "Email already registered");
  }
  if (mobileNumber !== undefined) {
    if (typeof mobileNumber !== "string" || !/^[6-9]\d{9}$/.test(mobileNumber)) {
      throw new ApiError(400, "A valid 10-digit Indian mobile number is required");
    }
    updates.mobileNumber = mobileNumber;
    const duplicate = await User.findOne({
      mobileNumber,
      _id: { $ne: employee._id },
    }).select("_id");
    if (duplicate) throw new ApiError(409, "Mobile number already registered");
  }
  if (!Object.keys(updates).length) {
    throw new ApiError(400, "At least one supported employee field is required");
  }

  Object.assign(employee, updates);
  await employee.save();
  await recordRbacAudit({
    actor: req.user,
    action: "user.updated",
    targetType: "user",
    targetUser: employee._id,
    changes: Object.fromEntries(
      Object.entries(updates).map(([field, value]) => [
        field,
        { from: previousValues[field], to: value },
      ]),
    ),
  });
  res.status(200).json({
    success: true,
    message: "Employee updated successfully",
    data: { user: serializeEmployee(employee) },
  });
});

export const updateEmployeeStatus = asyncHandler(async (req, res) => {
  const employee = await findTenantEmployee(
    req,
    req.params.id,
    "fullName email mobileNumber businessName role accountStatus createdAt lastLoginAt",
  );
  if (employee._id.equals(req.user._id)) {
    throw new ApiError(403, "You cannot deactivate your own account");
  }
  if (employee.role === "SUPER_ADMIN") {
    throw new ApiError(403, "Super Admin accounts cannot be deactivated here");
  }

  const { accountStatus } = req.body || {};
  if (!["ACTIVE", "BLOCKED", "SUSPENDED"].includes(accountStatus)) {
    throw new ApiError(400, "Account status must be ACTIVE, BLOCKED, or SUSPENDED");
  }
  const previousStatus = employee.accountStatus;
  employee.accountStatus = accountStatus;
  await employee.save();
  await recordRbacAudit({
    actor: req.user,
    action: "user.status.updated",
    targetType: "user",
    targetUser: employee._id,
    changes: { accountStatus: { from: previousStatus, to: accountStatus } },
  });
  res.status(200).json({
    success: true,
    message: "Employee account status updated",
    data: { user: serializeEmployee(employee) },
  });
});

export const getEmployeePermissionOverrides = asyncHandler(async (req, res) => {
  const employee = await findTenantEmployee(
    req,
    req.params.id,
    "fullName role businessName permissionOverrides permissionOverridesUpdatedBy permissionOverridesUpdatedAt",
  );
  const resolved = await resolveUserPermissions(employee);
  const rolePermissions = resolved.rolePermissions;
  const overrides = resolved.overrides;
  res.status(200).json({
    success: true,
    data: {
      user: { id: employee._id, fullName: employee.fullName, role: employee.role },
      rolePermissions,
      overrides,
      effectivePermissions: resolved.effectivePermissions,
      overridesUpdatedBy: employee.permissionOverridesUpdatedBy,
      overridesUpdatedAt: employee.permissionOverridesUpdatedAt,
    },
  });
});

export const updateEmployeePermissionOverrides = asyncHandler(
  async (req, res) => {
    const employee = await findTenantEmployee(
      req,
      req.params.id,
      "fullName role businessName permissionOverrides permissionOverridesUpdatedBy permissionOverridesUpdatedAt",
    );
    if (employee._id.equals(req.user._id) || employee.role === "SUPER_ADMIN") {
      throw new ApiError(403, "Super Admin access overrides are protected");
    }

    const rawOverrides = req.body?.overrides;
    if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
      throw new ApiError(400, "Overrides must be an object");
    }
    const normalized = normalizeUserPermissionOverrideMap(rawOverrides);
    if (!normalized) {
      throw new ApiError(
        400,
        "Overrides must contain registered, non-protected permission keys with allow, deny, or inherit values",
      );
    }

    const stored = Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== "inherit"),
    );
    const previousOverrides = { ...(employee.permissionOverrides || {}) };
    employee.permissionOverrides = stored;
    employee.permissionOverridesUpdatedBy = req.user._id;
    employee.permissionOverridesUpdatedAt = new Date();
    await employee.save();
    await recordRbacAudit({
      actor: req.user,
      action: "user.overrides.updated",
      targetType: "user",
      targetUser: employee._id,
      changes: {
        overrides: { from: previousOverrides, to: stored },
      },
    });

    const resolved = await resolveUserPermissions(employee);
    const rolePermissions = resolved.rolePermissions;
    res.status(200).json({
      success: true,
      message: "Employee permission overrides updated",
      data: {
        user: { id: employee._id, fullName: employee.fullName, role: employee.role },
        rolePermissions,
        overrides: stored,
        effectivePermissions: resolved.effectivePermissions,
        overridesUpdatedBy: employee.permissionOverridesUpdatedBy,
        overridesUpdatedAt: employee.permissionOverridesUpdatedAt,
      },
    });
  },
);

export const getRbacAuditHistory = asyncHandler(async (req, res) => {
  assertSuperAdmin(req);
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 50);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new ApiError(400, "Page must be positive and limit must be between 1 and 100");
  }

  const filter = { businessName: req.user.businessName };
  const [events, total] = await Promise.all([
    RbacAuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    RbacAuditLog.countDocuments(filter),
  ]);
  res.status(200).json({
    success: true,
    data: {
      events,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});
