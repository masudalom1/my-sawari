import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  startTestApp,
  client,
  createUserAndLogin,
  dayFromToday,
  jpegBlob,
} from "./helpers/harness.mjs";
import {
  isBlockedByVehicleDeactivation,
  vehicleDeactivationStartsAt,
} from "../shared/vehicleDeactivation.mjs";

let ctx;
let admin;
let adminApi;
let Vehicle;
let vehicleSeq = 0;
const REASON = "vehicle_sold";

before(async () => {
  ctx = await startTestApp();
  admin = await createUserAndLogin(ctx.base);
  adminApi = client(ctx.base, admin.token);
  Vehicle = (await import("../src/models/vehicle.model.js")).default;
});

after(async () => {
  await ctx?.stop();
});

async function createCar(overrides = {}) {
  vehicleSeq += 1;
  const form = new FormData();
  const fields = {
    vehicleName: "Creta",
    vehicleNumber: `KA09ED${String(vehicleSeq).padStart(4, "0")}`,
    displayName: "Creta Airport",
    manufacturer: "Hyundai",
    model: "Creta",
    variant: "SX",
    modelYear: "2022",
    pricePerDay: "2200",
    category: "car",
    vehicleType: "SUV",
    fuelType: "Diesel",
    transmission: "Manual",
    seatingCapacity: "5",
    color: "White",
    registrationDate: "2022-04-10",
    notes: "Airport duty",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("images", jpegBlob(), "creta.jpg");
  const created = await adminApi("POST", "/vehicles/create", form);
  assert.equal(created.status, 201, created.json.message);
  return created.json.data;
}

function bookingPayload(vehicleId, fromDate, toDate, mobileNumber) {
  return {
    customerName: "Asha",
    mobileNumber,
    tripType: "local",
    fromDate,
    toDate,
    pickupTime: "10:00 AM",
    dropTime: "10:00 AM",
    vehicleId,
    vehicleType: "car",
    paymentMethod: "cash",
    paymentDate: dayFromToday(-1),
    paymentTime: "14:35",
  };
}

test("the deactivation date is the last bookable day; the block starts at the next India midnight", () => {
  const vehicle = { deactivation: { date: new Date("2026-12-05T00:00:00Z") } };
  const startsAt = vehicleDeactivationStartsAt(vehicle);
  assert.equal(new Date(startsAt).toISOString(), "2026-12-05T18:30:00.000Z", "6 Dec 00:00 IST");
  assert.equal(
    isBlockedByVehicleDeactivation(vehicle, Date.parse("2026-12-05T18:29:00Z")),
    false,
    "a trip ending at 11:59 PM on the last day is allowed",
  );
  assert.equal(isBlockedByVehicleDeactivation(vehicle, startsAt), false, "ending exactly at midnight is allowed");
  assert.equal(isBlockedByVehicleDeactivation(vehicle, startsAt + 60_000), true);
  assert.equal(isBlockedByVehicleDeactivation({}, Number.MAX_SAFE_INTEGER), false);
  assert.equal(
    isBlockedByVehicleDeactivation({ deactivation: { date: null } }, Number.MAX_SAFE_INTEGER),
    false,
  );
});

test("Edit and Deactivate are enforced on the server by their own permissions", async () => {
  const vehicle = await createCar();
  const staff = await createUserAndLogin(ctx.base, {
    role: "ADMIN",
    businessName: admin.user.businessName,
  });
  const staffApi = client(ctx.base, staff.token);
  const setPolicy = async (permissions) => {
    const saved = await adminApi("PUT", "/auth/roles/ADMIN/permissions", { permissions });
    assert.equal(saved.status, 200, saved.json.message);
    return saved;
  };
  const deactivateBody = { deactivationDate: dayFromToday(30), reason: REASON };

  await setPolicy({ "page.vehicleManager.view": true });
  assert.equal((await staffApi("GET", `/vehicles/${vehicle._id}`)).status, 403);
  assert.equal(
    (await staffApi("PUT", `/vehicles/update/${vehicle._id}`, { pricePerDay: 1 })).status,
    403,
  );
  assert.equal(
    (await staffApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, deactivateBody)).status,
    403,
  );

  await setPolicy({ "page.dashboard.edit": true });
  const opened = await staffApi("GET", `/vehicles/${vehicle._id}`);
  assert.equal(opened.status, 200, "Edit alone can load the vehicle it edits");
  assert.equal(opened.json.data.manufacturer, "Hyundai");
  const edited = await staffApi("PUT", `/vehicles/update/${vehicle._id}`, { pricePerDay: 2100 });
  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.pricePerDay, 2100);
  assert.equal(
    (await staffApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, deactivateBody)).status,
    403,
    "Edit does not imply Deactivate",
  );

  const granted = await setPolicy({
    "page.dashboard.edit": false,
    "page.dashboard.deactivate": true,
  });
  assert.equal(granted.json.data.permissions["page.dashboard.deactivate"], true);
  const reloaded = await adminApi("GET", "/auth/roles/permissions");
  assert.equal(
    reloaded.json.data.roles.find(({ role }) => role === "ADMIN")
      .permissions["page.dashboard.deactivate"],
    true,
    "Super Admin can assign and persist Deactivate",
  );
  assert.equal(
    (await staffApi("PUT", `/vehicles/update/${vehicle._id}`, { pricePerDay: 1 })).status,
    403,
    "Deactivate does not imply Edit",
  );

  const denied = await adminApi("PUT", `/auth/employees/${staff.user.id}/permissions`, {
    overrides: { "page.dashboard.deactivate": "deny" },
  });
  assert.equal(denied.status, 200, denied.json.message);
  assert.equal(
    (await staffApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, deactivateBody)).status,
    403,
  );
  await adminApi("PUT", `/auth/employees/${staff.user.id}/permissions`, {
    overrides: { "page.dashboard.deactivate": "inherit" },
  });

  const deactivated = await staffApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, deactivateBody);
  assert.equal(deactivated.status, 200, deactivated.json.message);
  assert.equal(String(deactivated.json.data.deactivation.deactivatedBy._id), staff.user.id);
});

