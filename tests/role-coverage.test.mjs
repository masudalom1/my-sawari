import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { USER_ROLES } from "../shared/userRoles.mjs";
import {
  RBAC_PERMISSION_KEYS,
} from "../src/config/rbacPermissions.js";
import User from "../src/models/user.model.js";
import RolePermission from "../src/models/rolePermission.model.js";
import {
  startTestApp,
  client,
  createUserAndLogin,
} from "./helpers/harness.mjs";

test("all canonical roles pass user validation, authentication, and access resolution", async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const permissions = Object.fromEntries(
    RBAC_PERMISSION_KEYS.map((key) => [key, false]),
  );

  for (const role of USER_ROLES) {
    const session = await createUserAndLogin(ctx.base, { role });
    const user = await User.findById(session.user.id);
    assert.ok(user, `${role} user is persisted`);
    assert.equal(user.role, role);

    const policy = await RolePermission.create({
      businessName: user.businessName,
      role,
      permissions,
      updatedBy: user._id,
    });
    assert.equal(policy.role, role, `${role} role policy is valid`);

    const api = client(ctx.base, session.token);
    const currentUser = await api("GET", "/auth/me");
    assert.equal(currentUser.status, 200, `${role} passes authentication`);
    assert.equal(currentUser.json.data.user.role, role);

    const access = await api("GET", "/auth/permissions/me");
    assert.equal(access.status, 200, `${role} resolves an access profile`);
    assert.equal(access.json.data.role, role);
    assert.equal(access.json.data.user.id, session.user.id);
    if (role === "SUPER_ADMIN") {
      assert.equal(access.json.data.effectivePermissions["page.dashboard.view"], true);
    } else {
      assert.equal(access.json.data.effectivePermissions["page.dashboard.view"], false);
    }
  }

  const invalidSession = await createUserAndLogin(ctx.base, { role: "ADMIN" });
  await User.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(invalidSession.user.id) },
    { $set: { role: "UNRECOGNIZED_ROLE" } },
  );
  const invalidRoleResponse = await client(ctx.base, invalidSession.token)(
    "GET",
    "/auth/permissions/me",
  );
  assert.equal(invalidRoleResponse.status, 403);
  assert.equal(invalidRoleResponse.json.message, "Account role is invalid");
});
