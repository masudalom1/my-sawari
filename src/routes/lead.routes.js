import express from "express";

import protect from "../middlewares/auth.middleware.js";
import { createLead } from "../controllers/lead.controller.js";


const router = express.Router();

router.post("/", protect, createLead);



export default router;