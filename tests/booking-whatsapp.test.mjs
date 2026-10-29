import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin, dayFromToday } from "./helpers/harness.mjs";

// Real booking API and temporary MongoDB; every WATI POST is intercepted.
let ctx, api, token, vehicleId, Booking, Lead, PaymentHistory, axios, sendBookingCreatedMessage;
let sequence = 0;
before(async () => {
  ctx = await startTestApp();
  ({ token } = await createUserAndLogin(ctx.base));
  api = client(ctx.base, token);
  ({ default: Booking } = await import("../src/models/booking.model.js"));
  ({ default: Lead } = await import("../src/models/lead.model.js"));
  ({ default: PaymentHistory } = await import("../src/models/paymentHistory.model.js"));
  ({ default: axios } = await import("axios"));
  ({ sendBookingCreatedMessage } = await import("../src/services/wati.service.js"));
  const created = await api("POST", "/vehicles/create", { vehicleName: "WhatsApp fixture", vehicleNumber: "KA01WA0001",
    manufacturer: "Test", fuelType: "Petrol", transmission: "Manual", seatingCapacity: 5 });
  assert.equal(created.status, 201);
  vehicleId = created.json.data._id;
  assert.equal((await api("PUT", `/vehicles/update/${vehicleId}`, { pricePerDay: 1000 })).status, 200);
});
after(async () => { await ctx?.stop(); });
function body(extra = {}) {
  sequence += 1;
  return { customerName: "WhatsApp fixture", mobileNumber: `940010${String(sequence).padStart(4, "0")}`,
    vehicleId, paymentMethod: "cash", flexibleTime: true, fromDate: dayFromToday(sequence * 3),
    toDate: dayFromToday(sequence * 3 + 1), pickupTime: "08:00 AM", dropTime: "08:00 AM", ...extra };
}
async function withProvider(post, run) {
  const previous = axios.post;
  let assertionFailure;
  axios.post = async (...args) => {
    try { return await post(...args); }
    catch (error) {
      // The production service intentionally catches provider errors; test
      // assertions must still fail the test instead of becoming send failures.
      if (error.code === "ERR_ASSERTION") assertionFailure = error;
      throw error;
    }
  };
  try {
    const result = await run();
    if (assertionFailure) throw assertionFailure;
    return result;
  } finally { axios.post = previous; }
}

async function withCommit(commit, run) {
  const startSession = ctx.mongoose.startSession;
  ctx.mongoose.startSession = async function (...args) {
    const session = await startSession.apply(this, args);
    const originalCommit = session.commitTransaction.bind(session);
    session.commitTransaction = () => commit(originalCommit);
    return session;
  };
  try { return await run(); }
  finally { ctx.mongoose.startSession = startSession; }
}

let confirmed;
test("confirmed New Booking sends the exact approved template to its saved mobile only after commit", async () => {
  const input = body({ mobileNumber: "9197000101", bookingAmount: 100 });
  let calls = 0;
  await withProvider(async (url, payload, config) => {
    calls += 1;
    const saved = await Booking.findOne({ mobileNumber: input.mobileNumber }).lean();
    assert.ok(saved, "a query outside the booking session can see the committed record");
    assert.equal(saved.status, "confirmed");
    const lead = await Lead.findById(saved.lead).lean();
    assert.equal(String(lead.bookingId), String(saved._id));
    assert.equal(lead.isBookingCreated, true);
    assert.ok(await PaymentHistory.exists({ bookingId: saved._id }), "the advance is committed too");
    assert.equal(new URL(url).searchParams.get("whatsappNumber"), "919197000101");
    assert.match(new URL(url).pathname, /\/api\/v2\/sendTemplateMessage$/);
    assert.equal(payload.template_name, "booking_confirmation_message");
    assert.equal(payload.channel_number, "919876500000");
    assert.deepEqual(payload.parameters, []);
    assert.deepEqual(Object.keys(payload).sort(), ["broadcast_name", "channel_number", "parameters", "template_name"]);
    assert.equal(config.timeout, 15000);
    assert.equal(config.headers.Authorization, "Bearer test-token");
    return { data: { result: true } };
  }, async () => {
    const response = await api("POST", "/leads/create", input);
    assert.equal(response.status, 201, response.json.message);
    confirmed = response.json.booking;
  });
  assert.equal(calls, 1);
});

test("recipient normalization preserves local, country-prefixed and international numbers", async () => {
  const calls = [];
  await withProvider(async url => { calls.push(new URL(url).searchParams.get("whatsappNumber")); return { data: { result: true } }; }, async () => {
    for (const number of ["9876500101", "+91 98765 00101", "09876500101", "00919876500101", "+1 202 555 0123"])
      assert.equal((await sendBookingCreatedMessage(number)).success, true);
  });
  assert.deepEqual(calls, ["919876500101", "919876500101", "919876500101", "919876500101", "12025550123"]);
});

test("invalid recipients never produce an outbound WATI request", async () => {
  await withProvider(async () => assert.fail("invalid number must not be sent"), async () => {
    for (const number of ["", null, "bad-number", "123", "++919876500101", "1234567890123456"]) {
      assert.deepEqual(await sendBookingCreatedMessage(number), { success: false, error: "Invalid customer mobile number" });
    }
  });
});

