import express from "express";

import authMiddleware from "../middlewares/auth.middleware.js";
import restrictTo from "../middlewares/restrictTo.middleware.js";
import { createEmployee, getCurrentUser, loginUser, logoutUser, refreshAccessToken, registerUser, resetPassword, updateEmployeeRole } from "../controllers/auth.controller.js";

const router = express.Router();

router.post("/register", registerUser);
router.post("/employees",authMiddleware,createEmployee);
router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.post("/refresh-token", refreshAccessToken);
router.get("/me", authMiddleware, getCurrentUser);

router.post("/reset-password",resetPassword);
router.patch("/employees/:id/role",authMiddleware,restrictTo("SUPER_ADMIN"),updateEmployeeRole);

export default router;