test("Edit saves the whole vehicle form through the update API", async () => {
  const vehicle = await createCar();
  const form = new FormData();
  const fields = {
    vehicleName: "Creta Facelift",
    displayName: "",
    vehicleNumber: ` ${vehicle.vehicleNumber.toLowerCase()} `,
    manufacturer: "Hyundai",
    model: "",
    variant: "SX(O)",
    modelYear: "",
    pricePerDay: "1800",
    category: "bike",
    vehicleType: "",
    fuelType: "Petrol",
    transmission: "Automatic",
    seatingCapacity: "2",
    color: "Black",
    chassisNumber: "CH-1",
    engineNumber: "EN-1",
    registrationDate: "",
    insuranceValidUpto: "2027-03-31",
    pucValidUpto: "",
    fitnessValidUpto: "",
    notes: "Converted fixture",
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("images", jpegBlob(), "side.jpg");

  const saved = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, form);
  assert.equal(saved.status, 200, saved.json.message);
  const read = await adminApi("GET", `/vehicles/${vehicle._id}`);
  const data = read.json.data;
  assert.equal(data.vehicleName, "Creta Facelift");
  assert.equal(data.displayName, "");
  assert.equal(data.vehicleNumber, vehicle.vehicleNumber);
  assert.equal(data.model, "");
  assert.equal(data.variant, "SX(O)");
  assert.equal(data.modelYear, null);
  assert.equal(data.pricePerDay, 1800);
  assert.equal(data.category, "bike");
  assert.equal(data.vehicleType, undefined, "bikes do not keep a car body type");
  assert.equal(data.seatingCapacity, 2);
  assert.equal(data.registrationDate, null);
  assert.equal(data.insuranceValidUpto.slice(0, 10), "2027-03-31");
  assert.equal(data.status, "available");
  assert.equal(data.images.length, 2);
  assert.equal(data.images[0].url, vehicle.images[0].url);
  assert.match(data.images[1].url, /^https:\/\/res\.cloudinary\.com\//);
  assert.ok(data.images[1].publicId);

  const card = await adminApi(
    "GET",
    `/vehicles/fleet-manager?search=${encodeURIComponent("Creta Facelift")}`,
  );
  assert.equal(card.status, 200);
  assert.equal(card.json.data[0]._id, vehicle._id);
  assert.equal(card.json.data[0].pricePerDay, 1800);
  assert.equal(card.json.data[0].deactivation.date, null);

  const partial = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, { pricePerDay: 1900 });
  assert.equal(partial.status, 200, partial.json.message);
  assert.equal(partial.json.data.pricePerDay, 1900);
  assert.equal(partial.json.data.variant, "SX(O)", "omitted fields are kept");

  const other = await createCar();
  const uploadIndex = ctx.cloudinary.uploadedPublicIds.length;
  const duplicate = new FormData();
  duplicate.append("vehicleNumber", other.vehicleNumber.toLowerCase());
  duplicate.append("images", jpegBlob(), "duplicate.jpg");
  const duplicateResponse = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, duplicate);
  assert.equal(duplicateResponse.status, 400);
  assert.ok(duplicateResponse.json.fieldErrors.vehicleNumber);
  assert.ok(
    ctx.cloudinary.destroyed.includes(ctx.cloudinary.uploadedPublicIds[uploadIndex]),
    "a photo uploaded with a rejected edit is deleted",
  );

  const tooMany = new FormData();
  for (let index = 0; index < 4; index += 1) {
    tooMany.append("images", jpegBlob(), `extra-${index}.jpg`);
  }
  const tooManyResponse = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, tooMany);
  assert.equal(tooManyResponse.status, 400);
  assert.ok(tooManyResponse.json.fieldErrors.images);
  assert.equal((await Vehicle.findById(vehicle._id).lean()).images.length, 2);

  const invalidCases = [
    [{ seatingCapacity: "2.5" }, "seatingCapacity"],
    [{ modelYear: "1500" }, "modelYear"],
    [{ pricePerDay: "-1" }, "pricePerDay"],
    [{ registrationDate: "2026-02-31" }, "registrationDate"],
    [{ category: "truck" }, "category"],
    [{ category: "car", vehicleType: "" }, "vehicleType"],
    [{ vehicleType: "SUV" }, "vehicleType"],
    [{ vehicleName: "  " }, "vehicleName"],
    [{ displayName: "d".repeat(101) }, "displayName"],
    [{ notes: "n".repeat(501) }, "notes"],
    [{ fuelType: "Gasoline" }, "fuelType"],
  ];
  for (const [body, field] of invalidCases) {
    const response = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, body);
    assert.equal(response.status, 400, field);
    assert.ok(response.json.fieldErrors?.[field], `${field}: ${JSON.stringify(response.json)}`);
  }
  assert.equal((await Vehicle.findById(vehicle._id).lean()).pricePerDay, 1900);

  assert.equal((await adminApi("PUT", "/vehicles/update/not-an-id", {})).status, 400);
});

