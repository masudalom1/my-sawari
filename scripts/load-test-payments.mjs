import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const sizes = (process.env.PAYMENT_LOAD_SIZES || "1000,10000")
  .split(",")
  .map(Number);
const concurrencies = (process.env.PAYMENT_LOAD_CONCURRENCY || "1,10")
  .split(",")
  .map(Number);
const samplesPerEndpoint = Number(process.env.PAYMENT_LOAD_SAMPLES || 25);
const maxTierDurationMs = Number(process.env.PAYMENT_LOAD_MAX_TIER_MS || 120000);
const MAX_DATASET_SIZE = 100000;
const MAX_CONCURRENCY = 50;

if (
  sizes.length === 0 ||
  sizes.length !== concurrencies.length ||
  sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > MAX_DATASET_SIZE) ||
  concurrencies.some((users) => !Number.isSafeInteger(users) || users < 1 || users > MAX_CONCURRENCY) ||
  concurrencies.some((users) => (samplesPerEndpoint * 2) % users !== 0) ||
  !Number.isSafeInteger(samplesPerEndpoint) ||
  samplesPerEndpoint < 10 ||
  samplesPerEndpoint > 50 ||
  !Number.isSafeInteger(maxTierDurationMs) ||
  maxTierDurationMs < 10000 ||
  maxTierDurationMs > 180000
) {
  throw new Error(
    "Use matching dataset/concurrency lists (max 100,000 records and 50 clients), 10-50 samples, and a 10-180 second tier limit.",
  );
}

const safeEnv = {
  NODE_ENV: "production",
  RBAC_ENFORCEMENT_MODE: "enforce",
  JWT_ACCESS_SECRET: "in-memory-load-test-only-secret",
  JWT_ACCESS_EXPIRES: "1h",
  CLIENT_URL: "http://localhost:3000",
  PAYMENTS_REPORT_COMPANY_ID: "000000000000000000000001",
  PAYMENTS_SCOPE_BY_COMPANY: "false",
  CLOUDINARY_CLOUD_NAME: "load-test",
  CLOUDINARY_API_KEY: "load-test",
  CLOUDINARY_API_SECRET: "load-test",
  WATI_API_URL: "https://wati.invalid",
  WATI_TENANT_ID: "load-test",
  WATI_API_TOKEN: "load-test",
};
Object.assign(process.env, safeEnv);

const quietOutput = process.stdout.write;
process.stdout.write = () => true;
const tierSummaries = [];

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const megabytes = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

let mongoServer;
let server;
let commandMetrics;
let rssTimer;
let peakRss = 0;

