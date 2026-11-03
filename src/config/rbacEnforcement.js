export function getRbacEnforcementMode() {
  const configuredMode = process.env.RBAC_ENFORCEMENT_MODE?.trim();
  if (configuredMode && !["enforce", "legacy"].includes(configuredMode)) {
    throw new Error("RBAC_ENFORCEMENT_MODE must be enforce (legacy is deprecated)");
  }
  // Accept old deployments' legacy setting, but never bypass saved policies.
  return "enforce";
}

export default getRbacEnforcementMode;