// Edit keeps the maintenance rule from updateVehicleStatus: maintenance is
// completed only when the vehicle actually leaves service for Available, and
// a future scheduled block is kept.
test("Edit completes maintenance only on a real move from service to Available", async () => {
  const { default: Maintenance } = await import("../src/models/maintenance.model.js");
  const vehicle = await createCar();
  const vehicleId = new mongoose.Types.ObjectId(vehicle._id);
  const statusForm = (status) => {
    const form = new FormData();
    form.append("status", status);
    return form;
  };
  const { insertedId: futureId } = await Maintenance.collection.insertOne({
    vehicle: vehicleId,
    isDeleted: false,
    status: "Scheduled",
    title: "Tyre change",
    startDate: new Date(`${dayFromToday(5)}T04:30:00Z`),
    endDate: new Date(`${dayFromToday(6)}T04:30:00Z`),
    statusHistory: [],
  });
  const maintenanceStatus = async (id) => (await Maintenance.findById(id).lean()).status;

  const stillAvailable = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, statusForm("available"));
  assert.equal(stillAvailable.status, 200, stillAvailable.json.message);
  assert.equal(await maintenanceStatus(futureId), "Scheduled", "no transition, nothing completed");

  const toService = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, statusForm("maintenance"));
  assert.equal(toService.status, 200, toService.json.message);
  assert.equal(toService.json.data.status, "service", "status aliases are still accepted");

  const { insertedId: runningId } = await Maintenance.collection.insertOne({
    vehicle: vehicleId,
    isDeleted: false,
    status: "In Progress",
    title: "Brake pads",
    startDate: new Date(`${dayFromToday(-1)}T04:30:00Z`),
    endDate: new Date(`${dayFromToday(1)}T04:30:00Z`),
    statusHistory: [],
  });
  const backToAvailable = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, statusForm("available"));
  assert.equal(backToAvailable.status, 200, backToAvailable.json.message);
  assert.equal(backToAvailable.json.data.status, "available");
  assert.equal(await maintenanceStatus(runningId), "Completed");
  assert.equal(await maintenanceStatus(futureId), "Scheduled", "a future scheduled block is kept");

  const invalid = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, statusForm("parked"));
  assert.equal(invalid.status, 400);
  assert.ok(invalid.json.fieldErrors?.status);
});

