import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERMISSION_MODULES,
  PERMISSIONS,
  RBAC_PERMISSION_KEYS,
  permissionKey,
} from "../shared/rbacPermissionRegistry.mjs";

const routeDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/routes",
);

test("central registry defines unique stable permissions for implemented actions", () => {
  assert.deepEqual(RBAC_PERMISSION_KEYS, [
    "page.dashboard.view",
    "page.dashboard.create",
    "page.dashboard.edit",
    "page.dashboard.delete",
    "page.revenue.view",
    "page.vehicleRevenue.view",
    "page.bookings.view",
    "page.bookings.create",
    "page.bookings.edit",
    "page.bookings.delete",
    "page.paymentsHistory.view",
    "page.paymentsHistory.export",
    "page.pendingToCollect.view",
    "page.pendingToCollect.collect",
    "page.verifyUpiCollections.view",
    "page.verifyUpiCollections.verify",
    "page.settings.view",
    "page.settings.create",
    "page.settings.edit",
    "page.settings.manageAccess",
    "page.qrCodes.view",
    "page.qrCodes.create",
  ]);
  assert.equal(new Set(RBAC_PERMISSION_KEYS).size, RBAC_PERMISSION_KEYS.length);
  assert.deepEqual(
    RBAC_PERMISSION_KEYS,
    PERMISSION_MODULES.flatMap(({ key, actions }) =>
      actions.map((action) => permissionKey(key, action)),
    ),
  );

  for (const { key, actions } of PERMISSION_MODULES) {
    for (const action of actions) {
      assert.equal(PERMISSIONS[key][action], permissionKey(key, action));
    }
  }
});

test("backend route guards reference only keys from the central registry", async () => {
  const routeFiles = (await readdir(routeDirectory))
    .filter((name) => name.endsWith(".js"));
  const knownKeys = new Set(RBAC_PERMISSION_KEYS);
  let guardedOperations = 0;

  for (const filename of routeFiles) {
    const source = await readFile(path.join(routeDirectory, filename), "utf8");
    const permissionRefs = [
      ...source.matchAll(/PERMISSIONS\.([A-Za-z0-9]+)\.([A-Za-z0-9]+)/g),
    ];
    const guardCalls = [...source.matchAll(/requirePermission\(/g)].length;
    guardedOperations += permissionRefs.length;
    for (const [, moduleKey, action] of permissionRefs) {
      assert.ok(
        knownKeys.has(permissionKey(moduleKey, action)),
        `${filename} references unregistered permission ${moduleKey}.${action}`,
      );
    }
    assert.doesNotMatch(
      source,
      /requirePermission\(\s*["'`]page\./,
      `${filename} should not hardcode a permission key`,
    );
    assert.ok(
      permissionRefs.length >= guardCalls,
      `${filename} has permission guards that do not reference the central registry`,
    );
  }

  assert.ok(guardedOperations > 0);
});

test("Coming Soon modules have no route or configurable permissions", () => {
  const comingSoon = PERMISSION_MODULES.filter(
    ({ status }) => status === "coming-soon",
  );
  assert.deepEqual(
    comingSoon.map(({ key }) => key),
    ["customers", "maintenance", "reports", "invoices", "notifications"],
  );
  assert.ok(
    comingSoon.every(({ href, actions }) => href === null && actions.length === 0),
  );
});
