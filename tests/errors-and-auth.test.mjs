// Status codes, route protection, input handling and log hygiene.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, client, createUserAndLogin } from "./helpers/harness.mjs";

let ctx;
let anon;
let user;
let api;

before(async () => {
  ctx = await startTestApp();
  anon = client(ctx.base);
  user = await createUserAndLogin(ctx.base, { role: "SALES_EXECUTIVE" });
  api = client(ctx.base, user.token);
});

after(async () => {
  await ctx?.stop();
});

test("missing / malformed / expired tokens are 401, not 500", async () => {
  const none = await anon("GET", "/auth/me");
  assert.equal(none.status, 401);
  assert.equal(none.json.success, false);
  assert.equal(none.json.message, "Authentication required");

  const garbage = await client(ctx.base, "not-a-jwt")("GET", "/auth/me");
  assert.equal(garbage.status, 401);
  assert.equal(garbage.json.message, "Invalid or expired token");

  const { default: jwt } = await import("jsonwebtoken");
  const expired = jwt.sign({ userId: user.user.id }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 });
  const old = await client(ctx.base, expired)("GET", "/auth/me");
  assert.equal(old.status, 401);
});

test("a valid token still works and the /me contract is unchanged", async () => {
  const me = await api("GET", "/auth/me");
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.json.data.user).sort(), [
    "accountStatus",
    "businessName",
    "email",
    "fullName",
    "id",
    "mobileNumber",
    "role",
  ]);
});

test("login errors keep their intended status codes", async () => {
  const missing = await anon("POST", "/auth/login", { emailOrMobile: user.email });
  assert.equal(missing.status, 400);

  const wrong = await anon("POST", "/auth/login", { emailOrMobile: user.email, password: "Wrong1!pass" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.message, "Invalid credentials");

  const ok = await anon("POST", "/auth/login", { emailOrMobile: user.email, password: user.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.data.accessToken);
});

test("role checks answer 403 (restrictTo and allowRoles style)", async () => {
  const employees = await api("GET", "/auth/employees");
  assert.equal(employees.status, 403);

  const create = await api("POST", "/auth/employees", {});
  assert.equal(create.status, 403);
  assert.equal(create.json.message, "Only Super Admin can create employees");
});

test("refresh token: missing is 401, rotation contract unchanged", async () => {
  const missing = await anon("POST", "/auth/refresh-token", {});
  assert.equal(missing.status, 401);

  const res = await fetch(`${ctx.base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailOrMobile: user.email, password: user.password }),
  });
  const refreshCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("refreshToken="))
    .split(";")[0];

  const refreshed = await fetch(`${ctx.base}/auth/refresh-token`, {
    method: "POST",
    headers: { Cookie: refreshCookie },
  });
  assert.equal(refreshed.status, 200);
  assert.ok((await refreshed.json()).data.accessToken);
});

test("unknown routes are 404 and invalid ids are 400 (CastError)", async () => {
  const missing = await anon("GET", "/nope");
  assert.equal(missing.status, 404);
  assert.match(missing.json.message, /Route Not Found/);

  const badId = await api("GET", "/leads/booking-details/not-an-id");
  assert.equal(badId.status, 400);
  assert.equal(badId.json.success, false);
});

test("malformed JSON is a 400", async () => {
  const res = await fetch(`${ctx.base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad json",
  });
  assert.equal(res.status, 400);
});

test("POST /dashboard/maintenance requires a token; the revenue GETs stay public", async () => {
  const write = await anon("POST", "/dashboard/maintenance", {});
  assert.equal(write.status, 401);

  const withToken = await api("POST", "/dashboard/maintenance", {});
  assert.equal(withToken.status, 400); // reaches the controller's own validation
  assert.equal(withToken.json.message, "Vehicle is required");

  for (const path of ["/dashboard/stats", "/dashboard/import", "/dashboard/payments/import", "/dashboard/maintenance"]) {
    const res = await anon("GET", path);
    assert.equal(res.status, 200, `${path}: ${res.json.message}`);
  }

  // Deliberately still open: the web AllBookings page sends no token yet.
  const sheet = await anon("GET", "/dashboard/payments/booking");
  assert.equal(sheet.status, 200);
});

test("lead search accepts regex characters (\"+91\", \"(\") instead of failing", async () => {
  const lead = await api("POST", "/leads", {
    customerName: "Plus Customer",
    mobileNumber: "+919876511111",
    vehicleType: "bike",
  });
  assert.equal(lead.status, 201, lead.json.message);

  const plus = await api("GET", `/leads?search=${encodeURIComponent("+91987")}`);
  assert.equal(plus.status, 200);
  assert.equal(plus.json.total, 1);

  const paren = await api("GET", `/leads?search=${encodeURIComponent("(")}`);
  assert.equal(paren.status, 200);
  assert.equal(paren.json.total, 0);

  const plain = await api("GET", "/leads?search=plus");
  assert.equal(plain.json.total, 1);
});

test("production responses hide 5xx internals and stack traces", async () => {
  const { default: errorHandler } = await import("../src/middlewares/error.middleware.js");
  const run = (err) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      errorHandler(err, { method: "GET", originalUrl: "/x" }, res, () => {});
    } finally {
      console.error = originalError;
    }
    return res;
  };

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const crash = run(new Error("E11000 duplicate key error collection: mysawari.users"));
    assert.equal(crash.statusCode, 500);
    assert.equal(crash.body.message, "Internal Server Error");
    assert.equal(crash.body.stack, null);

    const apiError = new (await import("../src/utils/ApiError.js")).default(409, "Email already registered");
    const conflict = run(apiError);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.message, "Email already registered");
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("request bodies are masked in dev logs and not logged in production", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  try {
    await anon("POST", "/auth/login", { emailOrMobile: user.email, password: user.password });
    const devLog = lines.join("\n");
    assert.ok(devLog.includes("[REDACTED]"));
    assert.ok(!devLog.includes(user.password), "password must not be logged");

    lines.length = 0;
    process.env.NODE_ENV = "production";
    await anon("POST", "/auth/login", { emailOrMobile: user.email, password: user.password });
    assert.ok(!lines.some((l) => l.startsWith("BODY:")));
  } finally {
    console.log = originalLog;
    process.env.NODE_ENV = "test";
  }
});
