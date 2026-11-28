import mongoose from "mongoose";
import multer from "multer";

// Status for errors that don't carry one themselves.
const resolveStatusCode = (err, res) => {
  // ApiError sets statusCode; body-parser / http-errors set status.
  const explicit = Number(err.statusCode || err.status);
  if (explicit >= 400 && explicit < 600) return explicit;

  // Invalid ObjectId / value in a query, failed schema validation, bad upload.
  if (
    err instanceof mongoose.Error.CastError ||
    err instanceof mongoose.Error.ValidationError ||
    err instanceof multer.MulterError
  ) {
    return 400;
  }

  // A status set before next(err), e.g. notFound's 404.
  return res.statusCode >= 400 ? res.statusCode : 500;
};

const errorHandler = (err, req, res, next) => {
  const statusCode = resolveStatusCode(err, res);
  const isProduction = process.env.NODE_ENV === "production";

  if (statusCode >= 500) {
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
  }

  // Client errors that define their whole response (e.g. availability
  // conflicts with a `code` and conflict details).
  if (statusCode < 500 && err.responseBody && typeof err.responseBody === "object") {
    return res.status(statusCode).json(err.responseBody);
  }

  res.status(statusCode).json({
    success: false,
    ...(err.balance && { balance: err.balance }),
    // Server-side failures can carry driver/internal details; keep those out of production responses.
    message:
      statusCode >= 500 && isProduction
        ? "Internal Server Error"
        : err.message || "Internal Server Error",
    stack: isProduction ? null : err.stack,
  });
};

export default errorHandler;
