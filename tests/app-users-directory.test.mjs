import { test } from "node:test";
import assert from "node:assert/strict";
import Booking from "../src/models/booking.model.js";
import Customer from "../src/models/customer.model.js";
import CustomerActivity from "../src/models/customerActivity.model.js";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("App Users directory is permission-protected and supports literal search and stable pagination", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const superAdmin = await createUserAndLogin(ctx.base);
  const staff = await createUserAndLogin(ctx.base, {
    role: "BOOKING_EXECUTIVE",
  });
  const superAdminApi = client(ctx.base, superAdmin.token);
  const staffApi = client(ctx.base, staff.token);
  const path = "/leads/app-installs";
  const permissionKey = "page.appUsers.view";

  const denied = await staffApi("GET", path);
  assert.equal(denied.status, 403);
  assert.equal(
    (await staffApi("GET", `${path}/000000000000000000000000`)).status,
    403,
  );

  const timestamp = new Date("2026-02-01T12:00:00.000Z");
  await Customer.create([
    {
      customerName: "A.* Literal",
      mobileNumber: "9876500001",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      customerName: "Newest",
      mobileNumber: "9876500002",
      status: "active",
      createdAt: new Date(timestamp.getTime() + 1000),
      updatedAt: new Date(timestamp.getTime() + 1000),
    },
    {
      customerName: "No Booking Customer",
      mobileNumber: "9876500003",
      status: "inactive",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]);
  await Booking.collection.insertOne({
    customerName: "A.* Literal",
    mobileNumber: "9876500001",
  });

  const superAdminFetch = await superAdminApi("GET", path);
  assert.equal(superAdminFetch.status, 200);
  assert.equal(superAdminFetch.json.success, true);
  assert.equal(superAdminFetch.json.page, 1);
  assert.equal(superAdminFetch.json.total, 3);
  assert.equal(superAdminFetch.json.data.length, 3);
  assert.equal(superAdminFetch.json.hasMore, false);
  assert.deepEqual(
    Object.keys(superAdminFetch.json.data[0]).sort(),
    ["id", "joinedAt", "mobile", "name", "status"].sort(),
  );
  assert.equal(
    superAdminFetch.json.data.some(
      ({ name }) => name === "No Booking Customer",
    ),
    true,
  );
  const listedProfile = superAdminFetch.json.data.find(
    ({ name }) => name === "A.* Literal",
  );
  assert.ok(listedProfile);

  const malformedDetail = await superAdminApi(
    "GET",
    `${path}/not-an-object-id`,
  );
  assert.equal(malformedDetail.status, 400);
  const missingDetail = await superAdminApi(
    "GET",
    `${path}/000000000000000000000000`,
  );
  assert.equal(missingDetail.status, 404);

  const grant = await superAdminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    { permissions: { [permissionKey]: true } },
  );
  assert.equal(grant.status, 200);

  const detail = await staffApi("GET", `${path}/${listedProfile.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.success, true);
  for (const [key, value] of Object.entries(listedProfile)) {
    assert.deepEqual(detail.json.data[key], value);
  }
  assert.equal(detail.json.data.email, null);
  assert.equal(detail.json.data.walletBalance, null);
  assert.equal(detail.json.data.lastActiveAt, null);
  assert.deepEqual(detail.json.data.bookings.availability, {
    status: "denied",
    reason: "booking_permission_required",
  });
  assert.equal(detail.json.data.bookings.history, null);
  assert.deepEqual(detail.json.data.sectionAvailability.profile, {
    status: "partial",
    unavailableFields: ["email", "walletBalance"],
  });
  assert.equal(detail.json.data.sectionAvailability.lastActiveAt.status, "unavailable");
  assert.deepEqual(detail.json.data.sectionAvailability.activity, {
    status: "unavailable",
    reason: "customer_activity_collection_missing",
  });
  assert.equal(detail.json.data.recommendation.text, null);
  assert.equal(detail.json.data.messageDraft.text, null);

  const bookingGrant = await superAdminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    {
      permissions: {
        [permissionKey]: true,
        "page.bookings.view": true,
      },
    },
  );
  assert.equal(bookingGrant.status, 200);
  const staffWithBookingAccess = await staffApi(
    "GET",
    `${path}/${listedProfile.id}`,
  );
  assert.equal(staffWithBookingAccess.status, 200);
  assert.equal(staffWithBookingAccess.json.data.bookings.availability.status, "empty");
  assert.deepEqual(staffWithBookingAccess.json.data.bookings.counts, {
    all: 0,
    completed: 0,
    ongoing: 0,
    cancelled: 0,
  });
  assert.deepEqual(staffWithBookingAccess.json.data.bookings.history.data, []);
  assert.equal(staffWithBookingAccess.json.data.bookings.scope, "caller_company");
  assert.equal(
    staffWithBookingAccess.json.data.segment.value.label,
    "No bookings in this company",
  );
  assert.match(
    staffWithBookingAccess.json.data.recommendation.text,
    /your company's booking scope/,
  );

  const superAdminDetail = await superAdminApi(
    "GET",
    `${path}/${listedProfile.id}`,
  );
  assert.equal(superAdminDetail.status, 200);
  assert.equal(superAdminDetail.json.data.bookings.availability.status, "empty");
  assert.deepEqual(superAdminDetail.json.data.bookings.counts, {
    all: 0,
    completed: 0,
    ongoing: 0,
    cancelled: 0,
  });

  const firstPage = await staffApi("GET", `${path}?page=1&limit=2`);
  assert.equal(firstPage.status, 200);
  assert.deepEqual(
    {
      success: firstPage.json.success,
      page: firstPage.json.page,
      total: firstPage.json.total,
      hasMore: firstPage.json.hasMore,
      dataLength: firstPage.json.data.length,
    },
    { success: true, page: 1, total: 3, hasMore: true, dataLength: 2 },
  );
  assert.equal(firstPage.json.data[0].name, "Newest");

  const secondPage = await staffApi("GET", `${path}?page=2&limit=2`);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.json.page, 2);
  assert.equal(secondPage.json.total, 3);
  assert.equal(secondPage.json.hasMore, false);
  assert.equal(secondPage.json.data.length, 1);
  assert.equal(secondPage.json.data[0].name, "A.* Literal");
  assert.notEqual(firstPage.json.data[0].id, secondPage.json.data[0].id);

  const literalSearch = await staffApi(
    "GET",
    `${path}?q=${encodeURIComponent("A.*")}`,
  );
  assert.equal(literalSearch.status, 200);
  assert.equal(literalSearch.json.total, 1);
  assert.equal(literalSearch.json.data[0].name, "A.* Literal");

  const mobileSearch = await staffApi("GET", `${path}?q=9876500003`);
  assert.equal(mobileSearch.status, 200);
  assert.equal(mobileSearch.json.total, 1);
  assert.equal(mobileSearch.json.data[0].mobile, "9876500003");
});

test("App User detail returns verified profile, scoped booking totals, and grouped customer activity", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const superAdmin = await createUserAndLogin(ctx.base);
  const api = client(ctx.base, superAdmin.token);
  const User = (await import("../src/models/user.model.js")).default;
  const owner = await User.findOne({ email: superAdmin.email }).select("_id").lean();
  const companyId = owner._id;
  const customer = await Customer.create({
    customerName: "Activity Test Customer",
    mobileNumber: "9876543210",
    email: "activity-customer@test.dev",
    walletBalance: 125,
    status: "active",
  });
  const otherCompanyId = new ctx.mongoose.Types.ObjectId();
  const baseTime = Date.now() - 10 * 60 * 1000;
  const event = (action, seconds, details = {}, screen = "TestScreen") => ({
    customerId: customer._id,
    mobileNumber: customer.mobileNumber,
    action,
    screen,
    details,
    createdAt: new Date(baseTime + seconds * 1000),
    updatedAt: new Date(baseTime + seconds * 1000),
  });

  await CustomerActivity.collection.insertMany([
    event("view_car", 0, { carName: "Test Sedan", pricePerDay: 1000 }),
    event("view_car", 30, { carName: "Test Sedan", pricePerDay: 1000 }),
    event("click_car", 90, { carName: "Test Sedan" }),
    event("view_screen", 100, { screen: "HomeScreen" }),
    event("sent_marketing_notif", 120, { title: "internal" }),
    {
      ...event("select_location", 140, { locationName: "Demo Location" }),
      customerId: undefined,
    },
  ]);
  await Booking.collection.insertMany([
    {
      company: companyId,
      mobileNumber: customer.mobileNumber,
      customerName: customer.customerName,
      status: "completed",
      isDeleted: false,
      payment: { totalAmount: 1000, bookingAmountPaid: 1000, balanceAmount: 0 },
      createdAt: new Date(baseTime),
    },
    {
      company: companyId,
      mobileNumber: customer.mobileNumber,
      customerName: customer.customerName,
      status: "active",
      isDeleted: false,
      payment: { totalAmount: 1200, bookingAmountPaid: 300, balanceAmount: 900 },
      createdAt: new Date(baseTime + 1000),
    },
    {
      company: companyId,
      mobileNumber: customer.mobileNumber,
      customerName: customer.customerName,
      status: "confirmed",
      isDeleted: false,
      payment: { totalAmount: 900, bookingAmountPaid: 100, balanceAmount: 800 },
      createdAt: new Date(baseTime + 2000),
    },
    {
      company: companyId,
      mobileNumber: customer.mobileNumber,
      customerName: customer.customerName,
      status: "cancelled",
      isDeleted: false,
      payment: { totalAmount: 500, bookingAmountPaid: 0, balanceAmount: 500 },
      createdAt: new Date(baseTime + 3000),
    },
    {
      company: companyId,
      mobileNumber: customer.mobileNumber,
      customerName: customer.customerName,
      status: "completed",
      isDeleted: true,
      payment: { totalAmount: 5000 },
      createdAt: new Date(baseTime + 4000),
    },
    {
      company: otherCompanyId,
      mobileNumber: customer.mobileNumber,
      customerName: customer.customerName,
      status: "active",
      isDeleted: false,
      payment: { totalAmount: 9000 },
      createdAt: new Date(baseTime + 5000),
    },
  ]);
  await Booking.collection.insertMany(Array.from({ length: 61 }, (_, index) => ({
    company: companyId,
    mobileNumber: customer.mobileNumber,
    customerName: customer.customerName,
    status: "confirmed",
    isDeleted: false,
    payment: { totalAmount: 10, bookingAmountPaid: 0, balanceAmount: 10 },
    createdAt: new Date(baseTime + (index + 10) * 1000),
  })));

  const response = await api(
    "GET",
    `/leads/app-installs/${customer._id}`,
  );
  assert.equal(response.status, 200);
  const { data } = response.json;
  assert.equal(data.email, "activity-customer@test.dev");
  assert.equal(data.walletBalance, 125);
  assert.equal(data.lastActiveAt, new Date(baseTime + 140_000).toISOString());
  assert.equal(data.activity.availability.status, "available");
  assert.equal(data.activity.latestEvent.action, "select_location");
  assert.equal(data.activity.totalCarViews, 2);
  assert.deepEqual(data.viewedCars, [{ name: "Test Sedan", views: 2 }]);
  assert.equal(data.activity.timeline.length, 3);
  assert.match(data.activity.timeline[0].label, /Demo Location/);
  assert.equal(data.activity.timeline[1].action, "click_car");
  assert.equal(data.activity.timeline[2].count, 2);
  assert.match(data.activity.timeline[2].label, /2 times/);
  assert.doesNotMatch(JSON.stringify(data.activity.timeline), /sent_marketing_notif|HomeScreen/);

  assert.equal(data.bookings.availability.status, "available");
  assert.equal(data.bookings.scope, "caller_company");
  assert.equal(data.bookings.trips, 64);
  assert.equal(data.bookings.completed, 1);
  assert.equal(data.bookings.spent, null);
  assert.deepEqual(data.bookings.spentAvailability, {
    status: "unavailable",
    reason: "booking_spend_source_unverified",
  });
  assert.deepEqual(data.bookings.counts, {
    all: 65,
    completed: 1,
    ongoing: 63,
    cancelled: 1,
  });
  assert.equal(data.bookings.history.data.length, 60);
  assert.equal(data.bookings.history.hasMore, true);
  assert.equal(data.sectionAvailability.segment.status, "available");
  assert.equal(data.segment.value.key, "vip");
  assert.ok(data.recommendation.text);
  assert.ok(data.messageDraft.text);

  await Customer.create({
    customerName: "Duplicate Phone Customer",
    mobileNumber: "+91 9876543210",
  });
  const ambiguous = await api(
    "GET",
    `/leads/app-installs/${customer._id}`,
  );
  assert.equal(ambiguous.status, 200);
  assert.deepEqual(ambiguous.json.data.bookings.availability, {
    status: "unavailable",
    reason: "customer_mobile_association_ambiguous",
  });
  assert.equal(ambiguous.json.data.bookings.history, null);
  assert.equal(ambiguous.json.data.activity.availability.status, "available");
  assert.doesNotMatch(
    JSON.stringify(ambiguous.json.data.activity.timeline),
    /Demo Location/,
  );

  const emptyCustomer = await Customer.create({
    customerName: "No Activity Customer",
    mobileNumber: "9876543211",
  });
  const emptyResponse = await api(
    "GET",
    `/leads/app-installs/${emptyCustomer._id}`,
  );
  assert.equal(emptyResponse.status, 200);
  assert.equal(emptyResponse.json.data.activity.availability.status, "empty");
  assert.deepEqual(emptyResponse.json.data.viewedCars, []);
  assert.deepEqual(emptyResponse.json.data.activity.timeline, []);
  assert.equal(emptyResponse.json.data.bookings.availability.status, "empty");
  assert.equal(emptyResponse.json.data.bookings.spent, 0);
  assert.deepEqual(emptyResponse.json.data.bookings.spentAvailability, {
    status: "empty",
    reason: null,
  });
});
