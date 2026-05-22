import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import validator from "validator";

export const USER_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "BRANCH_MANAGER",
  "OPERATIONS",
  "OPERATIONS_EXECUTIVE",
  "BOOKING",
  "BOOKING_EXECUTIVE",
  "SALES_MANAGER",
  "SALES_EXECUTIVE",
  "FLEET_MANAGER",
  "VEHICLE_SUPERVISOR",
  "CUSTOMER_SUPPORT",
  "ACCOUNTS_MANAGER",
  "FINANCE_EXECUTIVE",
  "DRIVER_COORDINATOR",
  "INSPECTOR",
  "FIELD_EXECUTIVE",
];

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
      minlength: 2,
      maxlength: 100,
    },

    mobileNumber: {
      type: String,
      required: [true, "Mobile number is required"],
      unique: true,
      trim: true,
      validate: {
        validator: function (value) {
          return /^[6-9]\d{9}$/.test(value);
        },
        message: "Invalid mobile number",
      },
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      validate: [validator.isEmail, "Invalid email address"],
    },

    businessName: {
      type: String,
      required: [true, "Business name is required"],
      trim: true,
      maxlength: 150,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 8,
      select: false,
    },

    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
    },

    accountStatus: {
      type: String,
      enum: ["ACTIVE", "BLOCKED", "SUSPENDED", "DELETED"],
      default: "ACTIVE",
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    isMobileVerified: {
      type: Boolean,
      default: false,
    },

    failedLoginAttempts: {
      type: Number,
      default: 0,
    },

    lockUntil: {
      type: Date,
      default: null,
    },

    refreshToken: {
      type: String,
      default: null,
      select: false,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    lastLoginIP: {
      type: String,
      default: null,
    },

    profileImage: {
      type: String,
      default: null,
    },

    permissions: {
      type: [String],
      default: [],
    },

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ email: 1 });
userSchema.index({ mobileNumber: 1 });
userSchema.index({ role: 1 });

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

const User = mongoose.model("User", userSchema);

export default User;