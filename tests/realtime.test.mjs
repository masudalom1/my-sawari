// Real-time dashboard notifications (Socket.IO): authentication, delivery
// rules, post-commit-only events, and the change-invalidated dashboard cache.
// Uses the in-memory replica set, so the MongoDB change stream runs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { io as connectSocket } from "socket.io-client";
import { startTestApp, createUserAndLogin, client } from "./helpers/harness.mjs";

let ctx;
let realtime;
let socketUrl;
let admin; // { token, user }
let socket; // admin's long-lived socket
let Maintenance;
let Vehicle;
let User;
const sockets = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(50);
  }
  return false;
};

// Resolves with "ready" payload, or rejects with the connect_error.
function open(token, extra = {}) {
  const s = connectSocket(socketUrl, {
    transports: ["websocket"],
    reconnection: false,
    ...(token === undefined ? {} : { auth: { token } }),
    ...extra,
  });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once("realtime:ready", (ready) => resolve({ s, ready }));
    s.once("connect_error", reject);
  });
}

// Collects dashboard:changed events on `s` for `ms`.
async function collect(s, ms, action) {
  const events = [];
  const onChange = (p) => events.push(p);
  s.on("dashboard:changed", onChange);
  try {
    await action?.();
    await sleep(ms);
  } finally {
    s.off("dashboard:changed", onChange);
  }
  return events;
}

const nextChange = (s, topic, ms = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${topic} event`)), ms);
    const onChange = (payload) => {
      if (!payload.topics.includes(topic)) return;
      clearTimeout(timer);
      s.off("dashboard:changed", onChange);
      resolve(payload);
    };
    s.on("dashboard:changed", onChange);
  });

const newVehicle = async () =>
  (await Vehicle.collection.insertOne({ vehicleName: "Test", isDeleted: false })).insertedId;

before(async () => {
  ctx = await startTestApp();
  realtime = await import("../src/realtime/changeFeed.js");
  realtime.startRealtime(ctx.server);
  assert.ok(await waitFor(() => realtime.isChangeStreamActive()), "change stream did not start");

  ({ default: Maintenance } = await import("../src/models/maintenance.model.js"));
  ({ default: Vehicle } = await import("../src/models/vehicle.model.js"));
  ({ default: User } = await import("../src/models/user.model.js"));

  socketUrl = `http://127.0.0.1:${ctx.server.address().port}`;
  admin = await createUserAndLogin(ctx.base);
  ({ s: socket } = await open(admin.token));
  // drain the "refresh everything" event sent when the stream started
  await sleep(1700);
});

after(async () => {
  for (const s of sockets) s.close();
  await realtime?.stopRealtime();
  await ctx?.stop();
});

// ---------- Authentication ----------

test("connections without a valid token are refused", async () => {
  await assert.rejects(open(undefined), (err) => err.data?.status === 401);
  await assert.rejects(open("not-a-jwt"), (err) => err.data?.status === 401);

  const wrongSecret = jwt.sign({ userId: admin.user.id }, "some-other-secret");
  await assert.rejects(open(wrongSecret), (err) => err.data?.status === 401);
});

test("cookies alone do not authenticate a socket", async () => {
  await assert.rejects(
    open(undefined, { extraHeaders: { Cookie: `accessToken=${admin.token}` } }),
    (err) => err.data?.status === 401,
  );
});

test("a blocked account cannot connect (same rule as REST)", async () => {
  const blocked = await createUserAndLogin(ctx.base);
  await User.updateOne({ email: blocked.email }, { accountStatus: "BLOCKED" });

  const rest = await client(ctx.base, blocked.token)("POST", "/dashboard/maintenance", {});
  assert.equal(rest.status, 403);
  await assert.rejects(open(blocked.token), (err) => err.data?.status === 403);
});

test("a token for a user missing from this database is refused (same rule as REST)", async () => {
  const gone = await createUserAndLogin(ctx.base);
  await User.deleteOne({ email: gone.email });

  const rest = await client(ctx.base, gone.token)("POST", "/dashboard/maintenance", {});
  assert.equal(rest.status, 401);
  await assert.rejects(
    open(gone.token),
    (err) => err.data?.status === 401 && err.data.message === "User not found",
  );
});

test("a failed account lookup is 503 (retry), not a rejected login", async () => {
  const original = User.findById;
  User.findById = () => Promise.reject(new Error("server selection timed out"));
  try {
    await assert.rejects(
      open(admin.token),
      (err) => err.message === "unavailable" && err.data?.status === 503,
    );
  } finally {
    User.findById = original;
  }
  const { ready } = await open(admin.token);
  assert.equal(ready.subscribed, true);
});

test("a valid token connects and is subscribed by the server", async () => {
  const { ready } = await open(admin.token);
  assert.equal(ready.subscribed, true);
  assert.equal(typeof ready.seq, "number");
});

test("a connected session ends when the account is blocked", async () => {
  const other = await createUserAndLogin(ctx.base);
  const { s } = await open(other.token);
  const ended = new Promise((r) => s.once("realtime:session_ended", r));
  const disconnected = new Promise((r) => s.once("disconnect", r));

  await User.updateOne({ email: other.email }, { accountStatus: "SUSPENDED" });

  assert.deepEqual(await ended, { reason: "access_revoked" });
  assert.equal(await disconnected, "io server disconnect");
});

test("a connected session ends when its token expires", async () => {
  const shortLived = jwt.sign(
    { userId: admin.user.id, role: "SUPER_ADMIN" },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: 2 },
  );
  const { s } = await open(shortLived);
  const ended = await new Promise((r) => s.once("realtime:session_ended", r));
  assert.deepEqual(ended, { reason: "token_expired" });
});

// ---------- Events ----------

