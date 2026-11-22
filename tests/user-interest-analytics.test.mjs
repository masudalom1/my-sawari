import { test } from "node:test";
import assert from "node:assert/strict";
import Customer from "../src/models/customer.model.js";
import CustomerActivity from "../src/models/customerActivity.model.js";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("user interest analytics counts India-day view_car events and supports vehicle, user, sorting, and paging filters", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const staff = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const api = client(ctx.base, admin.token);
  const staffApi = client(ctx.base, staff.token);
  assert.equal((await staffApi("GET", "/leads/app-installs/analytics")).status, 403);

  const [first, second] = await Customer.create([
    { customerName: "Asha Viewer", mobileNumber: "9876500001" },
    { customerName: "Bala Viewer", mobileNumber: "9876500002" },
  ]);
  const unavailable = await api(
    "GET",
    "/leads/app-installs/analytics?from=2026-03-02&to=2026-03-02",
  );
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.json.data.availability, {
    status: "unavailable",
    reason: "customer_activity_collection_missing",
  });
  assert.equal(unavailable.json.data.overview, null);

  const redVehicleId = new ctx.mongoose.Types.ObjectId();
  const blueVehicleId = new ctx.mongoose.Types.ObjectId();
  const Vehicle = (await import("../src/models/vehicle.model.js")).default;
  await Vehicle.collection.insertMany([
    {
      _id: redVehicleId,
      vehicleName: "Xoom Red",
      displayName: "Xoom Red",
      isDeleted: false,
    },
    {
      _id: blueVehicleId,
      vehicleName: "City Blue",
      displayName: "City Blue",
      isDeleted: false,
    },
  ]);

  const indiaMidnight = Date.parse("2026-03-01T18:30:00.000Z");
  const event = (customer, offsetMs, action, carName, vehicleId) => ({
    customerId: customer._id,
    mobileNumber: customer.mobileNumber,
    action,
    details: {
      carName,
      ...(vehicleId ? { vehicleId } : {}),
    },
    createdAt: new Date(indiaMidnight + offsetMs),
    updatedAt: new Date(indiaMidnight + offsetMs),
  });
  await CustomerActivity.collection.insertMany([
    event(first, -1, "view_car", "Xoom Red", redVehicleId),
    event(first, 0, "view_car", "Xoom Red", redVehicleId),
    event(first, 1000, "view_car", "Xoom Red", null),
    event(first, 60_000, "view_car", "City Blue", blueVehicleId),
    event(first, 90_000, "view_car", "Xoom Red", blueVehicleId),
    event(first, 100_000, "view_car", "Xoom Red", redVehicleId),
    event(second, 120_000, "view_car", "Xoom Red", redVehicleId),
    event(first, 24 * 60 * 60 * 1000, "view_car", "City Blue", blueVehicleId),
    event(first, 180_000, "view_screen", "Xoom Red", redVehicleId),
  ]);

  const path = "/leads/app-installs/analytics?from=2026-03-02&to=2026-03-02";
  const firstPage = await api("GET", `${path}&page=1&limit=1`);
  assert.equal(firstPage.status, 200);
  const { data } = firstPage.json;
  assert.deepEqual(data.period, {
    from: "2026-03-02",
    to: "2026-03-02",
    timeZone: "Asia/Kolkata",
  });
  assert.deepEqual(
    {
      activeUsers: data.overview.activeUsers,
      uniqueVehicleViewers: data.overview.uniqueVehicleViewers,
      totalViews: data.overview.totalViews,
      uniqueVehicles: data.overview.uniqueVehicles,
      repeatViewers: data.overview.repeatViewers,
    },
    {
      activeUsers: 2,
      uniqueVehicleViewers: 2,
      totalViews: 6,
      uniqueVehicles: 2,
      repeatViewers: 1,
    },
  );
  assert.equal(data.overview.mostViewedVehicle.id, String(redVehicleId));
  assert.equal(data.overview.mostViewedVehicle.totalViews, 4);
  assert.equal(data.leaderboard.total, 2);
  assert.equal(data.leaderboard.data[0].name, "Asha Viewer");
  assert.equal(data.leaderboard.data[0].totalViews, 5);
  assert.equal(data.leaderboard.data[0].uniqueVehicles, 2);
  assert.equal(data.leaderboard.data[0].mostViewedVehicle.name, "Xoom Red");
  assert.equal(data.leaderboard.data[0].rank, 1);
  assert.equal(data.leaderboard.totalPages, 2);

  const secondPage = await api("GET", `${path}&page=2&limit=1`);
  assert.equal(secondPage.json.data.leaderboard.data[0].name, "Bala Viewer");
  assert.equal(secondPage.json.data.leaderboard.data[0].rank, 2);

  const latest = await api("GET", `${path}&sortBy=lastActivity`);
  assert.equal(latest.json.data.leaderboard.data[0].name, "Bala Viewer");
  const searched = await api("GET", `${path}&search=9876500001`);
  assert.deepEqual(
    searched.json.data.leaderboard.data.map(({ name }) => name),
    ["Asha Viewer"],
  );

  const vehicle = await api(
    "GET",
    `${path}&vehicleId=${redVehicleId.toString()}`,
  );
  assert.equal(vehicle.status, 200);
  assert.equal(vehicle.json.data.overview.totalViews, 6);
  assert.equal(vehicle.json.data.selectedVehicle.metrics.totalViews, 4);
  assert.equal(vehicle.json.data.selectedVehicle.metrics.uniqueViewers, 2);
  assert.equal(vehicle.json.data.selectedVehicle.metrics.repeatViewers, 1);
  assert.equal(vehicle.json.data.selectedVehicle.leaderboard[0].name, "Asha Viewer");
  assert.equal(vehicle.json.data.selectedVehicle.leaderboard[0].totalViews, 3);
  assert.deepEqual(vehicle.json.data.selectedVehicle.trend, [
    { date: "2026-03-02", views: 4 },
  ]);
  assert.equal(
    vehicle.json.data.mostViewedVehicles.find(({ id }) => id === String(redVehicleId))
      .uniqueViewers,
    2,
  );

  assert.equal(
    (await api("GET", "/leads/app-installs/analytics?from=2026-02-30&to=2026-03-02")).status,
    400,
  );
  assert.equal(
    (await api("GET", "/leads/app-installs/analytics?from=2026-03-03&to=2026-03-02")).status,
    400,
  );
});
