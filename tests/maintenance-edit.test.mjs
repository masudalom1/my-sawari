import { test } from "node:test";
import { editIntegrityGuard } from "./helpers/edit-integrity.mjs";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import router from "../src/routes/vehicle.routes.js";
import errorHandler from "../src/middlewares/error.middleware.js";
import notFound from "../src/middlewares/notFound.middleware.js";
import Maintenance from "../src/models/maintenance.model.js";
import Vehicle from "../src/models/vehicle.model.js";
import User from "../src/models/user.model.js";
import { generateAccessToken } from "../src/services/token.service.js";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

test("registered maintenance editor routes enforce auth, ownership and validated in-place updates", async (t) => {
  process.env.JWT_ACCESS_SECRET = "maintenance-edit-test-only";
  const user = { _id: new mongoose.Types.ObjectId(), company: new mongoose.Types.ObjectId(), accountStatus: "ACTIVE" };
  const vehicle = new mongoose.Types.ObjectId();
  const record = new Maintenance({ vehicle, startDate: "2026-01-01", endDate: "2026-01-02" });
  let saves = 0;
  let accessible = true;
  let found = true;
  t.mock.method(User, "findById", async () => user);
  t.mock.method(Vehicle, "exists", async (filter) => {
    assert.equal(String(filter.company), String(user.company));
    assert.equal(filter.isDeleted, false);
    return accessible && String(filter._id) === String(vehicle) ? { _id: vehicle } : null;
  });
  t.mock.method(Maintenance, "findOne", (filter) => {
    assert.equal(String(filter._id), String(record._id));
    assert.equal(filter.isDeleted, false);
    const query = {
      populate() { return query; },
      lean: async () => found ? record.toObject() : null,
      then(resolve, reject) { return Promise.resolve(found ? record : null).then(resolve, reject); },
    };
    return query;
  });
  t.mock.method(record, "save", async () => { await record.validate(); saves++; return record; });
  t.mock.method(record, "populate", async () => record);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/vehicles", router);
  app.use(notFound);
  app.use(errorHandler);
  const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/vehicles/maintenance/${record._id}`;
  const token = generateAccessToken(user);
  async function request(method, body, authenticated = true) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request("PATCH", {}, false)).status, 401);
  assert.equal((await request("GET")).status, 200);
  const updated = await request("PATCH", { vehicle: String(vehicle), title: "Repair updated", maintenanceType: "", isDeleted: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.success, true);
  assert.equal(updated.body.data._id, String(record._id));
  assert.equal(record.title, "Repair updated");
  assert.equal(record.isDeleted, false);
  assert.equal(saves, 1);
  assert.equal((await request("PATCH", { vehicle: String(new mongoose.Types.ObjectId()) })).status, 404);
  accessible = false;
  assert.equal((await request("GET")).status, 404);
  assert.equal((await request("PATCH", {})).status, 404);
  accessible = true;
  assert.equal((await request("PATCH", { status: "Completed" })).status, 400);
  record.status = "Scheduled";
  assert.equal((await request("PATCH", { endDate: "2025-12-31" })).status, 400);
  record.endDate = new Date("2026-01-02");
  assert.equal((await request("PATCH", { status: "In Progress", statusNote: "Started" })).status, 200);
  assert.equal(record.statusHistory.at(-1).note, "Started");
  assert.equal(saves, 2);
  assert.equal((await request("PATCH", { status: "Invalid" })).status, 400);
  record.status = "In Progress";
  assert.equal((await request("PATCH", { costs: { partsCost: -1 } })).status, 400);
  record.costs.partsCost = 0;
  assert.equal(saves, 2);
  // There is no existing terminal-status edit prohibition. Editing details
  // must preserve the saved terminal status, end date and audit history.
  for (const status of ["Completed", "Cancelled"]) {
    record.status = status;
    record.completionProof = { billImage: "bill.jpg", cardImage: "card.jpg" };
    const endDate = record.endDate.toISOString();
    const historyLength = record.statusHistory.length;
    assert.equal((await request("PATCH", { title: `${status} details` })).status, 200);
    assert.equal(record.status, status);
    assert.equal(record.endDate.toISOString(), endDate);
    assert.equal(record.statusHistory.length, historyLength);
  }
  found = false;
  assert.equal((await request("PATCH", {})).status, 404);
});

test("maintenance edits persist to the existing record in an isolated database", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const owner = await createUserAndLogin(ctx.base);
  const outsider = await createUserAndLogin(ctx.base);
  const api = client(ctx.base, owner.token);
  async function employeeApi(companyOwner, suffix) {
    const credentials = {
      fullName: `Fleet Employee ${suffix}`, mobileNumber: `987650432${suffix}`,
      email: `fleet${suffix}@maintenance.test`, password: "Passw0rd!", role: "FLEET_MANAGER",
    };
    const created = await client(ctx.base, companyOwner.token)("POST", "/auth/employees", credentials);
    assert.equal(created.status, 201);
    const login = await client(ctx.base)("POST", "/auth/login", { emailOrMobile: credentials.email, password: credentials.password });
    assert.equal(login.status, 200);
    return client(ctx.base, login.json.data.accessToken);
  }
  const staffApi = await employeeApi(owner, 1);
  const foreignStaffApi = await employeeApi(outsider, 2);
  const vehicle = new mongoose.Types.ObjectId();
  await Vehicle.collection.insertOne({ _id: vehicle, company: new mongoose.Types.ObjectId(owner.user.id), isDeleted: false });
  const record = await Maintenance.create({ vehicle, startDate: "2026-01-01", endDate: "2026-01-02", title: "Before" });
  const path = `/vehicles/maintenance/${record._id}`;
  const verifyIntegrity = await editIntegrityGuard();
  const count = await Maintenance.countDocuments();
  assert.equal((await api("GET", path)).status, 200);
  const beforeOpen = (await Maintenance.findById(record._id)).toObject();
  const vehicleBeforeOpen = await Vehicle.collection.findOne({ _id: vehicle });
  const opened = await staffApi("GET", path);
  assert.equal(opened.status, 200);
  assert.equal(opened.json.data._id, String(record._id));
  assert.deepEqual((await Maintenance.findById(record._id)).toObject(), beforeOpen);
  assert.deepEqual(await Vehicle.collection.findOne({ _id: vehicle }), vehicleBeforeOpen);
  assert.equal((await staffApi("GET", `/vehicles/maintenance/${vehicle}`)).status, 404);
  assert.equal((await staffApi("GET", "/vehicles/maintenance/invalid-id")).status, 400);
  assert.equal((await staffApi("PATCH", "/vehicles/maintenance/invalid-id", {})).status, 400);
  const response = await api("PATCH", path, { title: "After", vehicle: String(vehicle), maintenanceType: "" });
  assert.equal(response.status, 200);
  assert.equal(response.json.data._id, String(record._id));
  assert.equal((await Maintenance.findById(record._id)).title, "After");
  assert.equal(await Maintenance.countDocuments(), count);
  const staffUpdate = await staffApi("PATCH", path, { vehicle: String(vehicle), title: "Staff edit" });
  assert.equal(staffUpdate.status, 200);
  assert.equal(staffUpdate.json.data._id, String(record._id));
  assert.equal((await Maintenance.findById(record._id)).title, "Staff edit");
  assert.equal(await Maintenance.countDocuments(), count);
  assert.equal((await foreignStaffApi("GET", path)).status, 404);
  assert.equal((await foreignStaffApi("PATCH", path, { title: "Foreign staff edit" })).status, 404);
  const foreignVehicle = new mongoose.Types.ObjectId();
  await Vehicle.collection.insertOne({ _id: foreignVehicle, company: new mongoose.Types.ObjectId(outsider.user.id), isDeleted: false });
  assert.equal((await staffApi("PATCH", path, { vehicle: String(foreignVehicle) })).status, 404);
  assert.equal(String((await Maintenance.findById(record._id)).vehicle), String(vehicle));
  const denied = await client(ctx.base, outsider.token)("PATCH", path, { title: "Unauthorized" });
  assert.equal(denied.status, 404);
  assert.equal(denied.json.success, false);
  assert.equal((await Maintenance.findById(record._id)).title, "Staff edit");
  const missing = await api("PATCH", `/vehicles/maintenance/${new mongoose.Types.ObjectId()}`, { title: "Missing" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.message, "Maintenance record not found");
  assert.equal((await api("PATCH", path, { status: "Completed" })).status, 400);
  assert.equal((await api("PATCH", path, { endDate: "2025-12-31" })).status, 400);
  assert.equal((await Maintenance.findById(record._id)).status, "Scheduled");
  const reloaded = await staffApi("GET", path);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.json.data._id, String(record._id));
  assert.equal(reloaded.json.data.title, "Staff edit");
  assert.equal(reloaded.json.data.isDeleted, false);
  assert.equal((await staffApi("GET", `/vehicles/maintenance/${new mongoose.Types.ObjectId()}`)).status, 404);
  await verifyIntegrity();
});
