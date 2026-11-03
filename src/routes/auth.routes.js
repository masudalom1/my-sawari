import express from "express";

import authMiddleware from "../middlewares/auth.middleware.js";
import restrictTo from "../middlewares/restrictTo.middleware.js";
import {
  createEmployee,
  getAllEmployees,
  getCurrentUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  resetPassword,
  updateEmployeeRole,
} from "../controllers/auth.controller.js";
import {
  getEmployeeDetails,
  getRbacAuditHistory,
  getEmployeePermissionOverrides,
  getCurrentEffectivePermissions,
  getRolePermissionConfiguration,
  updateEmployeeDetails,
  updateEmployeePermissionOverrides,
  updateEmployeeStatus,
  updateRolePermissionConfiguration,
} from "../controllers/rbac.controller.js";

const router = express.Router();

router.post("/register", authMiddleware, restrictTo("SUPER_ADMIN"), createEmployee);
router.post("/employees", authMiddleware, restrictTo("SUPER_ADMIN"), createEmployee);
router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.post("/refresh-token", refreshAccessToken);
router.get("/me", authMiddleware, getCurrentUser);
router.get("/permissions/me", authMiddleware, getCurrentEffectivePermissions);

router.post("/reset-password", authMiddleware, resetPassword);
router.get("/employees",authMiddleware,restrictTo("SUPER_ADMIN"),getAllEmployees);
router.patch("/employees/:id/role",authMiddleware,restrictTo("SUPER_ADMIN"),updateEmployeeRole);
router.get("/roles/permissions",authMiddleware,restrictTo("SUPER_ADMIN"),getRolePermissionConfiguration);
router.put("/roles/:role/permissions",authMiddleware,restrictTo("SUPER_ADMIN"),updateRolePermissionConfiguration);
router.get("/employees/:id/permissions",authMiddleware,restrictTo("SUPER_ADMIN"),getEmployeePermissionOverrides);
router.put("/employees/:id/permissions",authMiddleware,restrictTo("SUPER_ADMIN"),updateEmployeePermissionOverrides);
router.get("/employees/:id",authMiddleware,restrictTo("SUPER_ADMIN"),getEmployeeDetails);
router.patch("/employees/:id/status",authMiddleware,restrictTo("SUPER_ADMIN"),updateEmployeeStatus);
router.patch("/employees/:id",authMiddleware,restrictTo("SUPER_ADMIN"),updateEmployeeDetails);
router.get("/audit-history",authMiddleware,restrictTo("SUPER_ADMIN"),getRbacAuditHistory);

export default router;
