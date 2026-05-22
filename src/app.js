import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import hpp from "hpp";

import authRoutes from "./routes/auth.routes.js";
import notFound from "./middlewares/notFound.middleware.js";
import errorHandler from "./middlewares/error.middleware.js";

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

// rate limiting
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  })
);

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

// routes
app.use("/api/v1/auth", authRoutes);

// 404
app.use(notFound);

// global error handler
app.use(errorHandler);

export default app;