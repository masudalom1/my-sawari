import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";

// Unified fleet: any signed-in user selects and books a Fleet Dashboard
// vehicle by its MongoDB _id, whichever company registered it. Signing in
// is still required, and conflicts still span every company.
test("New Booking and Add Maintenance use the clicked vehicle _id across the unified fleet", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const { default: Vehicle } = await import("../src/models/vehicle.model.js");
  const { default: Booking } = await import("../src/models/booking.model.js");
  const { default: Maintenance } = await import("../src/models/maintenance.model.js");

  const ownerA = await createUserAndLogin(ctx.base);
  const ownerB = await createUserAndLogin(ctx.base);
  const other = await createUserAndLogin(ctx.base); // owns no vehicles
  const apiA = client(ctx.base, ownerA.token);
  const apiB = client(ctx.base, ownerB.token);
  const apiOther = client(ctx.base, other.token);
  const anonymous = client(ctx.base);

  const register = async (api, vehicleName, vehicleNumber, pricePerDay) => {
    const created = await api("POST", "/vehicles/create", { vehicleName, vehicleNumber, manufacturer: "Maruti", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
    assert.equal(created.status, 201, created.json.message);
    assert.equal((await api("PUT", `/vehicles/update/${created.json.data._id}`, { pricePerDay })).status, 200);
    return created.json.data._id;
  };
  const testVehicle = await register(apiA, "Test vehicle", "AS01MM1234", 1000);
  const alto = await register(apiB, "Alto 800 White 4479", "AS01FG4479", 1200);
  const ids = (res) => res.json.vehicles.map(vehicle => String(vehicle._id)).sort();

  // The New Booking list is the Fleet Dashboard's vehicle set, same _ids, for every signed-in user.
  const dashboard = await apiOther("GET", "/dashboard/import");
  const fleet = [testVehicle, alto].sort();
  assert.deepEqual(ids(dashboard), fleet);
  for (const api of [apiA, apiB, apiOther]) {
    const list = await api("GET", "/bookings/vehicles");
    assert.equal(list.status, 200);
    assert.deepEqual(ids(list), fleet);
  }
  const listed = (await apiOther("GET", "/bookings/vehicles")).json.vehicles;
  const listedTest = listed.find(vehicle => vehicle._id === testVehicle);
  assert.equal(listedTest.vehicleName, "Test vehicle");
  assert.equal(listedTest.vehicleNumber, "AS01MM1234");
  assert.equal(listedTest.pricePerDay, 1000);
  for (const vehicle of listed) {
    assert.equal(vehicle.company, undefined);
    assert.equal(vehicle.createdBy, undefined);
  }

  const payload = { customerName: "Asha", mobileNumber: "9876500201", tripType: "local", fromDate: dayFromToday(2), toDate: dayFromToday(4), pickupTime: "10:00 AM", dropTime: "10:00 AM", vehicleId: testVehicle, vehicleType: "car", paymentMethod: "cash" };

  // Signing in is still required.
  assert.equal((await anonymous("GET", "/bookings/vehicles")).status, 401);
  assert.equal((await anonymous("POST", "/leads/create", payload)).status, 401);
  assert.equal((await client(ctx.base, "not-a-token")("GET", "/bookings/vehicles")).status, 401);
  assert.equal((await anonymous("POST", "/dashboard/maintenance", { vehicle: alto, startDate: `${dayFromToday(30)}T00:00:00.000Z`, endDate: `${dayFromToday(31)}T00:00:00.000Z` })).status, 401);
  assert.equal(await Booking.countDocuments(), 0);

  // A user from another company books Test vehicle with its exact _id.
  const booked = await apiOther("POST", "/leads/create", { ...payload, bookingAmount: 500 });
  assert.equal(booked.status, 201, booked.json.message);
  const bookingId = booked.json.booking._id;
  assert.equal(String(booked.json.booking.vehicleId._id), testVehicle);
  assert.equal(booked.json.booking.vehicleNumber, "AS01MM1234");
  assert.equal(String((await Booking.findById(bookingId).lean()).vehicleId), testVehicle);

  // Switching to the other company's vehicle books that one, not the previous.
  const switched = await apiOther("POST", "/leads/create", { ...payload, mobileNumber: "9876500202", vehicleId: alto });
  assert.equal(switched.status, 201, switched.json.message);
  assert.equal(String(switched.json.booking.vehicleId._id), alto);
  assert.equal(switched.json.booking.vehicleNumber, "AS01FG4479");

  // Conflicts still block across companies, in both directions.
  const ownerOverlap = await apiA("POST", "/leads/create", { ...payload, mobileNumber: "9876500203", fromDate: dayFromToday(3), toDate: dayFromToday(5) });
  assert.equal(ownerOverlap.status, 409);
  assert.match(ownerOverlap.json.message, /already booked/);
  assert.equal((await apiOther("POST", "/leads/create", { ...payload, mobileNumber: "9876500204", fromDate: dayFromToday(3), toDate: dayFromToday(5) })).status, 409);

  // Add Maintenance on the clicked vehicle's _id, by a user from another company.
  const service = await apiOther("POST", "/dashboard/maintenance", { vehicle: testVehicle, startDate: `${dayFromToday(10)}T00:00:00.000Z`, endDate: `${dayFromToday(12)}T00:00:00.000Z` });
  assert.equal(service.status, 201, service.json.message);
  assert.equal(String((await Maintenance.findById(service.json.data._id).lean()).vehicle), testVehicle);
  const duringService = await apiB("POST", "/leads/create", { ...payload, mobileNumber: "9876500205", fromDate: dayFromToday(11), toDate: dayFromToday(13) });
  assert.equal(duringService.status, 409);
  assert.match(duringService.json.message, /maintenance/);

  // Edit Booking prefill loads the cross-company vehicle.
  const forEdit = await apiOther("GET", `/bookings/${bookingId}`);
  assert.equal(forEdit.status, 200);
  assert.equal(String(forEdit.json.booking.vehicleId._id), testVehicle);
  assert.equal(forEdit.json.vehicleSelectionRequired, false);

  // Ownership untouched; nothing duplicated.
  assert.equal(String((await Vehicle.findById(testVehicle).lean()).company), ownerA.user.id);
  assert.equal(String((await Vehicle.findById(alto).lean()).company), ownerB.user.id);
  assert.equal(await Vehicle.countDocuments(), 2);
  assert.equal(await Booking.countDocuments(), 2);

  // A removed vehicle leaves the fleet list and cannot be booked.
  await Vehicle.updateOne({ _id: alto }, { $set: { isDeleted: true } });
  assert.deepEqual(ids(await apiOther("GET", "/bookings/vehicles")), [testVehicle]);
  assert.equal((await apiOther("POST", "/leads/create", { ...payload, mobileNumber: "9876500206", vehicleId: alto, fromDate: dayFromToday(20), toDate: dayFromToday(21) })).status, 404);
  assert.equal(await Booking.countDocuments(), 2);
});
