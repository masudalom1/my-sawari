import express from "express";

import authMiddleware from "../middlewares/auth.middleware.js";
import { getCurrentUser, loginUser, logoutUser, refreshAccessToken, registerUser } from "../controllers/auth.controller.js";

const router = express.Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.post("/refresh-token", refreshAccessToken);
router.get("/me", authMiddleware, getCurrentUser);

export default router;