try {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri("sawari_payment_load_test");
  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    monitorCommands: true,
  });

  const { default: app } = await import("../src/app.js");
  server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const PaymentHistory = (await import("../src/models/paymentHistory.model.js")).default;
  const User = (await import("../src/models/user.model.js")).default;
  const accountIds = Array.from({ length: MAX_CONCURRENCY }, () => new mongoose.Types.ObjectId());
  const now = new Date();
  await User.collection.insertMany(
    accountIds.map((id, index) => ({
      _id: id,
      fullName: `Load Test User ${index + 1}`,
      mobileNumber: `9${String(100000000 + index).slice(-9)}`,
      email: `load-test-${index + 1}@example.invalid`,
      businessName: "Synthetic Load Test",
      password: "unused-in-memory-benchmark-value",
      role: "SUPER_ADMIN",
      accountStatus: "ACTIVE",
      isEmailVerified: true,
      isMobileVerified: true,
      permissionOverrides: {},
      createdAt: now,
      updatedAt: now,
    })),
  );
  const tokens = accountIds.map((userId) =>
    jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" }),
  );

  await PaymentHistory.createIndexes();
  const driver = mongoose.connection.getClient();
  driver.on("commandSucceeded", (event) => {
    if (!commandMetrics) return;
    if (!["find", "aggregate", "getMore", "count", "countDocuments"].includes(event.commandName)) return;
    commandMetrics.count += 1;
    commandMetrics.totalMs += event.duration;
    commandMetrics.maxMs = Math.max(commandMetrics.maxMs, event.duration);
  });
  driver.on("commandFailed", () => {
    if (commandMetrics) commandMetrics.failed += 1;
  });

  const batchSize = 2000;
  let inserted = 0;
  const insertBatch = async (target) => {
    while (inserted < target) {
      const end = Math.min(target, inserted + batchSize);
      const rows = [];
      for (let index = inserted; index < end; index += 1) {
        const method = ["cash", "mixed", "phonepe", "gpay", "razorpay"][index % 5];
        const isMixed = method === "mixed";
        const date = new Date(Date.UTC(2026, 6, 1 + (index % 120), index % 24, index % 60));
        rows.push({
          _id: new mongoose.Types.ObjectId(),
          bookingId: new mongoose.Types.ObjectId(),
          createdBy: accountIds[index % accountIds.length],
          type: index % 25 === 0 ? "refund" : "booking",
          amount: 300 + (index % 1000),
          paymentMethod: method,
          paymentBreakdown: isMixed
            ? { cash: 100, phonePe: 100, gpay: 50, razorpay: 50 }
            : {},
          customPaymentDate: date,
          paymentDate: date,
          createdAt: date,
          updatedAt: date,
          customer: {
            fullName: `Synthetic Customer ${index % 10000}`,
            mobileNumber: `98765${String(index % 100000).padStart(5, "0")}`,
          },
          vehicle: {
            vehicleName: `Vehicle ${index % 1000}`,
            vehicleNumber: `KA01AB${String(index % 10000).padStart(4, "0")}`,
          },
          collectedAmount: 0,
          collectedPhonePe: 0,
          isCollected: false,
          isPhonePeCollected: false,
          collectionHistory: [],
          note: `synthetic-load-${index}`,
        });
      }
      await PaymentHistory.collection.insertMany(rows, { ordered: false });
      inserted = end;
    }
  };

  const endpoints = [
    { key: "cash", path: "/dashboard/payments-history/cash?tab=all&status=all&dateType=payment&limit=25&page=1" },
    { key: "upi", path: "/dashboard/payments-history/upi?tab=all&method=all&dateType=payment&limit=25&page=1" },
  ];
  for (let tier = 0; tier < sizes.length; tier += 1) {
    const size = sizes[tier];
    const users = concurrencies[tier];
    await insertBatch(size);
    process.stderr.write(`[load-test] starting ${size} payments with ${users} virtual clients\n`);
    const observed = new Map();
    for (const endpoint of endpoints) {
      for (const section of ["page", "summary"]) {
        observed.set(`${endpoint.key}:${section}`, { latencies: [], errors: 0, statuses: {} });
      }
    }
    commandMetrics = { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
    peakRss = process.memoryUsage().rss;
    rssTimer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 100);
    const rssBefore = process.memoryUsage().rss;
    const loopsPerUser = samplesPerEndpoint * 2 / users;
    const tierStarted = performance.now();
    const cpuBefore = process.cpuUsage();
    let timedOut = false;
    const tierTimer = setTimeout(() => {
      timedOut = true;
    }, maxTierDurationMs);
    const clients = Array.from({ length: users }, async (_, userIndex) => {
      const token = tokens[userIndex];
      for (let iteration = 0; iteration < loopsPerUser; iteration += 1) {
        if (timedOut) break;
        const endpoint = endpoints[(userIndex + iteration) % endpoints.length];
        const testIp = `10.251.${tier}.${userIndex + 1}`;
        await Promise.all(
          ["page", "summary"].map(async (section) => {
            const key = `${endpoint.key}:${section}`;
            const metrics = observed.get(key);
            const url = `${base}${endpoint.path}&section=${section}`;
            const started = performance.now();
            try {
              const response = await fetch(url, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  "X-Forwarded-For": testIp,
                },
              });
              await response.arrayBuffer();
              const elapsed = performance.now() - started;
              metrics.latencies.push(elapsed);
              metrics.statuses[response.status] = (metrics.statuses[response.status] || 0) + 1;
              if (!response.ok) metrics.errors += 1;
            } catch (error) {
              metrics.errors += 1;
              metrics.statuses[error.name || "network-error"] =
                (metrics.statuses[error.name || "network-error"] || 0) + 1;
            }
          }),
        );
      }
    });
    await Promise.all(clients);
    clearTimeout(tierTimer);
    clearInterval(rssTimer);
    rssTimer = undefined;

    const wallMs = performance.now() - tierStarted;
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rssAfter);
    const requestCount = [...observed.values()].reduce((sum, item) => sum + item.latencies.length, 0) +
      [...observed.values()].reduce((sum, item) => sum + item.errors, 0);
    const endpointResults = [];
    for (const [key, metrics] of observed) {
      const output = {
        key,
        samples: metrics.latencies.length,
        p50Ms: Math.round(percentile(metrics.latencies, 0.5) * 10) / 10,
        p95Ms: Math.round(percentile(metrics.latencies, 0.95) * 10) / 10,
        p99Ms: Math.round(percentile(metrics.latencies, 0.99) * 10) / 10,
        errors: metrics.errors,
        errorRate: metrics.latencies.length + metrics.errors
          ? Math.round((metrics.errors / (metrics.latencies.length + metrics.errors)) * 10000) / 100
          : 0,
        statuses: metrics.statuses,
      };
      endpointResults.push(output);
    }
    tierSummaries.push({
      datasetSize: size,
      virtualUsers: users,
      wallMs: Math.round(wallMs),
      timedOut,
      requests: requestCount,
      mongoCommands: commandMetrics.count,
      failedMongoCommands: commandMetrics.failed,
      mongoCommandMsTotal: Math.round(commandMetrics.totalMs),
      mongoCommandMsPerRequest: Math.round((commandMetrics.totalMs / Math.max(1, requestCount)) * 10) / 10,
      mongoCommandMaxMs: Math.round(commandMetrics.maxMs * 10) / 10,
      nodeCpuMs: Math.round((cpu.user + cpu.system) / 1000),
      nodeCpuPercentOfWall: Math.round((((cpu.user + cpu.system) / 1000) / Math.max(1, wallMs)) * 1000) / 10,
      nodeRssBeforeMb: megabytes(rssBefore),
      nodeRssAfterMb: megabytes(rssAfter),
      nodeRssPeakMb: megabytes(peakRss),
      endpoints: endpointResults,
    });
    process.stderr.write(`[load-test] finished ${size} payments in ${Math.round(wallMs)} ms${timedOut ? " (tier timeout)" : ""}\n`);
    commandMetrics = undefined;
    if (timedOut) break;
  }

  const failures = tierSummaries.flatMap((tier) => tier.endpoints)
    .filter((endpoint) => endpoint.errors > 0);
  process.stdout.write = quietOutput;
  console.log(JSON.stringify({
    benchmark: "SAWARI payment APIs; isolated MongoMemoryServer with synthetic data",
    datasetConcurrencyPairs: sizes.map((datasetSize, index) => ({
      datasetSize,
      virtualUsers: concurrencies[index],
    })),
    samplesPerEndpoint: samplesPerEndpoint,
    maxTierDurationMs,
    cache: "not applicable: endpoints are no-store and have no server response cache",
    mongoTiming: "driver command duration includes network and server time; it is not Mongo explain executionStats",
    memory: "Node process RSS; mongod process memory is not included",
    frontend: "not measured; this benchmark exercises the backend API, not a browser",
    tierSummaries,
    failedScenarios: failures.length,
  }, null, 2));
  if (failures.length || tierSummaries.some((tier) => tier.timedOut)) process.exitCode = 1;
} finally {
  if (rssTimer) clearInterval(rssTimer);
  commandMetrics = undefined;
  process.stdout.write = quietOutput;
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  process.stdout.write = quietOutput;
}
