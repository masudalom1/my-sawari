import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

// No .env, database or real WATI requests are used in these service tests.
Object.assign(process.env, { WATI_API_URL: "https://wati.invalid", WATI_TENANT_ID: "test-tenant", WATI_API_TOKEN: "test-token" });
const { sendBookingCreatedMessage, verifyBookingCreatedTemplate } = await import("../src/services/wati.service.js");
const template = () => ({ elementName: "booking_confirmation_message", status: "APPROVED", language: { value: "en" },
  wabaId: "test-waba", wabaContextIds: ["test-context"], customParams: [], body: "Approved fixture",
  header: { typeString: "image", mediaHeaderId: "test-approved-media", headerParamMapping: null }, buttons: [] });
const sender = () => ({ enabled: true, wabaId: "test-waba", wabaContextId: "test-context", phoneNumber: "919876500000" });
let previous, posts, gets, logs;
beforeEach(() => {
  previous = { get: axios.get, post: axios.post, log: console.log, error: console.error, warn: console.warn };
  posts = []; gets = []; logs = [];
  axios.get = async (url, config) => {
    gets.push({ url, config });
    return url.endsWith("getMessageTemplates") ? { data: { result: "success", messageTemplates: [template()] } } : { data: [sender()] };
  };
  axios.post = async (url, body, config) => { posts.push({ url, body, config }); return { data: { result: true } }; };
  for (const level of ["log", "error", "warn"]) console[level] = (...args) => logs.push(JSON.stringify(args));
});
afterEach(() => {
  axios.get = previous.get; axios.post = previous.post;
  console.log = previous.log; console.error = previous.error; console.warn = previous.warn;
});
const serve = (templates, channels = [sender()]) => {
  axios.get = async url => url.endsWith("getMessageTemplates")
    ? { data: { result: "success", messageTemplates: templates } } : { data: channels };
};

test("approved account template uses v2 documented fields and its matching sender only", async () => {
  assert.equal((await sendBookingCreatedMessage("9876500101")).success, true);
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ["broadcast_name", "channel_number", "parameters", "template_name"]);
  assert.equal(posts[0].body.template_name, "booking_confirmation_message");
  assert.equal(posts[0].body.channel_number, "919876500000");
  assert.deepEqual(posts[0].body.parameters, []);
  assert.match(posts[0].body.broadcast_name, /^booking_created_\d+$/);
  assert.equal(new URL(posts[0].url).searchParams.get("whatsappNumber"), "919876500101");
  assert.equal(gets.length, 2);
  assert.match(gets[0].url, /\/api\/v1\/getMessageTemplates$/);
  assert.match(gets[1].url, /\/api\/v2\/whatsapp\/phoneNumbers$/);
  assert.deepEqual(gets[0].config.params, { pageSize: 100, pageNumber: 1 });
  assert.equal(gets[0].config.headers.Authorization, "Bearer test-token");
});

test("default sender without context is matched by the template's WABA ID", async () => {
  serve([template()], [{ ...sender(), wabaContextId: null }]);
  const result = await verifyBookingCreatedTemplate();
  assert.equal(result.success, true);
  assert.equal(result.channelNumber, "919876500000");
  assert.equal(result.template.language, "en");
  assert.equal(result.template.headerType, "image");
  assert.equal(result.template.hasStaticMedia, true);
  assert.equal(posts.length, 0, "verification is read-only");
});

test("missing, pending or rejected exact templates never fall back to another message", async () => {
  for (const templates of [[], [{ ...template(), elementName: "booking_confirmation_v2" }],
    [{ ...template(), status: "PENDING" }], [{ ...template(), status: "REJECTED" }]]) {
    serve(templates);
    const result = await sendBookingCreatedMessage("9876500101");
    assert.equal(result.success, false);
    assert.match(result.error, /WATI template configuration error: booking_confirmation_message/);
  }
  assert.equal(posts.length, 0);
  assert.ok(logs.some(line => line.includes("configuration error")));
});

test("body/custom/header parameter mismatches and missing media assets block sending", async () => {
  for (const value of [
    { ...template(), customParams: ["customerName"] }, { ...template(), customParams: undefined },
    { ...template(), body: "Hello {{customerName}}" },
    { ...template(), header: { ...template().header, headerParamMapping: { image: "imageUrl" } } },
    { ...template(), header: { typeString: "image" } },
  ]) {
    serve([value]);
    const result = await sendBookingCreatedMessage("9876500101");
    assert.equal(result.success, false);
    assert.match(result.error, /configuration error/);
  }
  assert.equal(posts.length, 0);
});

test("missing, disabled, ambiguous or unrelated sender channels produce configuration errors", async () => {
  for (const channels of [[], [{ ...sender(), enabled: false }], [sender(), sender()],
    [{ ...sender(), wabaContextId: "other-context" }], [{ ...sender(), wabaContextId: null, wabaId: "other-waba" }]]) {
    serve([template()], channels);
    const result = await sendBookingCreatedMessage("9876500101");
    assert.equal(result.success, false);
    assert.match(result.error, /unambiguous enabled sender channel/);
  }
  assert.equal(posts.length, 0);
});

test("HTML, rejected metadata and lookup failures cannot be treated as approval or leak credentials", async () => {
  for (const data of ["<html>WATI dashboard</html>", { result: false }, { result: "success", messageTemplates: null }]) {
    axios.get = async () => ({ data });
    assert.equal((await sendBookingCreatedMessage("9876500101")).success, false);
  }
  axios.get = async () => { throw new Error("Bearer test-token and recipient 9876500101"); };
  const failed = await sendBookingCreatedMessage("9876500101");
  assert.equal(failed.success, false);
  assert.match(failed.error, /lookup failed/);
  assert.equal(posts.length, 0);
  assert.equal(logs.join("\n").includes("test-token"), false);
  assert.equal(logs.join("\n").includes("9876500101"), false);
});

test("template pagination finds the exact name beyond the first page", async () => {
  axios.get = async (url, config) => {
    gets.push({ url, config });
    if (!url.endsWith("getMessageTemplates")) return { data: [sender()] };
    return { data: { result: "success", messageTemplates: config.params.pageNumber === 1
      ? Array.from({ length: 100 }, (_, index) => ({ ...template(), elementName: `other_${index}` })) : [template()] } };
  };
  assert.equal((await sendBookingCreatedMessage("9876500101")).success, true);
  assert.deepEqual(gets.filter(call => call.config.params).map(call => call.config.params.pageNumber), [1, 2]);
  assert.equal(posts.length, 1);
});
