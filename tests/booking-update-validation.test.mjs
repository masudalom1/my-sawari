import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

test("booking partial updates preserve omitted data and validate availability before saving", async t => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const { default: Booking } = await import("../src/models/booking.model.js");
  const { default: Vehicle } = await import("../src/models/vehicle.model.js");
  const { default: Maintenance } = await import("../src/models/maintenance.model.js");
  const owner = await createUserAndLogin(ctx.base);
  const api = client(ctx.base, owner.token);
  const vehicle = new mongoose.Types.ObjectId();
  await Vehicle.collection.insertOne({ _id: vehicle, company: new mongoose.Types.ObjectId(owner.user.id), isDeleted: false, pricePerDay: 9000 });
  const record = await Booking.create({ company: owner.user.id, createdBy: owner.user.id, vehicleId: vehicle, customerName: "Saved customer", mobileNumber: "9876500001", occupation: "Driver", tripType: "outstation", fromDate: "2026-11-01", toDate: "2026-11-02", pickupTime: "08:00 AM", dropTime: "08:00 AM", pickupDropRequired: true, serviceType: "pickup_drop", pickup: { location: "Airport", landmark: "Gate", charge: 100 }, drop: { location: "Hotel", charge: 200 }, payment: { vehicleRent: 1200, totalAmount: 1500, pickupCharge: 100, dropCharge: 200, bookingAmountPaid: 500 } });
  const path = `/leads/booking-update/${record._id}`;
  const before = await Booking.findById(record._id).lean();
  assert.equal((await api("PUT", path, { customerName: "Changed", alternateMobileNumber: "" })).status, 200);
  let saved = await Booking.findById(record._id).lean();
  assert.equal(saved.customerName, "Changed");
  assert.equal(saved.occupation, "Driver");
  assert.equal(saved.tripType, "outstation");
  assert.deepEqual(saved.pickup, before.pickup);
  assert.deepEqual(saved.drop, before.drop);
  assert.deepEqual(saved.payment, before.payment);
  assert.equal((await api("PUT", path, { toDate: "2026-11-03", dropTime: "18:00" })).status, 200);
  saved = await Booking.findById(record._id).lean();
  assert.deepEqual(saved.payment, before.payment);
  assert.equal(saved.totalDays, 2);
  assert.equal((await api("PUT", path, { pickup: { landmark: "" }, tripType: "local" })).status, 200);
  saved = await Booking.findById(record._id).lean();
  assert.equal(saved.pickup.landmark, "");
  assert.equal(saved.pickup.location, "Airport");
  assert.equal(saved.pickup.charge, 100);

  async function rejected(body, status = 400) {
    const snapshot = await Booking.findById(record._id).lean();
    const response = await api("PUT", path, body);
    assert.equal(response.status, status, response.json.message);
    assert.deepEqual(await Booking.findById(record._id).lean(), snapshot);
  }
  for (const body of [{ vehicleId: "invalid" }, { vehicleId: null }, { fromDate: "2026-02-30" }, { toDate: "" }, { pickupTime: "13:00 PM" }, { dropTime: "09:90" }, { toDate: "2026-11-01", dropTime: "08:00 AM" }, { tripType: "unsupported" }, { tripType: null }, { serviceType: "invalid" }, { pickupDropRequired: "false" }, { residents: 0 }, { pickup: null }, { pickup: { charge: -1 } }, { customerName: "" }, { payment: null }, { payment: { paymentMethod: null } }, { bookingAmount: [] }]) await rejected(body);

  const conflict = await Booking.create({ company: owner.user.id, createdBy: owner.user.id, vehicleId: vehicle, customerName: "Other customer", mobileNumber: "9876500002", fromDate: "2026-11-04", toDate: "2026-11-05", pickupTime: "08:00 AM", dropTime: "08:00 AM" });
  await rejected({ toDate: "2026-11-04", dropTime: "09:00 AM" }, 409);
  // Creation permits exact adjoining times; edits follow the same rule.
  assert.equal((await api("PUT", path, { toDate: "2026-11-04", dropTime: "08:00 AM" })).status, 200);
  await Booking.updateOne({ _id: conflict._id }, { status: "cancelled" });
  const maintenance = await Maintenance.create({ vehicle, startDate: "2026-11-05", endDate: "2026-11-06", status: "Scheduled" });
  await rejected({ toDate: "2026-11-06" }, 409);
  await Maintenance.updateOne({ _id: maintenance._id }, { status: "Completed" });
  assert.equal((await api("PUT", path, { toDate: "2026-11-06" })).status, 200);
  assert.equal((await api("PUT", path, { serviceType: "pickup" })).status, 200);
  saved = await Booking.findById(record._id).lean();
  assert.equal(saved.pickup.charge, 100);
  assert.equal(saved.drop.charge, 0);
  assert.equal(saved.drop.location, "Hotel");
  assert.equal((await api("PUT", path, { pickupDropRequired: false })).status, 200);
  saved = await Booking.findById(record._id).lean();
  assert.equal(saved.pickup.charge, 0);
  assert.equal(saved.pickup.location, "Airport");
  for (const status of ["active", "vehicle_handover", "completed", "cancelled"]) {
    await Booking.updateOne({ _id: record._id }, { status });
    await rejected({ customerName: "Blocked" }, 409);
  }
  assert.equal(await Booking.countDocuments(), 2);
});
