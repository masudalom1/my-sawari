import mongoose from "mongoose";

const userManagementLockSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    lockId: {
      type: String,
      default: null,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
  },
  { versionKey: false },
);

const UserManagementLock =
  mongoose.models.UserManagementLock ||
  mongoose.model("UserManagementLock", userManagementLockSchema);

export default UserManagementLock;