test("deactivation is refused while bookings continue past the date, then blocks bookings after it", async () => {
  const vehicle = await createCar();
  const vehicleId = vehicle._id;
  const first = await adminApi(
    "POST",
    "/leads/create",
    bookingPayload(vehicleId, dayFromToday(1), dayFromToday(2), "9876501001"),
  );
  assert.equal(first.status, 201, first.json.message);

  const invalidDates = [dayFromToday(-1), "2026-02-31", "tomorrow", undefined];
  for (const deactivationDate of invalidDates) {
    const response = await adminApi("PATCH", `/vehicles/deactivate/${vehicleId}`, { deactivationDate, reason: REASON });
    assert.equal(response.status, 400, String(deactivationDate));
    assert.ok(response.json.fieldErrors.deactivationDate);
  }

  // Last bookable day = day 1, but the booking runs until day 2, 10:00 AM.
  const conflict = await adminApi("PATCH", `/vehicles/deactivate/${vehicleId}`, {
    deactivationDate: dayFromToday(1),
    reason: REASON,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "VEHICLE_DEACTIVATION_CONFLICT");
  assert.equal(conflict.json.conflictCount, 1);
  assert.equal(conflict.json.conflicts[0].kind, "booking");
  assert.equal(conflict.json.conflicts[0].bookingId, first.json.booking._id);
  assert.equal(conflict.json.conflicts[0].customerName, "Asha");
  assert.match(conflict.json.message, /booking workflow/);
  assert.equal(
    (await Vehicle.findById(vehicleId).lean()).deactivation.date,
    null,
    "a refused deactivation changes nothing",
  );
  assert.equal(
    (await adminApi("GET", `/bookings/${first.json.booking._id}`)).json.booking.status,
    "confirmed",
    "the conflicting booking is preserved",
  );

  const deactivationDate = dayFromToday(4);
  const deactivated = await adminApi("PATCH", `/vehicles/deactivate/${vehicleId}`, { deactivationDate, reason: REASON });
  assert.equal(deactivated.status, 200, deactivated.json.message);
  assert.equal(deactivated.json.data.deactivation.date.slice(0, 10), deactivationDate);
  assert.equal(String(deactivated.json.data.deactivation.deactivatedBy._id), admin.user.id);
  assert.ok(deactivated.json.data.deactivation.deactivatedAt);
  assert.equal(deactivated.json.data.status, "available", "status flows are untouched");
  assert.equal(deactivated.json.data.isDeleted, false, "the vehicle is kept");

  const again = await adminApi("PATCH", `/vehicles/deactivate/${vehicleId}`, {
    deactivationDate: dayFromToday(6),
    reason: REASON,
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "VEHICLE_ALREADY_DEACTIVATED");

  const list = await adminApi("GET", `/vehicles/fleet-manager?search=${vehicle.vehicleNumber}`);
  assert.equal(list.json.data[0].deactivation.date.slice(0, 10), deactivationDate);
  const picker = await adminApi("GET", "/bookings/vehicles");
  assert.equal(
    picker.json.vehicles.find(({ _id }) => _id === vehicleId).deactivation.date.slice(0, 10),
    deactivationDate,
    "the booking form receives the date for its availability check",
  );
  const colourSheet = await adminApi("GET", "/dashboard/import");
  assert.equal(colourSheet.status, 200, colourSheet.json.message);
  const sheetRow = colourSheet.json.vehicles.find(({ _id }) => String(_id) === vehicleId);
  assert.equal(sheetRow.deactivationDate, deactivationDate, "the Colour Sheet feed carries the date");
  assert.equal(sheetRow.isDeleted, false);

  const lastDay = await adminApi("POST", "/leads/create", {
    ...bookingPayload(vehicleId, dayFromToday(3), dayFromToday(4), "9876501002"),
    dropTime: "11:30 PM",
  });
  assert.equal(
    lastDay.status,
    201,
    `a booking ending at 11:30 PM on the last bookable day is allowed: ${lastDay.json.message}`,
  );

  const crossing = await adminApi("POST", "/leads/create", {
    ...bookingPayload(vehicleId, dayFromToday(4), dayFromToday(5), "9876501004"),
    pickupTime: "11:45 PM",
    dropTime: "06:00 AM",
  });
  assert.equal(crossing.status, 409, "starting before the cutoff and continuing past it is blocked");
  assert.equal(crossing.json.code, "VEHICLE_DEACTIVATED");
  assert.equal(crossing.json.conflict.deactivationDate, deactivationDate);
  assert.match(crossing.json.message, /deactivated after/);

  const after = await adminApi(
    "POST",
    "/leads/create",
    bookingPayload(vehicleId, dayFromToday(7), dayFromToday(8), "9876501005"),
  );
  assert.equal(after.status, 409);
  assert.equal(after.json.code, "VEHICLE_DEACTIVATED");

  const moved = await adminApi("PUT", `/leads/booking-update/${lastDay.json.booking._id}`, {
    fromDate: dayFromToday(4),
    toDate: dayFromToday(6),
  });
  assert.equal(moved.status, 409, "rescheduling past the date is blocked");
  assert.equal(moved.json.code, "VEHICLE_DEACTIVATED");
  const stillSaved = await adminApi("GET", `/bookings/${lastDay.json.booking._id}`);
  assert.equal(stillSaved.json.booking.toDate.slice(0, 10), dayFromToday(4));

  const lead = await adminApi("POST", "/leads", {
    customerName: "Lead fixture",
    mobileNumber: "9876501006",
    vehicleType: "car",
  });
  assert.equal(lead.status, 201, lead.json.message);
  const leadBooking = await adminApi("PUT", `/leads/${lead.json.data._id}/create-booking`, {
    vehicleId,
    paymentMethod: "cash",
    fromDate: dayFromToday(6),
    toDate: dayFromToday(7),
    totalDays: 1,
  });
  assert.equal(leadBooking.status, 409, "lead bookings follow the same rule");
  assert.equal(leadBooking.json.code, "VEHICLE_DEACTIVATED");

  const available = async (fromDate, toDate, pickupTime, dropTime) => {
    const query = new URLSearchParams({ fromDate, toDate, pickupTime, dropTime });
    const response = await adminApi("GET", `/vehicles/available?${query}`);
    assert.equal(response.status, 200);
    return response.json.data.some(({ _id }) => _id === vehicleId);
  };
  assert.equal(
    await available(dayFromToday(2), dayFromToday(3), "11:00 AM", "09:00 AM"),
    true,
    "free dates before the deactivation stay available",
  );
  assert.equal(await available(dayFromToday(5), dayFromToday(6), "10:00 AM", "10:00 AM"), false);
  assert.equal(await available(dayFromToday(4), dayFromToday(5), "11:45 PM", "06:00 AM"), false);
});

test("a running rental on the vehicle blocks deactivation even after a vehicle exchange", async () => {
  const vehicle = await createCar();
  const { default: Handover } = await import("../src/models/handover.model.js");
  const { default: Booking } = await import("../src/models/booking.model.js");
  const otherVehicle = await createCar();
  // The booking still names the original vehicle; the rental was exchanged
  // onto `vehicle`, so only the handover shows it is in use.
  const booking = await Booking.create({
    company: admin.user.id,
    createdBy: admin.user.id,
    customerName: "Exchange fixture",
    mobileNumber: "9876501010",
    vehicleId: otherVehicle._id,
    fromDate: dayFromToday(0),
    toDate: dayFromToday(1),
    status: "completed",
  });
  const rental = await Handover.collection.insertOne({
    bookingId: booking._id,
    isDeleted: false,
    handoverStatus: "active",
    bookingStatus: "active",
    customer: { fullName: "Exchange fixture" },
    vehicle: { vehicleId: new mongoose.Types.ObjectId(vehicle._id) },
    trip: {
      pickupDateTime: new Date(`${dayFromToday(0)}T04:30:00Z`),
      dropDateTime: new Date(`${dayFromToday(3)}T04:30:00Z`),
    },
  });

  const conflict = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, {
    deactivationDate: dayFromToday(1),
    reason: REASON,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.conflicts[0].kind, "rental");
  assert.equal(conflict.json.conflicts[0].handoverId, String(rental.insertedId));
  assert.equal(conflict.json.conflicts[0].customerName, "Exchange fixture");

  const fine = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, {
    deactivationDate: dayFromToday(3),
    reason: REASON,
  });
  assert.equal(fine.status, 200, "a rental that ends on the last bookable day is allowed");
});

test("rental extensions, vehicle exchanges and handovers cannot run past the date", async () => {
  const { default: Handover } = await import("../src/models/handover.model.js");
  const vehicle = await createCar();
  const spare = await createCar();
  const deactivationDate = dayFromToday(3);
  for (const target of [vehicle, spare]) {
    const response = await adminApi("PATCH", `/vehicles/deactivate/${target._id}`, { deactivationDate, reason: REASON });
    assert.equal(response.status, 200, response.json.message);
  }
  const otherVehicle = await createCar();
  const drop = new Date(`${dayFromToday(2)}T04:30:00Z`);
  const rentalOn = async (vehicleId) =>
    (await Handover.collection.insertOne({
      isDeleted: false,
      handoverStatus: "active",
      bookingStatus: "active",
      customer: { fullName: "Rental fixture" },
      vehicle: { vehicleId: new mongoose.Types.ObjectId(vehicleId) },
      trip: { pickupDateTime: new Date(`${dayFromToday(0)}T04:30:00Z`), dropDateTime: drop },
    })).insertedId;

  const rentalId = await rentalOn(vehicle._id);
  const extended = await adminApi("PUT", `/handover/rentals/edit/${rentalId}`, {
    dropDateTime: new Date(`${dayFromToday(4)}T04:30:00Z`).toISOString(),
  });
  assert.equal(extended.status, 409, extended.json.message);
  assert.equal(extended.json.code, "VEHICLE_DEACTIVATED");
  assert.equal(
    (await Handover.findById(rentalId).lean()).trip.dropDateTime.toISOString(),
    drop.toISOString(),
    "the refused extension is not saved",
  );

  const directEdit = await adminApi("PUT", `/handover/update/${rentalId}`, {
    trip: {
      pickupDateTime: new Date(`${dayFromToday(0)}T04:30:00Z`).toISOString(),
      dropDateTime: new Date(`${dayFromToday(6)}T04:30:00Z`).toISOString(),
    },
  });
  assert.equal(directEdit.status, 409, "a direct API edit of the drop time is blocked too");
  assert.equal(directEdit.json.code, "VEHICLE_DEACTIVATED");
  assert.equal(
    (await Handover.findById(rentalId).lean()).trip.dropDateTime.toISOString(),
    drop.toISOString(),
  );

  const otherRentalId = await rentalOn(otherVehicle._id);
  const exchanged = await adminApi("PUT", `/handover/rentals/edit/${otherRentalId}`, {
    vehicleId: spare._id,
    dropDateTime: new Date(`${dayFromToday(5)}T04:30:00Z`).toISOString(),
  });
  assert.equal(exchanged.status, 409, "exchanging onto a deactivated vehicle past its date is blocked");
  assert.equal(exchanged.json.code, "VEHICLE_DEACTIVATED");
  assert.equal(
    String((await Handover.findById(otherRentalId).lean()).vehicle.vehicleId),
    String(otherVehicle._id),
  );
  assert.equal((await Vehicle.findById(spare._id).lean()).status, "available");

  const handover = await adminApi("POST", "/handover/create", {
    bookingId: new mongoose.Types.ObjectId().toString(),
    customer: { fullName: "Walk-in", mobileNumber: "9876501011" },
    identity: { aadhaarNumber: "123412341234", drivingLicenseNumber: "KA0120260001" },
    vehicle: { vehicleId: vehicle._id },
    trip: {
      pickupDateTime: new Date(`${dayFromToday(2)}T04:30:00Z`).toISOString(),
      dropDateTime: new Date(`${dayFromToday(5)}T04:30:00Z`).toISOString(),
    },
    payment: { fuelLevel: 7 },
  });
  assert.equal(handover.status, 409, handover.json.message);
  assert.equal(handover.json.code, "VEHICLE_DEACTIVATED");

  assert.equal((await Vehicle.findById(vehicle._id).lean()).status, "available");
});

test("a booking and a deactivation submitted together never both succeed", async () => {
  const { default: Booking } = await import("../src/models/booking.model.js");
  for (let round = 0; round < 4; round += 1) {
    const vehicle = await createCar();
    const [booking, deactivation] = await Promise.all([
      adminApi(
        "POST",
        "/leads/create",
        bookingPayload(vehicle._id, dayFromToday(4), dayFromToday(5), `98765020${String(round).padStart(2, "0")}`),
      ),
      adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, { deactivationDate: dayFromToday(2), reason: REASON }),
    ]);
    assert.notEqual(
      booking.status === 201 && deactivation.status === 200,
      true,
      `round ${round}: booking ${booking.status}, deactivation ${deactivation.status}`,
    );
    assert.ok([201, 409].includes(booking.status), `booking ${booking.status} ${booking.json.message}`);
    assert.ok([200, 409].includes(deactivation.status), `deactivation ${deactivation.status} ${deactivation.json.message}`);
    const saved = await Vehicle.findById(vehicle._id).lean();
    const bookings = await Booking.countDocuments({ vehicleId: vehicle._id, isDeleted: false });
    assert.ok(!(saved.deactivation.date && bookings > 0), `round ${round} left a conflicting booking`);
  }

  for (let round = 0; round < 4; round += 1) {
    const vehicle = await createCar();
    const created = await adminApi(
      "POST",
      "/leads/create",
      bookingPayload(vehicle._id, dayFromToday(1), dayFromToday(2), `98765030${String(round).padStart(2, "0")}`),
    );
    assert.equal(created.status, 201, created.json.message);
    const [moved, deactivation] = await Promise.all([
      adminApi("PUT", `/leads/booking-update/${created.json.booking._id}`, {
        fromDate: dayFromToday(5),
        toDate: dayFromToday(6),
      }),
      adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, { deactivationDate: dayFromToday(3), reason: REASON }),
    ]);
    assert.notEqual(
      moved.status === 200 && deactivation.status === 200,
      true,
      `round ${round}: reschedule ${moved.status}, deactivation ${deactivation.status}`,
    );
    const saved = await Vehicle.findById(vehicle._id).lean();
    const booking = await Booking.findById(created.json.booking._id).lean();
    assert.ok(
      !(saved.deactivation.date && booking.toDate.toISOString().slice(0, 10) > dayFromToday(3)),
      `round ${round} left a rescheduled booking past the date`,
    );
  }
});