test("validation failures and availability conflicts do not send confirmations", async () => {
  await withProvider(async () => assert.fail("unconfirmed booking must not send"), async () => {
    assert.equal((await api("POST", "/leads/create", body({ customerName: "" }))).status, 400);
    assert.equal((await api("POST", "/leads/create", body({ fromDate: confirmed.fromDate.slice(0, 10), toDate: confirmed.toDate.slice(0, 10) }))).status, 409);
  });
});

test("failed booking persistence and later transaction rollback never send confirmations", async () => {
  const counts = async () => Promise.all([
    Booking.countDocuments(), Lead.countDocuments(), PaymentHistory.countDocuments(),
  ]);
  await withProvider(async () => assert.fail("failed persistence must not send"), async () => {
    for (const model of [Booking, PaymentHistory]) {
      const before = await counts();
      const create = model.create;
      model.create = async () => { throw new Error("Isolated booking persistence failure"); };
      try {
        const response = await api("POST", "/leads/create", body({ bookingAmount: 100 }));
        assert.equal(response.status, 500);
        assert.equal(response.json.success, false);
      } finally { model.create = create; }
      assert.deepEqual(await counts(), before, "all booking transaction writes are rolled back");
    }
  });
});

test("a failed transaction commit never sends a confirmation or leaves a booking", async () => {
  const input = body({ bookingAmount: 100 });
  let attempts = 0;
  await withProvider(async () => assert.fail("failed commit must not send"), async () => {
    await withCommit(async () => {
      attempts += 1;
      throw new Error("Isolated transaction commit failure");
    }, async () => {
      const response = await api("POST", "/leads/create", input);
      assert.equal(response.status, 500);
      assert.equal(response.json.success, false);
    });
  });
  assert.equal(attempts, 1);
  assert.equal(await Booking.countDocuments({ mobileNumber: input.mobileNumber }), 0);
  assert.equal(await Lead.countDocuments({ mobileNumber: input.mobileNumber }), 0);
  assert.equal(await PaymentHistory.countDocuments({ "customer.mobileNumber": input.mobileNumber }), 0);
});

test("a committed booking that is cancelled, deleted or no longer confirmed is not sent", async () => {
  await withProvider(async () => assert.fail("only a currently confirmed booking may send"), async () => {
    for (const update of [
      { $set: { status: "cancelled" } },
      { $set: { isDeleted: true } },
      { $unset: { status: "" } },
    ]) {
      const input = body();
      let commits = 0;
      await withCommit(async originalCommit => {
        await originalCommit();
        commits += 1;
        // Simulate a status change after commit, before the notification check.
        // Only the temporary test database is touched.
        await Booking.collection.updateOne({ mobileNumber: input.mobileNumber }, update);
      }, async () => {
        assert.equal((await api("POST", "/leads/create", input)).status, 201);
      });
      assert.equal(commits, 1);
    }
  });
});

test("replaying the same booking request sends one confirmation, and editing does not send another", async () => {
  const input = body();
  let calls = 0;
  await withProvider(async () => { calls += 1; return { data: { result: true } }; }, async () => {
    const request = async payload => {
      const response = await fetch(`${ctx.base}/leads/create`, { method: "POST", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "whatsapp-booking-retry-0001",
      }, body: JSON.stringify(payload) });
      return { status: response.status, json: await response.json() };
    };
    const first = await request(input);
    assert.equal(first.status, 201);
    const retry = await request({ ...input, mobileNumber: "9876500202" });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.booking._id, first.json.booking._id);
    assert.equal(retry.json.booking.mobileNumber, input.mobileNumber);
    assert.equal((await api("PUT", `/leads/booking-update/${first.json.booking._id}`, { destination: "Edit fixture" })).status, 200);
  });
  assert.equal(calls, 1);
});

test("WATI rejection, timeout and HTML responses never undo a committed booking or leak a recipient", async () => {
  const logs = [];
  const previous = { log: console.log, warn: console.warn, error: console.error };
  const mobile = "9876500303";
  for (const level of Object.keys(previous)) console[level] = (...args) => logs.push(JSON.stringify(args));
  try {
    for (const mode of ["rejection", "timeout", "html"]) {
      await withProvider(async () => {
        if (mode === "rejection") return { data: { result: false, info: `Rejected ${mobile}` } };
        if (mode === "html") return { data: "<!doctype html><html>WATI dashboard</html>" };
        const error = new Error(`timeout: https://wati.invalid/?whatsappNumber=91${mobile}`);
        error.code = "ECONNABORTED";
        throw error;
      }, async () => {
        const response = await api("POST", "/leads/create", body({ mobileNumber: mobile }));
        assert.equal(response.status, 201, response.json.message);
        assert.equal((await Booking.findById(response.json.booking._id).lean()).status, "confirmed");
        assert.equal((await sendBookingCreatedMessage(mobile)).success, false);
      });
    }
  } finally { Object.assign(console, previous); }
  assert.equal(logs.join("\n").includes(mobile), false);
  assert.equal(logs.some(line => line.includes("confirmation accepted")), false);
});
