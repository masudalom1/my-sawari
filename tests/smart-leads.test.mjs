import { test } from "node:test";
import assert from "node:assert/strict";
import Booking from "../src/models/booking.model.js";
import Customer from "../src/models/customer.model.js";
import CustomerActivity from "../src/models/customerActivity.model.js";
import Lead from "../src/models/lead.model.js";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";
import { computeIntentScore } from "../src/services/intentScoring.js";
import { currentIndiaDate } from "../src/utils/indiaDateRange.js";

test("intent score applies the initial capped heuristic and lead bands", () => {
  const allSignals = computeIntentScore({
    vehicleViews: 50,
    repeatVehicleSession: true,
    selectedRentalDates: true,
    appliedSearchFilters: true,
    checkedAvailability: true,
    startedCheckout: true,
    activeLast24Hours: true,
  });
  assert.equal(allSignals.score, 100);
  assert.equal(allSignals.category, "Hot Lead");
  assert.equal(allSignals.breakdown.vehicleViews, 20);

  assert.equal(computeIntentScore({}).category, "Cold Lead");
  assert.equal(
    computeIntentScore({ vehicleViews: 5, startedCheckout: true }).category,
    "Warm Lead",
  );
});

test("Smart Leads use company vehicle events, customer-app bookings, permissions, and scoped follow-up history", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const staff = await createUserAndLogin(ctx.base, { role: "BOOKING_EXECUTIVE" });
  const adminApi = client(ctx.base, admin.token);
  const staffApi = client(ctx.base, staff.token);
  const endpoint = "/leads/app-installs/smart-insights";

  assert.equal((await staffApi("GET", endpoint)).status, 403);
  const grant = await adminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    {
      permissions: {
        "page.appUsers.view": true,
        "page.bookings.view": true,
      },
    },
  );
  assert.equal(grant.status, 200);
  const unavailable = await staffApi("GET", endpoint);
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.json.data.availability.status, "unavailable");
  assert.deepEqual(unavailable.json.data.hotLeads.data, []);
  const unavailableStages = new Map(
    unavailable.json.data.funnel.stages.map((stage) => [stage.key, stage]),
  );
  assert.equal(unavailableStages.get("appOpen").status, "not_attributable");
  assert.equal(unavailableStages.get("vehicleView").uniqueUsers, null);
  assert.equal(unavailableStages.get("bookingConfirmed").uniqueUsers, 0);
  assert.equal(
    (await staffApi("PATCH", "/leads/app-installs/000000000000000000000001/interest-lead", {
      status: "Contacted",
    })).status,
    403,
  );

  const User = (await import("../src/models/user.model.js")).default;
  const owner = await User.findOne({ email: admin.email }).select("_id").lean();
  const otherCompanyAdmin = await createUserAndLogin(ctx.base);
  const otherOwner = await User.findOne({ email: otherCompanyAdmin.email }).select("_id").lean();
  await User.updateOne(
    { email: staff.email },
    { $set: { createdBy: owner._id } },
  );
  const vehicleId = new ctx.mongoose.Types.ObjectId();
  const otherVehicleId = new ctx.mongoose.Types.ObjectId();
  const Vehicle = (await import("../src/models/vehicle.model.js")).default;
  await Vehicle.collection.insertOne({
    _id: vehicleId,
    company: owner._id,
    createdBy: owner._id,
    vehicleName: "Xoom Red",
    displayName: "Xoom Red",
    category: "bike",
    isDeleted: false,
  });
  await Vehicle.collection.insertOne({
    _id: otherVehicleId,
    company: otherOwner._id,
    createdBy: otherOwner._id,
    vehicleName: "Xoom Red",
    displayName: "Xoom Red",
    category: "bike",
    isDeleted: false,
  });
  const [bookedCustomer, checkoutCustomer, untrackedBookingCustomer] = await Customer.create([
    { customerName: "Asha Viewer", mobileNumber: "9876500001" },
    { customerName: "Bala Viewer", mobileNumber: "9876500002" },
    { customerName: "Chitra Booked", mobileNumber: "9876500003" },
  ]);
  const now = Date.now();
  const when = (minutesAgo) => new Date(now - minutesAgo * 60 * 1000);
  const event = (customer, action, sessionId, details = {}, minutesAgo = 5) => ({
    customerId: customer._id,
    mobileNumber: customer.mobileNumber,
    sessionId,
    action,
    details,
    createdAt: when(minutesAgo),
    updatedAt: when(minutesAgo),
  });
  const vehicleDetails = { vehicleId, carName: "Xoom Red" };
  const otherVehicleDetails = { vehicleId: otherVehicleId, carName: "Foreign Red" };
  await CustomerActivity.collection.insertMany([
    ...[1, 2, 3, 4].map((minute) =>
      event(bookedCustomer, "view_car", "session-a", vehicleDetails, 24 + minute)),
    event(bookedCustomer, "view_car", "session-b", vehicleDetails, 20),
    event(bookedCustomer, "APP_OPENED", "session-a", {}, 40),
    event(bookedCustomer, "trip_search", "session-a", {}, 39),
    event(bookedCustomer, "select_dates", "session-b", {}, 21),
    event(bookedCustomer, "select_dates", "session-b", {
      fromDate: "2030-01-10",
      toDate: "2030-01-12",
    }, 18),
    event(bookedCustomer, "apply_filter", "session-b", {}, 17),
    event(bookedCustomer, "check_availability", "session-b", {
      ...vehicleDetails,
      available: true,
    }, 16),
    event(bookedCustomer, "initiate_checkout", "session-b", vehicleDetails, 14),
    event(bookedCustomer, "view_car", "other-company-session", { carName: "Xoom Red" }, 10),
    ...[1, 2, 3, 4].map((minute) =>
      event(checkoutCustomer, "view_car", "session-x", vehicleDetails, 24 + minute)),
    event(checkoutCustomer, "view_car", "session-y", vehicleDetails, 20),
    event(checkoutCustomer, "APP_OPENED", "session-x", {}, 40),
    event(checkoutCustomer, "select_dates", "session-y", {}, 18),
    event(checkoutCustomer, "initiate_checkout", "session-y", vehicleDetails, 14),
    event(checkoutCustomer, "view_car", "other-company-session", otherVehicleDetails, 13),
    event(checkoutCustomer, "select_dates", "other-company-session", otherVehicleDetails, 12),
    event(checkoutCustomer, "apply_filter", "other-company-session", otherVehicleDetails, 11),
    event(checkoutCustomer, "check_availability", "other-company-session", {
      ...otherVehicleDetails,
      available: false,
    }, 10),
    event(checkoutCustomer, "initiate_checkout", "other-company-session", otherVehicleDetails, 9),
  ]);
  await Booking.collection.insertOne({
    company: owner._id,
    createdBy: owner._id,
    customerName: "Asha Viewer",
    mobileNumber: "9876500001",
    bookingSource: "customer_app",
    vehicleId,
    status: "confirmed",
    isDeleted: false,
    createdAt: when(2),
    updatedAt: when(2),
  });
  await Booking.collection.insertOne({
    company: owner._id,
    createdBy: owner._id,
    customerName: untrackedBookingCustomer.customerName,
    mobileNumber: untrackedBookingCustomer.mobileNumber,
    bookingSource: "customer_app",
    vehicleId,
    status: "confirmed",
    isDeleted: false,
    createdAt: when(3),
    updatedAt: when(3),
  });
  await Booking.collection.insertOne({
    company: owner._id,
    createdBy: owner._id,
    customerName: "Bala Viewer",
    mobileNumber: "9876500002",
    bookingSource: "dashboard",
    status: "confirmed",
    isDeleted: false,
    createdAt: when(1),
    updatedAt: when(1),
  });

  const insights = await adminApi("GET", endpoint);
  assert.equal(insights.status, 200);
  const data = insights.json.data;
  assert.equal(data.availability.status, "available");
  assert.equal(data.scoring.heuristic, true);
  assert.equal(data.hotLeads.total, 2);
  assert.equal(data.hotLeads.diagnostics.companyVehicleViewEvents, 10);
  assert.equal(data.hotLeads.diagnostics.identifiableVehicleViewers, 2);
  assert.equal(data.hotLeads.diagnostics.hotLeadCandidates, 2);
  const [asha, bala] = data.hotLeads.data;
  assert.equal(asha.name, "Asha Viewer");
  assert.equal(asha.score, 100);
  assert.equal(asha.category, "Hot Lead");
  assert.equal(asha.bookingStatus, "confirmed");
  assert.equal(asha.selectedDates.from, "2030-01-10T00:00:00.000Z");
  assert.equal(bala.name, "Bala Viewer");
  assert.equal(bala.score, 80);
  assert.equal(bala.breakdown.checkedAvailability, 0);
  assert.equal(bala.bookingStatus, "No customer-app booking");
  assert.equal(bala.recommendations.some(({ key }) => key === "checkout_without_booking"), true);

  const funnelByKey = new Map(data.funnel.stages.map((stage) => [stage.key, stage]));
  assert.equal(funnelByKey.get("vehicleView").uniqueUsers, 2);
  assert.equal(funnelByKey.get("availabilityCheck").uniqueUsers, 1);
  assert.equal(funnelByKey.get("checkoutStarted").uniqueUsers, 2);
  assert.equal(funnelByKey.get("bookingConfirmed").uniqueUsers, 2);
  assert.equal(funnelByKey.get("appOpen").status, "not_attributable");
  assert.equal(funnelByKey.get("appOpen").uniqueUsers, null);
  assert.equal(funnelByKey.get("bookingConfirmed").records, 2);
  assert.equal(data.funnel.diagnostics.confirmedBookingsWithoutTrackedCheckout, 1);

  const sequentialByKey = new Map(
    data.funnel.sequential.stages.map((stage) => [stage.key, stage]),
  );
  assert.equal(sequentialByKey.get("dateSelection").uniqueUsers, 2);
  assert.equal(sequentialByKey.get("availabilityCheck").uniqueUsers, 1);
  assert.equal(sequentialByKey.get("availabilityCheck").conversionRate, 50);
  assert.equal(sequentialByKey.get("checkoutStarted").uniqueUsers, 1);
  assert.equal(sequentialByKey.get("bookingConfirmed").uniqueUsers, 1);
  assert.equal(sequentialByKey.get("bookingConfirmed").conversionRate, 100);

  const today = currentIndiaDate();
  const todayOnly = await adminApi(
    "GET",
    `${endpoint}?from=${today}&to=${today}`,
  );
  assert.equal(todayOnly.status, 200);
  assert.equal(todayOnly.json.data.funnel.period.from, today);
  assert.equal(todayOnly.json.data.funnel.period.to, today);
  assert.equal(todayOnly.json.data.funnel.diagnostics.confirmedBookingsFound, 2);
  const invalidRange = await adminApi(
    "GET",
    `${endpoint}?from=2026-02-30&to=${today}`,
  );
  assert.equal(invalidRange.status, 400);
  const partialRange = await adminApi(
    "GET",
    `${endpoint}?from=${today}`,
  );
  assert.equal(partialRange.status, 400);
  const oversizedRange = await adminApi(
    "GET",
    `${endpoint}?from=2025-01-01&to=${today}`,
  );
  assert.equal(oversizedRange.status, 400);

  const ownerId = String(owner._id);
  const team = await adminApi("GET", "/leads/app-installs/interest-leads/team");
  assert.equal(team.status, 200);
  assert.equal(team.json.data.some(({ id }) => id === ownerId), true);

  const editGrant = await adminApi(
    "PUT",
    "/auth/roles/BOOKING_EXECUTIVE/permissions",
    {
      permissions: {
        "page.appUsers.view": true,
        "page.bookings.view": true,
        "page.bookings.edit": true,
      },
    },
  );
  assert.equal(editGrant.status, 200);
  const followupDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const update = await staffApi(
    "PATCH",
    `/leads/app-installs/${checkoutCustomer._id}/interest-lead`,
    {
      note: "Customer selected dates and started checkout.",
      status: "Follow-up Scheduled",
      assignedTo: ownerId,
      nextFollowupDate: followupDate,
    },
  );
  assert.equal(update.status, 200);
  assert.equal(update.json.data.status, "Follow-up Scheduled");
  assert.equal(update.json.data.assignedTo, ownerId);
  const repeatUpdate = await staffApi(
    "PATCH",
    `/leads/app-installs/${checkoutCustomer._id}/interest-lead`,
    {
      status: "Follow-up Scheduled",
      assignedTo: ownerId,
      nextFollowupDate: followupDate,
    },
  );
  assert.equal(repeatUpdate.status, 200);
  assert.equal(
    await Lead.countDocuments({
      company: owner._id,
      customerId: checkoutCustomer._id,
      isCustomerInterestLead: true,
    }),
    1,
  );

  const history = await staffApi(
    "GET",
    `/leads/app-installs/${checkoutCustomer._id}/interest-lead`,
  );
  assert.equal(history.status, 200);
  assert.equal(history.json.data.lead.status, "Follow-up Scheduled");
  assert.equal(history.json.data.lead.assignedTo.name, (await User.findById(owner._id)).fullName);
  assert.equal(history.json.data.history.some(({ kind }) => kind === "note"), true);

  const otherAdmin = await createUserAndLogin(ctx.base, { businessName: "Other Rentals" });
  const otherApi = client(ctx.base, otherAdmin.token);
  const otherCompanyUpdate = await otherApi(
    "PATCH",
    `/leads/app-installs/${checkoutCustomer._id}/interest-lead`,
    { status: "Contacted" },
  );
  assert.equal(otherCompanyUpdate.status, 404);
  assert.equal(
    await Lead.countDocuments({
      company: owner._id,
      customerId: checkoutCustomer._id,
      isCustomerInterestLead: true,
    }),
    1,
  );
});