test("deactivation is refused for unknown or removed vehicles", async () => {
  const vehicle = await createCar();
  await Vehicle.updateOne({ _id: vehicle._id }, { $set: { isDeleted: true } });
  const body = { deactivationDate: dayFromToday(1), reason: REASON };
  assert.equal((await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, body)).status, 404);
  assert.equal(
    (await adminApi("PATCH", "/vehicles/deactivate/000000000000000000000000", body)).status,
    404,
  );
  assert.equal((await adminApi("PATCH", "/vehicles/deactivate/not-an-id", body)).status, 400);
});

test("Fleet Manager counts deactivated vehicles on their own, keeps Total, and filters them", async () => {
  // An empty group is simply missing from the aggregation, so it reads as 0.
  const counts = async () => ({
    available: 0,
    rent: 0,
    service: 0,
    deactivated: 0,
    ...Object.fromEntries(
      (await adminApi("GET", "/vehicles/fleet-manager?limit=1")).json.stats.map(({ _id, count }) => [
        _id,
        count,
      ]),
    ),
  });
  const sum = (stats) => Object.values(stats).reduce((total, count) => total + count, 0);
  const listed = async (path) => (await adminApi("GET", path)).json;

  const available = await createCar();
  const toDeactivate = await createCar();
  const inService = await createCar();
  await Vehicle.updateOne({ _id: inService._id }, { $set: { status: "service" } });
  const before = await counts();

  const first = await adminApi("PATCH", `/vehicles/deactivate/${toDeactivate._id}`, {
    deactivationDate: dayFromToday(10),
    reason: REASON,
  });
  assert.equal(first.status, 200, first.json.message);
  const second = await adminApi("PATCH", `/vehicles/deactivate/${inService._id}`, {
    deactivationDate: dayFromToday(10),
    reason: REASON,
  });
  assert.equal(second.status, 200, second.json.message);
  const after = await counts();

  assert.equal(after.available, before.available - 1, "a deactivated vehicle leaves Available");
  assert.equal(after.service, before.service - 1, "a deactivated vehicle leaves Service");
  assert.equal(after.deactivated, before.deactivated + 2);
  assert.equal(sum(after), sum(before), "Total still covers every vehicle");

  const number = encodeURIComponent(toDeactivate.vehicleNumber);
  assert.equal((await listed(`/vehicles/fleet-manager?status=available&search=${number}`)).total, 0);
  const deactivatedList = await listed(`/vehicles/fleet-manager?status=deactivated&search=${number}`);
  assert.equal(deactivatedList.total, 1);
  assert.equal(deactivatedList.data[0]._id, toDeactivate._id);
  const allDeactivated = await listed("/vehicles/fleet-manager?status=deactivated&limit=100");
  assert.equal(allDeactivated.total, after.deactivated, "the list matches the count");
  assert.ok(allDeactivated.data.every(({ deactivation }) => deactivation?.date));
  const allAvailable = await listed("/vehicles/fleet-manager?status=available&limit=100");
  assert.equal(allAvailable.total, after.available);
  assert.ok(allAvailable.data.every(({ deactivation }) => !deactivation?.date));
  assert.ok(allAvailable.data.some(({ _id }) => _id === available._id));
  assert.equal((await listed(`/vehicles/fleet-manager?search=${number}`)).total, 1, "All still lists it");

  // The general vehicle list keeps its existing behaviour.
  const general = await listed(`/vehicles/all?status=available&search=${number}`);
  assert.equal(general.total, 1);
  assert.equal(general.stats.some(({ _id }) => _id === "deactivated"), false);
});

