// Must stay the first import: modules such as config/cloudinary.js and
// services/wati.service.js read process.env while they are being imported.
import "dotenv/config";
import mongoose from "mongoose";
import { validateEnv } from "./config/env.js";
import app from "./app.js";
import connectDB from "./config/db.js";
import { startRealtime, stopRealtime } from "./realtime/changeFeed.js";

validateEnv();

const PORT = process.env.PORT || 5000;

connectDB();

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Socket.IO on the same port: pushes "data changed" events to the dashboards
startRealtime(server);

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  stopRealtime().catch(() => {});
  server.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
