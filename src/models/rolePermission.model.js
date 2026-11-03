import mongoose from "mongoose";
import { USER_ROLES } from "./user.model.js";
import { isRegisteredPermissionMap } from "../../shared/rbacPermissionRegistry.mjs";

const rolePermissionSchema = new mongoose.Schema(
  {
    businessName: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
    },
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
      validate: {
        validator: (value) => isRegisteredPermissionMap(value),
        message:
          "Permissions must contain only registered permission keys with boolean values",
      },
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

rolePermissionSchema.index({ businessName: 1, role: 1 }, { unique: true });

const RolePermission =
  mongoose.models.RolePermission ||
  mongoose.model("RolePermission", rolePermissionSchema);

export default RolePermission;