test("Fleet Manager search covers brand and model and combines with category and status", async () => {
  const tag = `zq${Date.now().toString(36)}`;
  const car = await createCar({ vehicleName: "City car", manufacturer: `${tag}Motors`, model: "Altura" });
  const bike = await createCar({
    vehicleName: "Commuter",
    category: "bike",
    vehicleType: "",
    seatingCapacity: "2",
    manufacturer: `${tag}Motors`,
    model: `${tag}Dash`,
  });
  const list = async (query) =>
    (await adminApi("GET", `/vehicles/fleet-manager?${new URLSearchParams({ limit: "100", ...query })}`)).json;
  const ids = (json) => json.data.map(({ _id }) => _id).sort();
  const both = [car._id, bike._id].sort();

  assert.deepEqual(ids(await list({ search: `${tag}MOTORS` })), both, "brand, case-insensitive");
  assert.deepEqual(ids(await list({ search: `${tag}dash` })), [bike._id], "model");
  assert.deepEqual(ids(await list({ search: tag, category: "bike" })), [bike._id]);
  assert.deepEqual(ids(await list({ search: tag, category: "car" })), [car._id]);
  assert.deepEqual(ids(await list({ search: tag, category: "all" })), both);

  await Vehicle.updateOne({ _id: car._id }, { $set: { status: "rent" } });
  const carsOnRent = await list({ search: tag, status: "rent", category: "car" });
  assert.deepEqual(ids(carsOnRent), [car._id]);
  assert.equal(carsOnRent.total, 1, "the count follows every filter");
  assert.equal((await list({ search: tag, status: "rent", category: "bike" })).total, 0);

  const deactivated = await adminApi("PATCH", `/vehicles/deactivate/${bike._id}`, {
    deactivationDate: dayFromToday(10),
    reason: REASON,
  });
  assert.equal(deactivated.status, 200, deactivated.json.message);
  assert.deepEqual(ids(await list({ search: tag, status: "deactivated", category: "bike" })), [bike._id]);
  assert.equal((await list({ search: tag, status: "deactivated", category: "car" })).total, 0);
  assert.equal((await list({ search: tag, status: "available", category: "bike" })).total, 0);

  assert.equal((await list({ category: "car|bike" })).total, 0, "the category is matched literally");
  assert.equal((await list({ category: ".*" })).total, 0);

  // The general vehicle list keeps its name / display name / number search.
  assert.equal((await adminApi("GET", `/vehicles/all?search=${tag}dash`)).json.total, 0);
});

test("the Deactivated list carries the audit details, and a reason is required", async () => {
  const { default: User } = await import("../src/models/user.model.js");
  const adminName = (await User.findById(admin.user.id).lean()).fullName;
  const vehicle = await createCar();
  await Vehicle.updateOne({ _id: vehicle._id }, { $set: { status: "rent" } });

  for (const reason of [undefined, "   ", "r".repeat(501)]) {
    const refused = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, {
      deactivationDate: dayFromToday(5),
      reason,
    });
    assert.equal(refused.status, 400, String(reason).slice(0, 10));
    assert.ok(refused.json.fieldErrors.reason);
  }
  assert.equal((await Vehicle.findById(vehicle._id).lean()).deactivation.date, null);

  const saved = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, {
    deactivationDate: dayFromToday(5),
    reason: "long_term_maintenance",
    notes: "  Engine seized  ",
  });
  assert.equal(saved.status, 200, saved.json.message);
  assert.equal(saved.json.data.deactivation.reason, "long_term_maintenance");
  assert.equal(saved.json.data.deactivation.notes, "Engine seized");
  assert.equal(saved.json.data.deactivation.previousStatus, "rent", "status at the moment of deactivation");
  assert.equal(saved.json.data.deactivation.deactivatedBy.fullName, adminName);

  const number = encodeURIComponent(vehicle.vehicleNumber);
  const listed = await adminApi("GET", `/vehicles/fleet-manager?status=deactivated&search=${number}`);
  const item = listed.json.data[0];
  assert.equal(item.deactivation.reason, "long_term_maintenance");
  assert.equal(item.deactivation.notes, "Engine seized");
  assert.equal(item.deactivation.previousStatus, "rent");
  assert.ok(item.deactivation.deactivatedAt);
  assert.equal(item.deactivation.deactivatedBy.fullName, adminName);
  assert.equal(item.createdBy.fullName, adminName);
  assert.ok(item.createdAt && item.updatedAt);
  assert.equal(item.deactivation.deactivatedBy.password, undefined, "only the name is exposed");

  const other = await adminApi("GET", `/vehicles/fleet-manager?search=${number}`);
  assert.equal(other.json.data[0].createdBy, undefined, "other views stay as light as before");
});

