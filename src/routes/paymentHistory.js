import express from "express";
import protect from "../middlewares/auth.middleware.js"; 
import { getPaymentsHistory } from "../controllers/paymentHistory.js";


const router = express.Router();

router.get("/", protect, getPaymentsHistory);

export default router;