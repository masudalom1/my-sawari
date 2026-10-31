import express from "express";
import { bulkCreate, getByCode } from "../controllers/qrController.js";


const router = express.Router();

router.post("/qr-codes/bulk", bulkCreate);
router.get("/qr-codes/:code", getByCode);

export default router;