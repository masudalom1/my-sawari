import RbacAuditLog from "../models/rbacAuditLog.model.js";

export function recordRbacAudit({
  actor,
  action,
  targetType,
  targetUser = null,
  targetRole = null,
  changes,
}) {
  if (!actor?._id || !actor.businessName) {
    throw new Error("A scoped actor is required to record an RBAC audit event");
  }

  return RbacAuditLog.create({
    businessName: actor.businessName,
    actor: actor._id,
    action,
    targetType,
    targetUser,
    targetRole,
    changes,
  });
}
