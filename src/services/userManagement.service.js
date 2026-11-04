import { randomUUID } from "node:crypto";
import User from "../models/user.model.js";
import UserManagementLock from "../models/userManagementLock.model.js";
import ApiError from "../utils/ApiError.js";

const MANAGEMENT_LOCK_DURATION_MS = 5 * 60 * 1000;

export async function assertNotLastActiveSuperAdmin(user, session) {
  if (user.role !== "SUPER_ADMIN" || user.accountStatus !== "ACTIVE") return;

  const countQuery = User.countDocuments({
    businessName: user.businessName,
    role: "SUPER_ADMIN",
    accountStatus: "ACTIVE",
    deletedAt: null,
  });
  if (session) countQuery.session(session);
  const activeSuperAdminCount = await countQuery;

  if (activeSuperAdminCount <= 1) {
    throw new ApiError(
      409,
      "The last active Super Admin cannot be demoted or deleted",
    );
  }
}

export async function withUserManagementLock(businessName, operation) {
  if (!businessName) {
    throw new ApiError(403, "A business scope is required to manage employees");
  }

  const lockId = randomUUID();
  try {
    await UserManagementLock.updateOne(
      { _id: businessName },
      { $setOnInsert: { lockId: null, lockedUntil: null } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const now = new Date();
  const lock = await UserManagementLock.findOneAndUpdate(
    {
      _id: businessName,
      $or: [
        { lockId: null },
        { lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        lockId,
        lockedUntil: new Date(now.getTime() + MANAGEMENT_LOCK_DURATION_MS),
      },
    },
    { new: true },
  );
  if (!lock) {
    throw new ApiError(409, "Another user-management operation is in progress");
  }

  try {
    return await operation();
  } finally {
    await UserManagementLock.updateOne(
      { _id: businessName, lockId },
      { $set: { lockId: null, lockedUntil: null } },
    );
  }
}
