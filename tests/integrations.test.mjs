// Cloudinary and WATI behaviour, with both services mocked.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, jpegBlob } from "./helpers/harness.mjs";

let ctx;
let api;
let models;
let authenticatedUserId;

before(async () => {
  ctx = await startTestApp();
  const { token, user } = await createUserAndLogin(ctx.base);
  authenticatedUserId = user.id;
  api = client(ctx.base, token);
  models = {
    Vehicle: (await import("../src/models/vehicle.model.js")).default,
    Handover: (await import("../src/models/handover.model.js")).default,
    VehicleReturn: (await import("../src/models/vehicleReturn.model.js")).default,
  };
});

after(async () => {
  await ctx?.stop();
});

test("car and bike form fields and photos persist and the available car is bookable", async () => {
  const form = new FormData();
  form.append("vehicleName", "Innova");
  form.append("vehicleNumber", "KA05XY0001");
  form.append("manufacturer", "Toyota");
  form.append("displayName", "Airport Innova");
  form.append("category", "CAR");
  form.append("modelYear", "2023");
  form.append("pricePerDay", "2500");
  form.append("vehicleType", "SUV");
  form.append("fuelType", "Diesel");
  form.append("transmission", "Manual");
  form.append("seatingCapacity", "7");
  form.append("images", jpegBlob(), "front.jpg");

  const res = await api("POST", "/vehicles/create", form);
  assert.equal(res.status, 201, res.json.message);
  assert.equal(res.json.data.images.length, 1);
  assert.match(res.json.data.images[0].url, /^https:\/\/res\.cloudinary\.com\//);
  assert.ok(res.json.data.images[0].publicId, "publicId must be stored");
  assert.equal(res.json.data.displayName, "Airport Innova");
  assert.equal(res.json.data.category, "car");
  assert.equal(res.json.data.modelYear, 2023);
  assert.equal(res.json.data.pricePerDay, 2500);
  assert.equal(res.json.data.vehicleType, "SUV");
  assert.equal(res.json.data.status, "available");
  assert.equal(String(res.json.data.company), authenticatedUserId);
  assert.equal(String(res.json.data.createdBy), authenticatedUserId);

  const carRead = await api("GET", `/vehicles/${res.json.data._id}`);
  assert.equal(carRead.status, 200);
  assert.equal(carRead.json.data.category, "car");
  assert.equal(carRead.json.data.displayName, "Airport Innova");
  assert.equal(carRead.json.data.modelYear, 2023);
  assert.equal(carRead.json.data.pricePerDay, 2500);
  assert.equal(carRead.json.data.vehicleType, "SUV");
  assert.equal(carRead.json.data.images[0].url, res.json.data.images[0].url);
  assert.equal(carRead.json.data.images[0].publicId, res.json.data.images[0].publicId);

  const bookingChoices = await api("GET", "/bookings/vehicles");
  assert.equal(bookingChoices.status, 200);
  const bookingChoice = bookingChoices.json.vehicles.find(
    (vehicle) => vehicle._id === res.json.data._id,
  );
  assert.ok(bookingChoice, "new vehicle appears in the New Booking picker");
  assert.equal(bookingChoice.status, "available");

  const fleetList = await api(
    "GET",
    "/vehicles/all?search=Airport%20Innova&status=available&category=car",
  );
  assert.equal(fleetList.status, 200);
  assert.equal(fleetList.json.total, 1);
  assert.equal(fleetList.json.data[0].displayName, "Airport Innova");
  assert.equal(fleetList.json.data[0].vehicleNumber, "KA05XY0001");

  const bike = new FormData();
  bike.append("vehicleName", "Vespa");
  bike.append("vehicleNumber", "KA05BI0001");
  bike.append("manufacturer", "Piaggio");
  bike.append("displayName", "City Scooter");
  bike.append("category", "BIKE");
  bike.append("modelYear", "2021");
  bike.append("pricePerDay", "750");
  bike.append("fuelType", "Petrol");
  bike.append("transmission", "Automatic");
  bike.append("seatingCapacity", "2");
  bike.append("images", jpegBlob(), "scooter.jpg");
  const bikeCreated = await api("POST", "/vehicles/create", bike);
  assert.equal(bikeCreated.status, 201, bikeCreated.json.message);
  const bikeRead = await api("GET", `/vehicles/${bikeCreated.json.data._id}`);
  assert.equal(bikeRead.status, 200);
  assert.equal(bikeRead.json.data.category, "bike");
  assert.equal(bikeRead.json.data.displayName, "City Scooter");
  assert.equal(bikeRead.json.data.modelYear, 2021);
  assert.equal(bikeRead.json.data.pricePerDay, 750);
  assert.equal(bikeRead.json.data.vehicleType, undefined);
  assert.equal(bikeRead.json.data.images[0].publicId, bikeCreated.json.data.images[0].publicId);

  const allFirstPage = await api("GET", "/vehicles/all?page=1&limit=1");
  const allSecondPage = await api("GET", "/vehicles/all?page=2&limit=1");
  assert.equal(allFirstPage.status, 200);
  assert.equal(allFirstPage.json.total, 2);
  assert.equal(allFirstPage.json.hasMore, true);
  assert.equal(allSecondPage.json.total, 2);
  assert.equal(allSecondPage.json.hasMore, false);
  assert.deepEqual(
    new Set([
      allFirstPage.json.data[0]._id,
      allSecondPage.json.data[0]._id,
    ]),
    new Set([res.json.data._id, bikeCreated.json.data._id]),
  );

  const combinedFilter = await api(
    "GET",
    "/vehicles/all?search=City%20Scooter&status=available&limit=1",
  );
  assert.equal(combinedFilter.status, 200);
  assert.equal(combinedFilter.json.total, 1);
  assert.equal(combinedFilter.json.data[0]._id, bikeCreated.json.data._id);

  await models.Vehicle.updateOne(
    { _id: bikeCreated.json.data._id },
    { $set: { isDeleted: true, deletedAt: new Date() } },
  );
  const visibleVehicles = await api("GET", "/vehicles/all?status=All&limit=100");
  assert.equal(visibleVehicles.status, 200);
  assert.equal(visibleVehicles.json.total, 1);
  assert.equal(visibleVehicles.json.data[0]._id, res.json.data._id);
  assert.equal(
    visibleVehicles.json.stats.reduce((total, item) => total + item.count, 0),
    1,
  );

  const uploadCount = ctx.cloudinary.uploadedPublicIds.length;
  const duplicate = new FormData();
  duplicate.append("vehicleName", "Duplicate Innova");
  duplicate.append("vehicleNumber", " ka05xy0001 ");
  duplicate.append("manufacturer", "Toyota");
  duplicate.append("category", "car");
  duplicate.append("vehicleType", "SUV");
  duplicate.append("fuelType", "Diesel");
  duplicate.append("transmission", "Manual");
  duplicate.append("seatingCapacity", "7");
  duplicate.append("images", jpegBlob(), "duplicate.jpg");
  const duplicateResponse = await api("POST", "/vehicles/create", duplicate);
  assert.equal(duplicateResponse.status, 400);
  assert.ok(duplicateResponse.json.fieldErrors.vehicleNumber);
  assert.ok(
    ctx.cloudinary.destroyed.includes(
      ctx.cloudinary.uploadedPublicIds[uploadCount],
    ),
    "uploaded image is deleted when vehicle creation fails",
  );
});

test("vehicle uploads reject invalid images and more than five photos", async () => {
  const required = new FormData();
  required.append("vehicleName", "Invalid upload fixture");
  required.append("vehicleNumber", "KA05UP0001");
  required.append("manufacturer", "Test");
  required.append("category", "bike");
  required.append("fuelType", "Petrol");
  required.append("transmission", "Manual");
  required.append("seatingCapacity", "2");
  const uploadsBefore = ctx.cloudinary.uploads;

  const invalidImage = new FormData();
  for (const [key, value] of required.entries()) invalidImage.append(key, value);
  invalidImage.append("images", new Blob(["not an image"], { type: "text/plain" }), "notes.txt");
  const invalidResponse = await api("POST", "/vehicles/create", invalidImage);
  assert.equal(invalidResponse.status, 400);
  assert.equal(ctx.cloudinary.uploads, uploadsBefore);

  const tooManyImages = new FormData();
  for (const [key, value] of required.entries()) tooManyImages.append(key, value);
  for (let index = 0; index < 6; index += 1) {
    tooManyImages.append("images", jpegBlob(), `bike-${index}.jpg`);
  }
  const tooManyResponse = await api("POST", "/vehicles/create", tooManyImages);
  assert.equal(tooManyResponse.status, 400);
  assert.equal(
    await models.Vehicle.countDocuments({ vehicleNumber: "KA05UP0001" }),
    0,
  );
});

test("a failed vehicle save cleans up its photo and permits retry", async () => {
  const failed = new FormData();
  failed.append("vehicleName", "Retry fixture");
  failed.append("vehicleNumber", "KA05RT0001");
  failed.append("manufacturer", "Test");
  failed.append("category", "bike");
  failed.append("fuelType", "Petrol");
  failed.append("transmission", "Manual");
  failed.append("seatingCapacity", "2");
  failed.append("registrationDate", "2026-02-31");
  failed.append("images", jpegBlob(), "retry.jpg");

  const uploadedIndex = ctx.cloudinary.uploadedPublicIds.length;
  const failedResponse = await api("POST", "/vehicles/create", failed);
  assert.equal(failedResponse.status, 400);
  assert.ok(failedResponse.json.fieldErrors.registrationDate);
  assert.ok(
    ctx.cloudinary.destroyed.includes(
      ctx.cloudinary.uploadedPublicIds[uploadedIndex],
    ),
  );

  failed.set("registrationDate", "2026-11-26");
  const retryResponse = await api("POST", "/vehicles/create", failed);
  assert.equal(retryResponse.status, 201, retryResponse.json.message);
  const saved = await api("GET", `/vehicles/${retryResponse.json.data._id}`);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.data.vehicleNumber, "KA05RT0001");
});

