export const PERMISSION_MODULES = Object.freeze([
  {
    key: "dashboard",
    label: "Fleet Dashboard",
    href: "/",
    group: "Overview",
    navigation: true,
    actions: ["view", "create", "edit", "delete"],
  },
  {
    key: "revenue",
    label: "Revenue",
    href: "/revenue",
    group: "Revenue",
    navigation: true,
    actions: ["view"],
  },
  {
    key: "vehicleRevenue",
    label: "Vehicle Revenue",
    href: "/features/revenue/vehicles",
    group: "Revenue",
    navigation: false,
    actions: ["view"],
  },
  {
    key: "bookings",
    label: "All Bookings",
    href: "/AllBookings",
    group: "Bookings",
    navigation: true,
    actions: ["view", "create", "edit", "delete"],
  },
  {
    key: "paymentsHistory",
    label: "Payments History",
    href: "/paymentshistory",
    group: "Payments",
    navigation: true,
    actions: ["view", "export"],
  },
  {
    key: "pendingToCollect",
    label: "Cash Collections",
    href: "/pending-to-collect",
    group: "Payments",
    navigation: true,
    actions: ["view", "collect"],
  },
  {
    key: "verifyUpiCollections",
    label: "UPI Collections",
    href: "/verify-upi-collections",
    group: "Payments",
    navigation: true,
    actions: ["view", "verify"],
  },
  {
    key: "customers",
    label: "Customers",
    href: null,
    group: "Fleet operations",
    navigation: true,
    actions: [],
    status: "coming-soon",
  },
  {
    key: "appUsers",
    label: "App Users",
    href: "/app-users",
    group: "Fleet operations",
    navigation: true,
    actions: ["view"],
  },
  {
    key: "maintenance",
    label: "Maintenance & Service",
    href: null,
    group: "Fleet operations",
    navigation: true,
    actions: [],
    status: "coming-soon",
  },
  {
    key: "reports",
    label: "Reports & Analytics",
    href: null,
    group: "Operations",
    navigation: true,
    actions: [],
    status: "coming-soon",
  },
  {
    key: "invoices",
    label: "Invoices",
    href: null,
    group: "Operations",
    navigation: true,
    actions: [],
    status: "coming-soon",
  },
  {
    key: "notifications",
    label: "Notifications",
    href: null,
    group: "Operations",
    navigation: true,
    actions: [],
    status: "coming-soon",
  },
  {
    key: "settings",
    label: "Settings",
    href: "/settings",
    group: "Administration",
    navigation: true,
    actions: ["view", "create", "edit", "manageAccess"],
    actionAvailability: { manageAccess: "preview" },
    sections: [
      { key: "users", label: "User Management" },
      { key: "roles", label: "Roles & Permissions" },
      { key: "overview", label: "Access Overview" },
    ],
  },
  {
    key: "qrCodes",
    label: "QR Codes",
    href: "/admin/qr-codes",
    group: "Administration",
    navigation: true,
    actions: ["view", "create"],
  },
]);

export const PERMISSION_ACTIONS = Object.freeze({
  view: { key: "view", label: "View", description: "Page and sidebar visibility" },
  create: { key: "create", label: "Create", description: "Create records or users" },
  edit: { key: "edit", label: "Edit", description: "Edit existing records" },
  delete: { key: "delete", label: "Delete", description: "Delete records" },
  export: { key: "export", label: "Export", description: "Export payment history" },
  collect: { key: "collect", label: "Collect", description: "Record a cash collection" },
  verify: { key: "verify", label: "Verify", description: "Verify a UPI payment" },
  manageAccess: {
    key: "manageAccess",
    label: "Manage access",
    description: "Configure access in the frontend preview",
  },
});

export function permissionKey(moduleKey, action) {
  return `page.${moduleKey}.${action}`;
}

export const PERMISSIONS = Object.freeze(
  Object.fromEntries(
    PERMISSION_MODULES.map(({ key, actions }) => [
      key,
      Object.freeze(
        Object.fromEntries(
          actions.map((action) => [action, permissionKey(key, action)]),
        ),
      ),
    ]),
  ),
);

export const RBAC_PERMISSION_KEYS = Object.freeze(
  PERMISSION_MODULES.flatMap(({ key, actions }) =>
    actions.map((action) => permissionKey(key, action)),
  ),
);

const RBAC_PERMISSION_KEY_SET = new Set(RBAC_PERMISSION_KEYS);
export const PROTECTED_USER_OVERRIDE_KEYS = Object.freeze(
  Object.values(PERMISSIONS.settings),
);
export const PROTECTED_USER_OVERRIDE_KEY_SET = new Set(
  PROTECTED_USER_OVERRIDE_KEYS,
);

export function isRegisteredPermissionMap(value, allowedValues = [true, false]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return entries.every(
    ([key, permission]) =>
      RBAC_PERMISSION_KEY_SET.has(key) && allowedValues.includes(permission),
  );
}

export function isRegisteredUserOverrideMap(value, allowedValues = ["allow", "deny"]) {
  if (!isRegisteredPermissionMap(value, allowedValues)) return false;
  const entries = value instanceof Map ? [...value.keys()] : Object.keys(value);
  return entries.every((key) => !PROTECTED_USER_OVERRIDE_KEY_SET.has(key));
}