test("deactivation takes a listed reason, needs notes for Other, and records its own audit data", async () => {
  const vehicle = await createCar();
  const url = `/vehicles/deactivate/${vehicle._id}`;
  const date = dayFromToday(6);
  const refusals = [
    [{ reason: "Sold to a dealer" }, "reason"],
    [{ reason: "other" }, "notes"],
    [{ reason: "other", notes: "   " }, "notes"],
    [{ reason: "vehicle_sold", notes: "n".repeat(501) }, "notes"],
  ];
  for (const [body, field] of refusals) {
    const refused = await adminApi("PATCH", url, { deactivationDate: date, ...body });
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 40));
    assert.ok(refused.json.fieldErrors[field], field);
  }

  const forged = new mongoose.Types.ObjectId().toString();
  const before = Date.now();
  const saved = await adminApi("PATCH", url, {
    deactivationDate: date,
    reason: "other",
    notes: "  Returned to the owner's family  ",
    // Audit fields are never taken from the request.
    deactivatedBy: forged,
    deactivatedAt: "2020-01-01T00:00:00.000Z",
    previousStatus: "service",
    deactivation: { deactivatedBy: forged },
  });
  assert.equal(saved.status, 200, saved.json.message);
  const stored = (await Vehicle.findById(vehicle._id).lean()).deactivation;
  assert.equal(stored.reason, "other");
  assert.equal(stored.notes, "Returned to the owner's family");
  assert.equal(String(stored.deactivatedBy), admin.user.id);
  assert.ok(stored.deactivatedAt.getTime() >= before - 1000, "server time, not the client's");
  assert.equal(stored.previousStatus, "available");

  const edit = await adminApi("PUT", `/vehicles/update/${vehicle._id}`, {
    pricePerDay: 1999,
    deactivation: { date: null, deactivatedBy: forged, reason: "vehicle_sold" },
    createdBy: forged,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(edit.status, 200, edit.json.message);
  const afterEdit = await Vehicle.findById(vehicle._id).lean();
  assert.equal(afterEdit.pricePerDay, 1999);
  assert.equal(afterEdit.deactivation.date.toISOString().slice(0, 10), date, "Edit cannot touch deactivation");
  assert.equal(String(afterEdit.deactivation.deactivatedBy), admin.user.id);
  assert.equal(afterEdit.deactivation.reason, "other");
  assert.equal(String(afterEdit.createdBy), admin.user.id);
  assert.notEqual(afterEdit.createdAt.getFullYear(), 2020);
});

test("an overdue rental blocks deactivation until the vehicle is returned", async () => {
  const { default: Handover } = await import("../src/models/handover.model.js");
  const vehicle = await createCar();
  const rental = await Handover.collection.insertOne({
    isDeleted: false,
    handoverStatus: "active",
    bookingStatus: "active",
    customer: { fullName: "Late Return" },
    vehicle: { vehicleId: new mongoose.Types.ObjectId(vehicle._id) },
    trip: {
      pickupDateTime: new Date(`${dayFromToday(-4)}T04:30:00Z`),
      dropDateTime: new Date(`${dayFromToday(-1)}T04:30:00Z`),
    },
  });
  const body = { deactivationDate: dayFromToday(20), reason: "vehicle_sold" };
  const refused = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, body);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.conflicts[0].handoverId, String(rental.insertedId));
  assert.equal(refused.json.conflicts[0].overdue, true);

  await Handover.collection.updateOne({ _id: rental.insertedId }, { $set: { handoverStatus: "returned" } });
  const allowed = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, body);
  assert.equal(allowed.status, 200, "allowed once the vehicle is back");
});

const fleetCounts = async () => ({
  available: 0,
  rent: 0,
  service: 0,
  deactivated: 0,
  ...Object.fromEntries(
    (await adminApi("GET", "/vehicles/fleet-manager?limit=1")).json.stats.map(({ _id, count }) => [_id, count]),
  ),
});

