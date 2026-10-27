import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MEMBERSHIP_DISCOUNT_PLANS, membershipDiscountFor, membershipDiscountTerms } from "../shared/membershipDiscount.mjs";

const now = new Date("2030-01-01T00:00:00.000Z");
const expiresAt = new Date("2031-01-01T00:00:00.000Z");

test("established plan percentages, whole-rupee rounding and trip caps are preserved", () => {
  for (const [plan, small, capped] of [["starter", 50, 499], ["plus", 100, 799], ["pro", 125, 999]]) {
    const membership = { plan, expiresAt, totalSaved: 0 };
    assert.equal(membershipDiscountFor(1000, membership, now), small);
    assert.equal(membershipDiscountFor(100000, membership, now), capped);
  }
  assert.equal(membershipDiscountFor(101, { plan: "plus", expiresAt }, now), 10);
  assert.equal(membershipDiscountFor(105, { plan: "plus", expiresAt }, now), 11);
});

test("remaining annual allowance limits savings and exhausted or expired memberships receive zero", () => {
  assert.equal(membershipDiscountFor(10000, { plan: "starter", expiresAt, totalSaved: 9950 }, now), 50);
  assert.equal(membershipDiscountFor(10000, { plan: "starter", expiresAt, totalSaved: 10000 }, now), 0);
  assert.equal(membershipDiscountFor(10000, { plan: "plus", expiresAt, totalSaved: 14990 }, now), 10);
  assert.equal(membershipDiscountFor(10000, { plan: "pro", expiresAt, totalSaved: 19999 }, now), 1);
  for (const membership of [null, { plan: "unknown", expiresAt }, { plan: "toString", expiresAt }, { plan: "pro", expiresAt: now }]) {
    assert.equal(membershipDiscountFor(1000, membership, now), 0);
  }
  assert.equal(membershipDiscountTerms({ plan: "starter", expiresAt, totalSaved: 9990 }, now).remainingAnnualCap, 10);
});

// Optional source parity check when the customer backend is present locally.
// Production checkouts do not depend on an absolute external filesystem path.
const customerSource = new URL("../../../../CustomerSawari/mysawari_customer_backend/", import.meta.url);
const customerCatalogue = new URL("src/config/membership-plans.js", customerSource);
test("operations discounts match the existing customer-app catalogue and calculator", {
  skip: !existsSync(customerCatalogue) && "customer backend checkout is not present",
}, () => {
  const require = createRequire(import.meta.url);
  const customerPlans = require(fileURLToPath(customerCatalogue));
  const { membershipDiscountFor: customerDiscount } = require(fileURLToPath(new URL("src/modules/bookings/booking.money.js", customerSource)));
  const futureExpiry = new Date(Date.now() + 86400000);
  for (const [plan, terms] of Object.entries(MEMBERSHIP_DISCOUNT_PLANS)) {
    const { discountRate, tripCap, annualCap } = customerPlans[plan];
    assert.deepEqual(terms, { discountRate, tripCap, annualCap });
    for (const base of [0, 105, 1000, 10000, 50000]) {
      for (const totalSaved of [0, annualCap - 30, annualCap, annualCap + 1]) {
        const membership = { plan, expiresAt: futureExpiry, totalSaved };
        assert.equal(membershipDiscountFor(base, membership), customerDiscount(base, membership));
      }
    }
  }
});
