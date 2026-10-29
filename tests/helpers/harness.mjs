// Test harness: an in-memory MongoDB replica set (transactions work), the real
// Express app on a random port, and mocks for Cloudinary and WATI.
// Never touches the database or services configured in .env.

import { Writable } from "node:stream";
import { MongoMemoryReplSet } from "mongodb-memory-server";

// Every variable from .env.example gets a fake value BEFORE the app is
// imported, so dotenv (which never overrides) cannot pull real ones in.
const FAKE_ENV = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "test-only-secret",
  JWT_ACCESS_EXPIRES: "1h",
  CLIENT_URL: "http://localhost:3000",
  PAYMENTS_REPORT_COMPANY_ID: "000000000000000000000001",
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-key",
  CLOUDINARY_API_SECRET: "test-secret",
  WATI_API_URL: "https://wati.invalid",
  WATI_TENANT_ID: "test-tenant",
  WATI_API_TOKEN: "test-token",
};

export async function startTestApp(envOverrides = {}) {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

  Object.assign(process.env, FAKE_ENV, envOverrides, {
    MONGO_URI: replSet.getUri("mysawari_test"),
  });

  const { default: mongoose } = await import("mongoose");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const watiCalls = await mockWati();
  const cloudinary = await mockCloudinary();

  const { default: app } = await import("../../src/app.js");
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  return {
    base,
    server,
    mongoose,
    watiCalls,
    cloudinary,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await mongoose.disconnect();
      await replSet.stop();
    },
  };
}

// WATI: record calls instead of sending WhatsApp messages.
export async function mockWati() {
  const { default: axios } = await import("axios");
  const calls = [];
  axios.get = async (url) => {
    if (url.endsWith("/api/v2/whatsapp/phoneNumbers")) return { data: [{
      enabled: true, phoneNumber: "919876500000", wabaContextId: "test-waba-context",
    }] };
    if (!url.endsWith("/api/v1/getMessageTemplates")) throw new Error("Unexpected external GET in test");
    return { data: { result: "success", messageTemplates: [{
      elementName: "booking_confirmation_message", status: "APPROVED", language: { value: "en" },
      wabaContextIds: ["test-waba-context"],
      customParams: [], body: "Approved fixture", buttons: [],
      header: { typeString: "image", mediaHeaderId: "test-approved-media" },
    }] } };
  };
  axios.post = async (url, payload, config) => {
    calls.push({ url, payload, config });
    return { data: { result: true } };
  };
  return calls;
}

// Cloudinary: multer-storage-cloudinary pipes each file into upload_stream().
export async function mockCloudinary() {
  const { default: cloudinary } = await import("../../src/config/cloudinary.js");
  const state = { fail: false, uploads: 0 };

  cloudinary.uploader.upload_stream = (opts, callback) =>
    new Writable({
      write(chunk, encoding, next) {
        next();
      },
      final(next) {
        next();
        if (state.fail) return callback(new Error("Cloudinary upload failed (mock)"));
        state.uploads += 1;
        const id = opts.public_id || `mock-${state.uploads}`;
        callback(undefined, {
          secure_url: `https://res.cloudinary.com/test-cloud/image/upload/${id}.jpg`,
          public_id: id,
        });
      },
    });
  cloudinary.uploader.destroy = (id, options, callback) => callback?.(undefined, { result: "ok" });

  return state;
}

export function client(base, token) {
  return async (method, path, body) => {
    const isForm = body instanceof FormData;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

let userSeq = 0;

export async function createUserAndLogin(base, { role = "SUPER_ADMIN" } = {}) {
  const { default: User } = await import("../../src/models/user.model.js");
  userSeq += 1;
  const email = `user${userSeq}.${Date.now()}@test.dev`;
  const password = "Passw0rd!";
  await User.create({
    fullName: `Test User ${userSeq}`,
    mobileNumber: `98${String(10000000 + userSeq * 7919 + (Date.now() % 1000)).slice(-8)}`,
    email,
    businessName: "Test Rentals",
    password,
    role,
  });

  const login = await client(base)("POST", "/auth/login", { emailOrMobile: email, password });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.json.message}`);
  return { token: login.json.data.accessToken, user: login.json.data.user, email, password };
}

// YYYY-MM-DD, n days from today (UTC calendar, as createBookings validates).
export const dayFromToday = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const jpegBlob = () =>
  new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])], {
    type: "image/jpeg",
  });