test("a write made outside this server's routes reaches connected dashboards", async () => {
  const vehicle = await newVehicle();
  const event = nextChange(socket, "maintenances");
  // Raw driver write: no Express route, no Mongoose middleware involved
  await Maintenance.collection.insertOne({
    vehicle,
    startDate: new Date(),
    endDate: new Date(Date.now() + 86400000),
    isDeleted: false,
  });
  const payload = await event;
  // Only what changed: no documents, ids, customer or payment fields
  assert.deepEqual(Object.keys(payload).sort(), ["at", "seq", "topics"]);
  assert.ok(!payload.topics.includes("users"));
});

test("one successful API mutation -> one event, after the data is readable", async () => {
  const vehicle = await newVehicle();
  await sleep(1700); // let the vehicle insert's own event pass
  const api = client(ctx.base, admin.token);

  let readableAtEvent = null;
  const events = [];
  const onChange = async (p) => {
    events.push(p);
    const list = await fetch(`${ctx.base}/dashboard/maintenance/timeline`).then((r) => r.json());
    readableAtEvent ??= list.data.some((m) => String(m.vehicle) === String(vehicle));
  };
  socket.on("dashboard:changed", onChange);
  const res = await api("POST", "/dashboard/maintenance", {
    vehicle: String(vehicle),
    startDate: new Date(Date.now() + 10 * 86400000).toISOString(),
    endDate: new Date(Date.now() + 11 * 86400000).toISOString(),
  });
  await sleep(2500);
  socket.off("dashboard:changed", onChange);

  assert.equal(res.status, 201);
  // Maintenance insert + vehicle status update are coalesced into one event
  assert.equal(events.length, 1);
  assert.ok(events[0].topics.includes("maintenances"));
  assert.ok(events[0].topics.includes("vehicles"));
  assert.equal(readableAtEvent, true);
});

test("failed mutations emit nothing", async () => {
  const api = client(ctx.base, admin.token);
  const events = await collect(socket, 2500, async () => {
    assert.equal((await client(ctx.base)("POST", "/dashboard/maintenance", {})).status, 401);
    assert.equal((await api("POST", "/dashboard/maintenance", {})).status, 400);
    assert.equal(
      (
        await api("POST", "/dashboard/maintenance", {
          vehicle: "65f000000000000000000000",
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 86400000).toISOString(),
        })
      ).status,
      404,
    );
  });
  assert.equal(events.length, 0);
});

test("an aborted transaction emits nothing; a committed one emits once", async () => {
  const vehicle = await newVehicle();
  const doc = () => ({
    vehicle,
    startDate: new Date(),
    endDate: new Date(Date.now() + 86400000),
    isDeleted: false,
  });
  await sleep(1700); // let the vehicle insert's own event pass

  const aborted = await collect(socket, 2000, async () => {
    const session = await ctx.mongoose.startSession();
    session.startTransaction();
    await Maintenance.create([doc()], { session });
    await session.abortTransaction();
    await session.endSession();
  });
  assert.equal(aborted.length, 0);

  const committed = await collect(socket, 2000, async () => {
    const session = await ctx.mongoose.startSession();
    await session.withTransaction(async () => {
      await Maintenance.create([doc()], { session });
      await Maintenance.create([doc()], { session });
    });
    await session.endSession();
  });
  assert.equal(committed.length, 1);
  assert.ok(committed[0].topics.includes("maintenances"));
});

test("event numbers increase by one, so clients can drop duplicates", async () => {
  const seqs = [];
  const onChange = (p) => seqs.push(p.seq);
  socket.on("dashboard:changed", onChange);
  for (let i = 0; i < 2; i++) {
    await Vehicle.collection.insertOne({ vehicleName: `Seq ${i}`, isDeleted: false });
    await sleep(1800);
  }
  socket.off("dashboard:changed", onChange);
  assert.equal(seqs.length, 2);
  assert.equal(seqs[1], seqs[0] + 1);
});

test("client events cannot join rooms or trigger broadcasts", async () => {
  const other = await createUserAndLogin(ctx.base);
  const { s } = await open(other.token);
  const events = await collect(socket, 1000, () => {
    s.emit("join", "dashboard");
    s.emit("dashboard:changed", { topics: ["bookings"] });
  });
  assert.equal(events.length, 0);
});

// ---------- Cache ----------

test("cached dashboard reads are reused until the data changes", async () => {
  const url = `${ctx.base}/dashboard/maintenance/timeline`;

  const first = await fetch(url);
  const firstBody = await first.json();
  assert.equal(first.headers.get("x-dashboard-cache"), "miss");

  const second = await fetch(url);
  assert.equal(second.headers.get("x-dashboard-cache"), "hit");
  assert.deepEqual(await second.json(), firstBody);

  const event = nextChange(socket, "maintenances");
  await Maintenance.collection.insertOne({
    vehicle: firstBody.data[0].vehicle,
    startDate: new Date(),
    endDate: new Date(Date.now() + 86400000),
    isDeleted: false,
  });
  await event;

  const third = await fetch(url);
  const thirdBody = await third.json();
  assert.equal(third.headers.get("x-dashboard-cache"), "miss");
  assert.equal(thirdBody.count, firstBody.count + 1);
});

test("a write request through the API invalidates the cache before it responds", async () => {
  const url = `${ctx.base}/dashboard/maintenance/timeline`;
  await fetch(url);
  assert.equal((await fetch(url)).headers.get("x-dashboard-cache"), "hit");

  // Any write request (even a rejected one) clears cached reads up front
  await fetch(`${ctx.base}/dashboard/maintenance`, { method: "POST" });
  assert.equal((await fetch(url)).headers.get("x-dashboard-cache"), "miss");
});
