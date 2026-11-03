import express from "express";
import protect from "../middlewares/auth.middleware.js";
import requirePermission from "../middlewares/requirePermission.middleware.js";
import { PERMISSIONS } from "../config/rbacPermissions.js";
import { getAllCustomers } from "../controllers/customer.controller.js";


const router = express.Router();

router.use(protect);

router.get("/all", requirePermission(PERMISSIONS.bookings.view), getAllCustomers);

export default router;