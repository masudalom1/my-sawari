import mongoose from "mongoose";
import { USER_ROLES } from "./user.model.js";

const rbacAuditLogSchema = new mongoose.Schema(
  {
    businessName: {
      type: String,
      required: true,
      trim: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: [
        "user.created",
        "user.updated",
        "user.role.updated",
        "user.status.updated",
        "user.deleted",
        "user.overrides.updated",
        "user.password.changed",
        "role.permissions.updated",
      ],
      required: true,
    },
    targetType: {
      type: String,
      enum: ["user", "role"],
      required: true,
    },
    targetUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    targetRole: {
      type: String,
      enum: USER_ROLES,
      default: null,
    },
    changes: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

rbacAuditLogSchema.index({ businessName: 1, createdAt: -1, _id: -1 });
rbacAuditLogSchema.index({
  businessName: 1,
  targetType: 1,
  targetUser: 1,
  createdAt: -1,
});

rbacAuditLogSchema.pre("save", function () {
  if (!this.isNew) throw new Error("RBAC audit events are append-only");
});

for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  rbacAuditLogSchema.pre(operation, function () {
    throw new Error("RBAC audit events are append-only");
  });
}

rbacAuditLogSchema.pre(
  "deleteOne",
  { document: true, query: false },
  function () {
    throw new Error("RBAC audit events are append-only");
  },
);

const RbacAuditLog =
  mongoose.models.RbacAuditLog ||
  mongoose.model("RbacAuditLog", rbacAuditLogSchema);

export default RbacAuditLog;
