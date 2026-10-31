import express from "express";
import { bulkCreate, claimCode, getByCode } from "../controllers/qrController.js";


const router = express.Router();

router.post("/qr-codes/bulk", bulkCreate);
router.get("/qr-codes/:code", getByCode);
router.post("/qr-codes/:code/claim", claimCode);

export default router;