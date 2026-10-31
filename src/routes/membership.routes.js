import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import protect from "../middlewares/auth.middleware.js";
import { checkMembership, quoteMembershipDiscount } from "../controllers/membership.controller.js";

const router = express.Router();

// Membership status is personal data and must be checked fresh each time.
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Runs after protect, so each staff account gets its own bucket. Stops the
// lookup being used to enumerate which mobile numbers are customers.
const membershipCheckLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || ipKeyGenerator(req.ip),
  message: {
    success: false,
    message: "Too many membership checks. Please wait a few minutes and try again.",
  },
});

router.post("/check", protect, membershipCheckLimiter, checkMembership);
router.post("/discount", protect, membershipCheckLimiter, quoteMembershipDiscount);

export default router;
