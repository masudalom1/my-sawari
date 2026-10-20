// Cloudinary and WATI behaviour, with both services mocked.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, jpegBlob } from "./helpers/harness.mjs";

let ctx;
let api;
let models;

before(async () => {
  ctx = await startTestApp();
  const { token } = await createUserAndLogin(ctx.base);
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

test("vehicle images keep their Cloudinary publicId (was saved as public_id and dropped)", async () => {
  const form = new FormData();
  form.append("vehicleName", "Innova");
  form.append("vehicleNumber", "KA05XY0001");
  form.append("manufacturer", "Toyota");
  form.append("fuelType", "Diesel");
  form.append("transmission", "Manual");
  form.append("seatingCapacity", "7");
  form.append("images", jpegBlob(), "front.jpg");

  const res = await api("POST", "/vehicles/create", form);
  assert.equal(res.status, 201, res.json.message);
  assert.equal(res.json.data.images.length, 1);
  assert.match(res.json.data.images[0].url, /^https:\/\/res\.cloudinary\.com\//);
  assert.ok(res.json.data.images[0].publicId, "publicId must be stored");
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
