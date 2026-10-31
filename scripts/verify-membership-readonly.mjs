// Run from my-sawari: node scripts/verify-membership-readonly.mjs
// Uses the configured MongoDB and the real lookup controller. No fixtures,
// server startup, authentication changes, document writes, or index creation.
// Output contains case results only, never customer or membership data.
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ quiet: true });
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const results = [];
const commands = new Set();
let stage = "connection";

try {
  if (!process.env.MONGO_URI) throw new Error("missing_configuration");
  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    autoCreate: false,
    retryWrites: false,
    monitorCommands: true,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 15000,
  });
  mongoose.connection.getClient().on("commandStarted", ({ commandName }) => {
    commands.add(commandName);
  });

  // Import only after disabling automatic collection and index creation.
  const { checkMembership } = await import("../src/controllers/membership.controller.js");
  const { default: Customer } = await import("../src/models/customer.model.js");
  const { default: Membership } = await import("../src/models/membership.model.js");
  const now = new Date();

  async function checkRealCustomer(mobileNumber, expectedStatus, expectedMembership) {
    let httpStatus;
    let payload;
    // Capture the actual controller output; neither the query nor its response
    // is mocked. Authentication and rate limits are tested in the isolated suite.
    const response = {
      status(value) { httpStatus = value; return this; },
      json(value) { payload = value; return this; },
    };
    await checkMembership({ body: { mobileNumber } }, response);
    assert.ok(httpStatus === 200, "lookup_response_failed");
    assert.ok(payload?.success === true, "lookup_unsuccessful");
    assert.ok(payload.status === expectedStatus, "membership_status_mismatch");
    if (expectedMembership) {
      assert.ok(payload.membership?.membershipId === (expectedMembership.membershipId || ""), "membership_id_mismatch");
      assert.ok(payload.membership?.plan === (expectedMembership.plan || ""), "membership_plan_mismatch");
      const expiry = expectedMembership.expiresAt instanceof Date && !Number.isNaN(expectedMembership.expiresAt.getTime())
        ? expectedMembership.expiresAt.toISOString()
        : null;
      assert.ok((payload.membership?.expiresAt?.toISOString() || null) === expiry, "membership_expiry_mismatch");
      const activation = expectedMembership.activatedAt instanceof Date && !Number.isNaN(expectedMembership.activatedAt.getTime())
        ? expectedMembership.activatedAt.toISOString()
        : null;
      assert.ok((payload.membership?.activatedAt?.toISOString() || null) === activation, "membership_activation_mismatch");
      const savings = Number.isFinite(expectedMembership.totalSaved) ? expectedMembership.totalSaved : null;
      assert.ok(payload.membership?.totalSaved === savings, "membership_savings_mismatch");
      assert.ok(Object.keys(payload.membership).sort().join(",") === "activatedAt,expiresAt,membershipId,plan,totalSaved", "unexpected_membership_fields");
      if (expectedStatus === "inactive") {
        assert.ok(["payment_unverified", "incomplete_dates", "activation_scheduled"].includes(payload.reason), "missing_inactive_reason");
      }
    } else {
      assert.ok(payload.membership === undefined, "unexpected_membership_details");
    }
  }

  const activatedAndPaid = {
    "payment.status": "completed",
    activatedAt: { $type: "date", $lte: now },
    expiresAt: { $type: "date" },
  };
  for (const status of ["active", "expired", "inactive"]) {
    stage = status;
    const [record] = await Membership.aggregate([
      { $match: status === "inactive"
        ? { $nor: [activatedAndPaid] }
        : { ...activatedAndPaid, expiresAt: { $type: "date", [status === "active" ? "$gt" : "$lte"]: now } }
      },
      { $lookup: { from: Customer.collection.name, localField: "customerId", foreignField: "_id", as: "customer" } },
      { $unwind: "$customer" },
      { $match: { "customer.mobileNumber": { $type: "string" } } },
      { $limit: 1 },
      { $project: { _id: 0, membershipId: 1, plan: 1, activatedAt: 1, expiresAt: 1, totalSaved: 1, mobileNumber: "$customer.mobileNumber" } },
    ]).option({ maxTimeMS: 10000 });
    if (!record) {
      results.push({ case: status, result: "NOT_COVERED", reason: "No qualifying existing record" });
      continue;
    }
    await checkRealCustomer(record.mobileNumber, status, record);
    results.push({ case: status, result: "PASS" });
  }

  stage = "no_membership";
  const [withoutMembership] = await Customer.aggregate([
    { $lookup: {
      from: Membership.collection.name,
      localField: "_id",
      foreignField: "customerId",
      pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }],
      as: "memberships",
    } },
    { $match: { "memberships.0": { $exists: false }, mobileNumber: { $type: "string" } } },
    { $limit: 1 },
    { $project: { _id: 0, mobileNumber: 1 } },
  ]).option({ maxTimeMS: 10000 });
  if (withoutMembership) {
    await checkRealCustomer(withoutMembership.mobileNumber, "none");
    results.push({ case: stage, result: "PASS" });
  } else {
    results.push({ case: stage, result: "NOT_COVERED", reason: "No qualifying existing record" });
  }

  stage = "read_only_verification";
  const allowedCommands = new Set(["find", "aggregate", "getMore", "killCursors"]);
  assert.ok([...commands].every((name) => allowedCommands.has(name)), "unexpected_database_command");
  results.push({ case: "read_only", result: "PASS", commands: [...commands].sort() });
  console.log(JSON.stringify({ verification: "configured_mongodb", results }, null, 2));
} catch (error) {
  // Do not dump database errors, URIs, assertions or queried values.
  console.error(JSON.stringify({
    verification: "configured_mongodb",
    stage,
    result: "FAIL",
    errorType: error.name,
    code: error.code || null,
    authenticationFailed: /bad auth|authentication fail/i.test(String(error.message)),
    completedCases: results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
