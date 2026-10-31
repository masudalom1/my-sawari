import express from "express";
import { bulkCreate } from "../controllers/qrController.js";


const router = express.Router();

router.post("/qr-codes/bulk", bulkCreate);

export default router;