test("vehicle create requires the Create permission before uploading photos", async () => {
  const { token, email } = await createUserAndLogin(ctx.base, {
    role: "FLEET_MANAGER",
    businessName: "Restricted Fleet",
  });
  const { default: RolePermission } = await import("../src/models/rolePermission.model.js");
  const { default: User } = await import("../src/models/user.model.js");
  const permissionActor = await User.findOne({ email }).select("_id");
  await RolePermission.create({
    businessName: "Restricted Fleet",
    role: "FLEET_MANAGER",
    updatedBy: permissionActor._id,
    permissions: {
      "page.dashboard.view": true,
      "page.dashboard.create": false,
    },
  });

  const deniedForm = new FormData();
  deniedForm.append("vehicleName", "Denied upload");
  deniedForm.append("vehicleNumber", "KA05NO0001");
  deniedForm.append("manufacturer", "Test");
  deniedForm.append("category", "bike");
  deniedForm.append("fuelType", "Petrol");
  deniedForm.append("transmission", "Manual");
  deniedForm.append("seatingCapacity", "2");
  deniedForm.append("images", jpegBlob(), "denied.jpg");
  const uploadsBefore = ctx.cloudinary.uploads;
  const denied = await client(ctx.base, token)("POST", "/vehicles/create", deniedForm);
  assert.equal(denied.status, 403);
  assert.equal(ctx.cloudinary.uploads, uploadsBefore);
});

