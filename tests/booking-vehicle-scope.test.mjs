import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";

// Regression: vehicles registered by an employee were stamped with the
// employee's own id, while New Booking looks vehicles up by the owner's
// company, so they showed on the calendar but never in the booking dropdown.
test("employee-registered vehicles are selectable in New Booking across the unified fleet", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const owner = await createUserAndLogin(ctx.base);
  const outsider = await createUserAndLogin(ctx.base);
  const ownerApi = client(ctx.base, owner.token);
  const foreign = client(ctx.base, outsider.token);
  const credentials = { fullName: "Fleet Staff", mobileNumber: "9876543212", email: "fleet-staff@test.dev", password: "Passw0rd!", role: "FLEET_MANAGER" };
  assert.equal((await ownerApi("POST", "/auth/employees", credentials)).status, 201);
  const login = await client(ctx.base)("POST", "/auth/login", { emailOrMobile: credentials.email, password: credentials.password });
  assert.equal(login.status, 200);
  const staff = client(ctx.base, login.json.data.accessToken);

  const created = await staff("POST", "/vehicles/create", { vehicleName: "Swift Staff", vehicleNumber: "KA01AB2001", manufacturer: "Maruti", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
  assert.equal(created.status, 201, created.json.message);
  const vehicleId = created.json.data._id;
  assert.equal(String(created.json.data.company), owner.user.id);
  assert.equal((await staff("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);

  for (const api of [ownerApi, staff]) {
    const choices = await api("GET", "/bookings/vehicles");
    assert.equal(choices.status, 200);
    assert.deepEqual(choices.json.vehicles.map(vehicle => vehicle._id), [vehicleId]);
  }
  // Unified fleet: users of other companies see the same vehicle _ids.
  assert.deepEqual((await foreign("GET", "/bookings/vehicles")).json.vehicles.map(vehicle => vehicle._id), [vehicleId]);

  const payload = { customerName: "Asha", mobileNumber: "9876500101", tripType: "local", fromDate: dayFromToday(2), toDate: dayFromToday(4), pickupTime: "10:00 AM", dropTime: "10:00 AM", vehicleId, vehicleType: "car", paymentMethod: "cash" };
  assert.equal((await client(ctx.base)("POST", "/leads/create", payload)).status, 401);
  // A registration number is never accepted in place of the MongoDB _id.
  assert.equal((await ownerApi("POST", "/leads/create", { ...payload, vehicleId: "KA01AB2001" })).status, 400);
  const booked = await ownerApi("POST", "/leads/create", { ...payload, bookingAmount: 500 });
  assert.equal(booked.status, 201, booked.json.message);
  assert.equal(String(booked.json.booking.vehicleId?._id || booked.json.booking.vehicleId), vehicleId);
  const bookingId = booked.json.booking._id;
  const vehicleOf = booking => String(booking.vehicleId?._id || booking.vehicleId);

  // Reloading the calendar (range scope, as page.js does) puts it on this vehicle's row with the booked dates.
  const from = new Date(`${dayFromToday(0)}T00:00:00.000Z`).toISOString();
  const to = new Date(`${dayFromToday(30)}T00:00:00.000Z`).toISOString();
  const timeline = await staff("GET", `/dashboard/bookings/timeline?scope=range&from=${from}&to=${to}`);
  assert.equal(timeline.status, 200, timeline.json.message);
  const onCalendar = timeline.json.bookings.find(booking => String(booking._id) === bookingId);
  assert.ok(onCalendar, "created booking is on the reloaded calendar");
  assert.equal(vehicleOf(onCalendar), vehicleId);
  assert.equal(String(onCalendar.fromDate).slice(0, 10), payload.fromDate);
  assert.equal(String(onCalendar.toDate).slice(0, 10), payload.toDate);

  // Booking details show the same vehicle.
  const details = await staff("GET", `/bookings/${bookingId}`);
  assert.equal(details.status, 200, details.json.message);
  assert.equal(String(details.json.booking.vehicleId._id), vehicleId);
  assert.equal(details.json.booking.vehicleId.vehicleName, "Swift Staff");

  // Later rejected and accepted bookings must not touch this booking or its payment.
  const { default: Booking } = await import("../src/models/booking.model.js");
  const { default: PaymentHistory } = await import("../src/models/paymentHistory.model.js");
  const bookingBefore = await Booking.findById(bookingId).lean();
  const paymentsBefore = await PaymentHistory.find({ bookingId }).lean();
  assert.equal(paymentsBefore.reduce((sum, row) => sum + Number(row.amount || 0), 0), 500);

  // The backend stays the final authority on availability.
  const overlap = await staff("POST", "/leads/create", { ...payload, mobileNumber: "9876500102", fromDate: dayFromToday(3), toDate: dayFromToday(5) });
  assert.equal(overlap.status, 409);
  assert.match(overlap.json.message, /already booked/);

  const service = await ownerApi("POST", "/dashboard/maintenance", { vehicle: vehicleId, startDate: `${dayFromToday(10)}T00:00:00.000Z`, endDate: `${dayFromToday(12)}T00:00:00.000Z` });
  assert.equal(service.status, 201, service.json.message);
  const duringService = await staff("POST", "/leads/create", { ...payload, mobileNumber: "9876500103", fromDate: dayFromToday(11), toDate: dayFromToday(13) });
  assert.equal(duringService.status, 409);
  assert.match(duringService.json.message, /maintenance/);
  assert.ok(duringService.json.conflict.maintenanceId);

  // Bookings on other dates stay possible and the vehicle stays listed.
  const between = await staff("POST", "/leads/create", { ...payload, mobileNumber: "9876500104", fromDate: dayFromToday(6), toDate: dayFromToday(8) });
  assert.equal(between.status, 201, between.json.message);
  assert.deepEqual((await staff("GET", "/bookings/vehicles")).json.vehicles.map(vehicle => vehicle._id), [vehicleId]);

  assert.deepEqual(await Booking.findById(bookingId).lean(), bookingBefore);
  assert.deepEqual(await PaymentHistory.find({ bookingId }).lean(), paymentsBefore);
});
