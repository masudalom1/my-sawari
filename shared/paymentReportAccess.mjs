export const PAYMENT_REPORT_ADMIN_ROLES = Object.freeze(["SUPER_ADMIN", "ADMIN"]);
export const canViewPaymentReports = (user) => PAYMENT_REPORT_ADMIN_ROLES.includes(user?.role);