test("vehicle create validates numeric, enum, date, and text limits as field errors", async () => {
  const valid = {
    vehicleName: "Validation fixture",
    manufacturer: "Test",
    category: "bike",
    fuelType: "Petrol",
    transmission: "Manual",
    seatingCapacity: 2,
  };
  const invalidCases = [
    [{ vehicleName: "" }, "vehicleName"],
    [{ vehicleNumber: "" }, "vehicleNumber"],
    [{ manufacturer: "" }, "manufacturer"],
    [{ category: "" }, "category"],
    [{ fuelType: "" }, "fuelType"],
    [{ transmission: "" }, "transmission"],
    [{ seatingCapacity: "" }, "seatingCapacity"],
    [{ category: "car", vehicleType: "" }, "vehicleType"],
    [{ seatingCapacity: "2.5" }, "seatingCapacity"],
    [{ pricePerDay: "-1" }, "pricePerDay"],
    [{ modelYear: "2023.5" }, "modelYear"],
    [{ category: "truck" }, "category"],
    [{ fuelType: "Gasoline" }, "fuelType"],
    [{ transmission: "CVT" }, "transmission"],
    [{ registrationDate: "2026-02-31" }, "registrationDate"],
    [{ displayName: "d".repeat(101) }, "displayName"],
    [{ notes: "n".repeat(501) }, "notes"],
  ];

  for (const [index, [invalid, field]] of invalidCases.entries()) {
    const payload = {
      ...valid,
      ...invalid,
      vehicleNumber: `KA05XV${String(index).padStart(4, "0")}`,
    };
    if (Object.hasOwn(invalid, "vehicleNumber")) {
      payload.vehicleNumber = invalid.vehicleNumber;
    }
    const response = await api("POST", "/vehicles/create", {
      ...payload,
    });
    assert.equal(response.status, 400, field);
    assert.ok(response.json.fieldErrors[field], field);
  }
});

