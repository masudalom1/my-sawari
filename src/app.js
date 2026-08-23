import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import hpp from "hpp";
import path from "path";

import authRoutes from "./routes/auth.routes.js";
import notFound from "./middlewares/notFound.middleware.js";
import errorHandler from "./middlewares/error.middleware.js";
import handoverRoutes from "./routes/handover.routes.js";
import vehicleRoutes from "./routes/vehicle.routes.js";
import vehicleReturnRoutes from "./routes/vehicleReturn.routes.js";
import customerRoutes from "./routes/customer.routes.js";
import leadRoutes from "./routes/lead.routes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import paymentHistoryRoutes from "./routes/paymentHistory.routes.js"
import dashboardRoutes from "./routes/dashboard.routes.js"

dotenv.config();

const app = express();

// trust proxy (important for production)
app.set("trust proxy", 1);

// cors
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// security headers
app.use(helmet());

// logging
app.use(morgan("dev"));

// compression
app.use(compression());

// cookies
app.use(cookieParser());

// body parser
app.use(
  express.json({
    limit: "10kb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10kb",
  })
);

// prevent HTTP param pollution
app.use(hpp());

// 🔧 CHANGED: removed duplicate express.static lines, kept only one
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ==========================================================
// 🔧 CHANGED: Rate limiting — split into general + upload-specific
// Previously ONE global limiter (max 200 / 15min) sat in front
// of EVERY route, including the 9-images-per-handover upload flow.
// If 2-3 users shared a public IP (same WiFi/office/carrier NAT),
// they were also sharing that single 200-request bucket, causing
// uploads to silently fail as "network errors" once it filled up.
// ==========================================================

// General limiter for auth, listing, etc. — generous ceiling
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500, // 🔧 CHANGED: raised from 200
  standardHeaders: true,
  legacyHeaders: false,
  // 🔧 CHANGED: key by logged-in user if available, else fall back to IP
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
});

// Dedicated, more generous limiter for image upload routes
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // room for 9 images x multiple handovers x retries
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: {
    success: false,
    message: "Too many uploads, please slow down and try again shortly.",
  },
});

// Apply upload limiter ONLY to the image upload route
app.use("/api/v1/handover/image", uploadLimiter);

// Apply general limiter to everything else
app.use((req, res, next) => {
  if (req.path.startsWith("/api/v1/handover/image")) {
    return next(); // already handled above, skip general limiter
  }
  generalLimiter(req, res, next);
});

app.use((req, res, next) => {
  console.log("REQUEST:", req.method, req.originalUrl);
  next();
});
app.use((req, res, next) => {
  console.log("BODY:", req.body);
  next();
});
// routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/handover", handoverRoutes);
app.use("/api/v1/vehicles", vehicleRoutes);
app.use("/api/v1/vehicle-return", vehicleReturnRoutes);
app.use("/api/v1/customers", customerRoutes);
app.use("/api/v1/leads", leadRoutes);
app.use("/api/v1/bookings", bookingRoutes);
app.use("/api/v1/payments", paymentHistoryRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);


// 404
app.use(notFound);

// global error handler
app.use(errorHandler);

export default app;