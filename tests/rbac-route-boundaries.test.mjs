import { test } from "node:test";
import assert from "node:assert/strict";
import RolePermission from "../src/models/rolePermission.model.js";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("revenue-only access cannot read dashboard vehicle, booking, or maintenance imports", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const admin = await createUserAndLogin(ctx.base);
  const finance = await createUserAndLogin(ctx.base, {
    role: "FINANCE_EXECUTIVE",
  });
  await RolePermission.create({
    businessName: finance.user.businessName,
    role: "FINANCE_EXECUTIVE",
    permissions: { "page.revenue.view": true },
    updatedBy: admin.user.id,
  });
  const financeApi = client(ctx.base, finance.token);

  for (const path of [
    "/dashboard/import",
    "/dashboard/bookings/import",
    "/dashboard/maintenance",
  ]) {
    const response = await financeApi("GET", path);
    assert.equal(response.status, 403, `${path} requires dashboard.view`);
  }

  const revenuePayments = await financeApi("GET", "/dashboard/payments/import");
  assert.equal(revenuePayments.status, 200, revenuePayments.json.message);
});