test("reactivation returns a vehicle to Available, keeps its deactivation history, and never deletes it", async () => {
  const vehicle = await createCar();
  const url = (action) => `/vehicles/${action}/${vehicle._id}`;
  const notYet = await adminApi("GET", url("reactivation"));
  assert.equal(notYet.status, 409);
  assert.equal(notYet.json.code, "VEHICLE_NOT_DEACTIVATED");
  assert.equal((await adminApi("PATCH", url("reactivate"), { status: "available" })).status, 409);

  const deactivationDate = dayFromToday(3);
  const deactivated = await adminApi("PATCH", url("deactivate"), {
    deactivationDate,
    reason: "temporarily_unavailable",
    notes: "Off season",
  });
  assert.equal(deactivated.status, 200, deactivated.json.message);
  const before = await fleetCounts();

  const options = await adminApi("GET", url("reactivation"));
  assert.equal(options.status, 200, options.json.message);
  assert.deepEqual(options.json.data.statuses, ["available", "service"]);
  assert.equal(options.json.data.defaultStatus, "available");

  assert.equal((await adminApi("PATCH", url("reactivate"), { status: "sold" })).status, 400);
  const longReason = await adminApi("PATCH", url("reactivate"), { status: "available", reason: "r".repeat(501) });
  assert.equal(longReason.status, 400);
  assert.ok(longReason.json.fieldErrors.reason);

  const forged = new mongoose.Types.ObjectId().toString();
  const startedAt = Date.now();
  const reactivated = await adminApi("PATCH", url("reactivate"), {
    status: "available",
    reason: "  Season started  ",
    reactivatedBy: forged,
    reactivatedAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(reactivated.status, 200, reactivated.json.message);
  const data = reactivated.json.data;
  assert.equal(data.deactivation.date, null);
  assert.equal(data.status, "available");
  assert.equal(data.isDeleted, false, "the vehicle is never deleted");
  assert.equal(data.deactivationHistory.length, 1);
  const [record] = data.deactivationHistory;
  assert.equal(record.date.slice(0, 10), deactivationDate);
  assert.equal(record.reason, "temporarily_unavailable");
  assert.equal(record.notes, "Off season");
  assert.equal(String(record.deactivatedBy), admin.user.id);
  assert.equal(String(record.reactivatedBy), admin.user.id, "the signed-in user, not the request");
  assert.ok(new Date(record.reactivatedAt).getTime() >= startedAt - 1000, "server time");
  assert.equal(record.reactivationReason, "Season started");
  assert.equal(record.reactivatedStatus, "available");

  const after = await fleetCounts();
  assert.equal(after.deactivated, before.deactivated - 1);
  assert.equal(after.available, before.available + 1);
  const number = encodeURIComponent(vehicle.vehicleNumber);
  assert.equal(
    (await adminApi("GET", `/vehicles/fleet-manager?status=deactivated&search=${number}`)).json.total,
    0,
    "it leaves the Deactivated list",
  );

  const booking = await adminApi(
    "POST",
    "/leads/create",
    bookingPayload(vehicle._id, dayFromToday(5), dayFromToday(6), "9876509001"),
  );
  assert.equal(booking.status, 201, "bookable again past the old date");

  const second = await adminApi("PATCH", url("deactivate"), {
    deactivationDate: dayFromToday(10),
    reason: "vehicle_sold",
  });
  assert.equal(second.status, 200, second.json.message);
  const again = await adminApi("PATCH", url("reactivate"), { status: "service" });
  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.data.status, "service");
  assert.deepEqual(
    again.json.data.deactivationHistory.map(({ reason, reactivatedStatus }) => [reason, reactivatedStatus]),
    [
      ["temporarily_unavailable", "available"],
      ["vehicle_sold", "service"],
    ],
    "every cycle is kept",
  );
});

test("reactivation keeps a rented vehicle On Rent and one under maintenance Under Service", async () => {
  const { default: Handover } = await import("../src/models/handover.model.js");
  const { default: Maintenance } = await import("../src/models/maintenance.model.js");
  const deactivate = async (vehicle) => {
    const response = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, {
      deactivationDate: dayFromToday(10),
      reason: "temporarily_unavailable",
    });
    assert.equal(response.status, 200, response.json.message);
  };

  const rented = await createCar();
  await deactivate(rented);
  await Handover.collection.insertOne({
    isDeleted: false,
    handoverStatus: "active",
    bookingStatus: "active",
    customer: { fullName: "Still Out" },
    vehicle: { vehicleId: new mongoose.Types.ObjectId(rented._id) },
    trip: {
      pickupDateTime: new Date(`${dayFromToday(0)}T04:30:00Z`),
      dropDateTime: new Date(`${dayFromToday(2)}T04:30:00Z`),
    },
  });
  await Vehicle.updateOne({ _id: rented._id }, { $set: { status: "rent" } });
  const rentedOptions = (await adminApi("GET", `/vehicles/reactivation/${rented._id}`)).json.data;
  assert.deepEqual(rentedOptions.statuses, ["rent"]);
  assert.equal(rentedOptions.rental.customerName, "Still Out");
  const refused = await adminApi("PATCH", `/vehicles/reactivate/${rented._id}`, { status: "available" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "REACTIVATION_STATUS_NOT_ALLOWED");
  assert.ok(refused.json.fieldErrors.status);
  const keptOnRent = await adminApi("PATCH", `/vehicles/reactivate/${rented._id}`, { status: "rent" });
  assert.equal(keptOnRent.status, 200, keptOnRent.json.message);
  assert.equal(keptOnRent.json.data.status, "rent");

  const serviced = await createCar();
  await deactivate(serviced);
  await Maintenance.collection.insertOne({
    vehicle: new mongoose.Types.ObjectId(serviced._id),
    isDeleted: false,
    status: "In Progress",
    title: "Engine overhaul",
    startDate: new Date(`${dayFromToday(-1)}T04:30:00Z`),
    endDate: new Date(`${dayFromToday(3)}T04:30:00Z`),
  });
  const serviceOptions = (await adminApi("GET", `/vehicles/reactivation/${serviced._id}`)).json.data;
  assert.deepEqual(serviceOptions.statuses, ["service"]);
  assert.equal(serviceOptions.defaultStatus, "service");
  assert.equal(serviceOptions.maintenance.title, "Engine overhaul");
  assert.equal(
    (await adminApi("PATCH", `/vehicles/reactivate/${serviced._id}`, { status: "available" })).status,
    400,
  );
  const underService = await adminApi("PATCH", `/vehicles/reactivate/${serviced._id}`, { status: "service" });
  assert.equal(underService.status, 200, underService.json.message);
  assert.equal(underService.json.data.status, "service");
});

test("reactivation needs the Deactivate permission", async () => {
  const vehicle = await createCar();
  const deactivated = await adminApi("PATCH", `/vehicles/deactivate/${vehicle._id}`, {
    deactivationDate: dayFromToday(4),
    reason: "vehicle_sold",
  });
  assert.equal(deactivated.status, 200, deactivated.json.message);
  const staff = await createUserAndLogin(ctx.base, {
    role: "FLEET_MANAGER",
    businessName: admin.user.businessName,
  });
  const staffApi = client(ctx.base, staff.token);
  const policy = (permissions) =>
    adminApi("PUT", "/auth/roles/FLEET_MANAGER/permissions", { permissions });

  assert.equal((await policy({ "page.vehicleManager.view": true, "page.dashboard.edit": true })).status, 200);
  assert.equal((await staffApi("GET", `/vehicles/reactivation/${vehicle._id}`)).status, 403);
  assert.equal(
    (await staffApi("PATCH", `/vehicles/reactivate/${vehicle._id}`, { status: "available" })).status,
    403,
  );

  assert.equal((await policy({ "page.dashboard.deactivate": true })).status, 200);
  assert.equal((await staffApi("GET", `/vehicles/reactivation/${vehicle._id}`)).status, 200);
  const done = await staffApi("PATCH", `/vehicles/reactivate/${vehicle._id}`, { status: "available" });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(String(done.json.data.deactivationHistory[0].reactivatedBy), staff.user.id);
});