test("new vehicles cannot bypass booking or maintenance status flows", async () => {
  const res = await api("POST", "/vehicles/create", {
    vehicleName: "Invalid status fixture",
    vehicleNumber: "KA05XY0003",
    manufacturer: "Test",
    fuelType: "Petrol",
    transmission: "Manual",
    seatingCapacity: 5,
    status: "rent",
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.success, false);
  assert.ok(res.json.fieldErrors.status);
  assert.equal(await models.Vehicle.countDocuments({ vehicleNumber: "KA05XY0003" }), 0);
});

test("a failed Cloudinary upload is reported as a failure and leaves no return record", async () => {
  const { default: User } = await import("../src/models/user.model.js");
  const owner = await User.findOne().lean();
  const vehicle = await models.Vehicle.create({
    company: owner._id,
    createdBy: owner._id,
    vehicleName: "Creta",
    vehicleNumber: "KA05XY0002",
    manufacturer: "Hyundai",
    fuelType: "Petrol",
    transmission: "Automatic",
    seatingCapacity: 5,
    status: "rent",
  });
  const handover = await models.Handover.create({
    company: owner._id,
    createdBy: owner._id,
    customer: { fullName: "Upload Test", mobileNumber: "9876522222", destination: "Mysore" },
    identity: { aadhaarNumber: "111122223333", drivingLicenseNumber: "KA0520200002" },
    vehicle: { vehicleId: vehicle._id, vehicleName: "Creta", vehicleNumber: "KA05XY0002" },
    trip: { pickupDateTime: new Date(), dropDateTime: new Date(Date.now() + 86400000), numberOfDays: 1 },
    payment: {
      fuelLevel: 7,
      totalFare: 1000,
      totalAmount: 1000,
      amountReceivedNow: 1000,
      balanceAmount: 0,
      paymentMethod: "cash",
    },
  });

  const form = new FormData();
  form.append("fuelLevel", "7");
  form.append("kilometersAtReturn", "100");
  for (const side of ["vehicleFront", "vehicleRear", "vehicleLeft", "vehicleRight"]) {
    form.append(side, jpegBlob(), `${side}.jpg`);
  }

  ctx.cloudinary.fail = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await api("POST", `/vehicle-return/receive/${handover._id}`, form);
    assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
    assert.equal(res.json.success, false);

    const single = new FormData();
    single.append("image", jpegBlob(), "one.jpg");
    const image = await api("POST", "/handover/image", single);
    assert.ok(image.status >= 400);
    assert.equal(image.json.success, false);
  } finally {
    ctx.cloudinary.fail = false;
    console.error = originalError;
  }

  assert.equal(await models.VehicleReturn.countDocuments({ handover: handover._id }), 0);
  assert.equal((await models.Vehicle.findById(vehicle._id).lean()).status, "rent");
  assert.equal((await models.Handover.findById(handover._id).lean()).handoverStatus, "active");
});

test("multer rejects non-image uploads with 400", async () => {
  const form = new FormData();
  form.append("image", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
  const res = await api("POST", "/handover/image", form);
  assert.equal(res.status, 400);
  assert.equal(res.json.success, false);
});

test("WATI: provider rejection (HTTP 200, result:false) is not reported as success", async () => {
  const { default: axios } = await import("axios");
  const { sendBookingCreatedMessage, sendBookingConfirmation } = await import("../src/services/wati.service.js");

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  const originalPost = axios.post;
  try {
    axios.post = async () => ({ data: { result: false, info: "Invalid WhatsApp number" } });
    const created = await sendBookingCreatedMessage("9876533333");
    assert.deepEqual(created, { success: false, error: "Invalid WhatsApp number" });

    axios.post = async () => ({ data: { result: true, id: "msg-1" } });
    const confirmed = await sendBookingConfirmation({
      customer: { fullName: "A", mobileNumber: "9876533333" },
      vehicle: { vehicleName: "Swift" },
      trip: { pickupDateTime: new Date(), dropDateTime: new Date() },
      payment: { totalAmount: 1000 },
    });
    assert.equal(confirmed.success, true);
  } finally {
    axios.post = originalPost;
    console.log = originalLog;
  }

  assert.ok(!logs.join("\n").includes("9876533333"), "full phone number must not be logged");
  assert.ok(logs.join("\n").includes("******3333"));
});

test("WATI: network failure and timeout resolve to success:false instead of throwing", async () => {
  const { default: axios } = await import("axios");
  const { sendBookingCreatedMessage } = await import("../src/services/wati.service.js");
  const originalPost = axios.post;
  const originalLog = console.log;
  console.log = () => {};
  try {
    let seenConfig;
    axios.post = async (url, payload, config) => {
      seenConfig = config;
      const err = new Error("timeout of 15000ms exceeded");
      err.code = "ECONNABORTED";
      throw err;
    };
    const result = await sendBookingCreatedMessage("9876544444");
    assert.equal(result.success, false);
    assert.equal(seenConfig.timeout, 15000);
  } finally {
    axios.post = originalPost;
    console.log = originalLog;
  }
});
