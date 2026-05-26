import express from "express";
import protect from "../middlewares/auth.middleware.js";
import { getAllCustomers } from "../controllers/customer.controller.js";


const router = express.Router();

router.use(protect);

router.get("/all", getAllCustomers);

export default router;