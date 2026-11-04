import mongoose from "mongoose";
import User, { USER_ROLES } from "../models/user.model.js";
import validator from "validator";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import {
  validateLoginInput,
} from "../utils/validators.js";
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  cookieOptions,
} from "../services/token.service.js";
import { normalizeUserPermissionOverrideMap } from "../config/rbacPermissions.js";
import { recordRbacAudit } from "../services/rbacAudit.service.js";
import {
  assertNotLastActiveSuperAdmin,
  withUserManagementLock,
} from "../services/userManagement.service.js";

const sendAuthResponse = async (user, res, statusCode = 200) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  const hashedRefreshToken = hashRefreshToken(refreshToken);

  user.refreshToken = hashedRefreshToken;
  user.lastLoginAt = new Date();

  await user.save();

  res
    .cookie("accessToken", accessToken, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    })
    .cookie("refreshToken", refreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .status(statusCode)
    .json({
      success: true,
      message:
        statusCode === 201
          ? "Account created successfully"
          : "Login successful",
      data: {
        user: {
          id: user._id,
          fullName: user.fullName,
          email: user.email,
          mobileNumber: user.mobileNumber,
          businessName: user.businessName,
          role: user.role,
          accountStatus: user.accountStatus,
        },
        accessToken,
      },
    });
};

export const createEmployee = asyncHandler(async (req, res) => {
  const superAdmin = req.user;

  if (superAdmin.role !== "SUPER_ADMIN") {
    throw new ApiError(
      403,
      "Only Super Admin can create employees"
    );
  }
  if (!superAdmin.businessName) {
    throw new ApiError(403, "A business scope is required to create employees");
  }

  const body = req.body || {};
  const { fullName, mobileNumber, email, password, role } = body;
  if (
    typeof fullName !== "string" ||
    typeof mobileNumber !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof role !== "string"
  ) {
    throw new ApiError(400, "Full name, email, mobile number, password, and role are required");
  }
  const normalizedName = fullName.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedMobile = mobileNumber.trim();
  if (normalizedName.length < 2 || normalizedName.length > 100) {
    throw new ApiError(400, "Full name must be between 2 and 100 characters");
  }
  if (!validator.isEmail(normalizedEmail)) {
    throw new ApiError(400, "A valid email address is required");
  }
  if (!/^[6-9]\d{9}$/.test(normalizedMobile)) {
    throw new ApiError(400, "A valid 10-digit Indian mobile number is required");
  }
  if (
    password.length < 8 ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new ApiError(
      400,
      "Password must be at least 8 characters and contain an uppercase letter, a number, and a special character",
    );
  }
  if (body.confirmPassword !== undefined && body.confirmPassword !== password) {
    throw new ApiError(400, "Passwords do not match");
  }
  if (!USER_ROLES.includes(role) || role === "SUPER_ADMIN") {
    throw new ApiError(400, "A valid non-Super Admin role is required");
  }
  if (
    body.businessName !== undefined &&
    body.businessName !== superAdmin.businessName
  ) {
    throw new ApiError(403, "Employee business scope is derived from the authenticated administrator");
  }
  if (body.branchId !== undefined && body.branchId !== null && body.branchId !== "") {
    throw new ApiError(400, "Branch assignment is unavailable because this application has no branch directory");
  }

  let permissionOverrides = {};
  if (body.overrides !== undefined) {
    const normalizedOverrides = normalizeUserPermissionOverrideMap(body.overrides);
    if (!normalizedOverrides) {
      throw new ApiError(
        400,
        "Overrides must contain registered, non-protected permission keys with allow or deny values",
      );
    }
    permissionOverrides = Object.fromEntries(
      Object.entries(normalizedOverrides).filter(([, value]) => value !== "inherit"),
    );
  }

  const existingUser = await User.findOne({
    $or: [
      { email: normalizedEmail },
      { mobileNumber: normalizedMobile },
    ],
  });

  if (existingUser) {
    if (existingUser.email === normalizedEmail) {
      throw new ApiError(
        409,
        "Email already registered"
      );
    }

    if (
      existingUser.mobileNumber === normalizedMobile
    ) {
      throw new ApiError(
        409,
        "Mobile number already registered"
      );
    }
  }

  let employee;
  try {
    employee = await User.create({
      fullName: normalizedName,
      mobileNumber: normalizedMobile,
      email: normalizedEmail,
      businessName: superAdmin.businessName,
      password,
      role,
      permissionOverrides,
      permissionOverridesUpdatedBy:
        body.overrides !== undefined ? superAdmin._id : null,
      permissionOverridesUpdatedAt:
        body.overrides !== undefined ? new Date() : null,
      createdBy: superAdmin._id,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const duplicateField = error.keyPattern?.email
      ? "Email"
      : error.keyPattern?.mobileNumber
        ? "Mobile number"
        : "Email or mobile number";
    throw new ApiError(409, `${duplicateField} already registered`);
  }

  await recordRbacAudit({
    actor: superAdmin,
    action: "user.created",
    targetType: "user",
    targetUser: employee._id,
    changes: {
      identity: {
        fullName: employee.fullName,
        email: employee.email,
        mobileNumber: employee.mobileNumber,
      },
      role: { from: null, to: employee.role },
      accountStatus: { from: null, to: employee.accountStatus },
      ...(body.overrides !== undefined
        ? { permissionOverrides: { from: null, to: permissionOverrides } }
        : {}),
    },
  });

  res.status(201).json({
    success: true,
    message:
      "Employee created successfully",
    data: {
      user: {
        id: employee._id,
        fullName: employee.fullName,
        email: employee.email,
        mobileNumber:
          employee.mobileNumber,
        role: employee.role,
      },
    },
  });
});

export const loginUser = asyncHandler(async (req, res) => {
  validateLoginInput(req.body);

  const { emailOrMobile, password } = req.body;

  const user = await User.findOne({
    $or: [
      { email: emailOrMobile.toLowerCase() },
      { mobileNumber: emailOrMobile },
    ],
  }).select("+password +refreshToken");

  if (!user) {
    throw new ApiError(401, "Invalid credentials");
  }

  if (user.accountStatus !== "ACTIVE") {
    throw new ApiError(403, "Account access denied");
  }

  if (user.isLocked()) {
    throw new ApiError(
      423,
      "Account temporarily locked due to failed attempts"
    );
  }

  const isPasswordCorrect = await user.comparePassword(password);

  if (!isPasswordCorrect) {
    user.failedLoginAttempts += 1;

    if (user.failedLoginAttempts >= 5) {
      user.lockUntil = new Date(Date.now() + 30 * 60 * 1000);
    }

    await user.save();

    throw new ApiError(401, "Invalid credentials");
  }

  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  user.lastLoginIP =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    null;

  await sendAuthResponse(user, res, 200);
});

export const logoutUser = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;

  if (refreshToken) {
    const hashed = hashRefreshToken(refreshToken);

    await User.findOneAndUpdate(
      { refreshToken: hashed },
      {
        $unset: {
          refreshToken: 1,
        },
      }
    );
  }

  res
    .clearCookie("accessToken", cookieOptions)
    .clearCookie("refreshToken", cookieOptions)
    .status(200)
    .json({
      success: true,
      message: "Logged out successfully",
    });
});

export const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies?.refreshToken || req.body.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Refresh token required");
  }

  const hashedToken = hashRefreshToken(incomingRefreshToken);

  const user = await User.findOne({
    refreshToken: hashedToken,
  });

  if (!user) {
    throw new ApiError(401, "Invalid refresh token");
  }

  if (user.accountStatus !== "ACTIVE") {
    throw new ApiError(403, "Account access denied");
  }

  const newAccessToken = generateAccessToken(user);

  res
    .cookie("accessToken", newAccessToken, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    })
    .status(200)
    .json({
      success: true,
      message: "Access token refreshed",
      data: {
        accessToken: newAccessToken,
      },
    });
});

export const getCurrentUser = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      user: {
        id: req.user._id,
        fullName: req.user.fullName,
        email: req.user.email,
        mobileNumber: req.user.mobileNumber,
        businessName: req.user.businessName,
        role: req.user.role,
        accountStatus: req.user.accountStatus,
      },
    },
  });
});

export const resetPassword = asyncHandler(
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      throw new ApiError(400, "Current and new passwords are required");
    }
    if (
      newPassword.length < 8 ||
      !/[A-Z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword) ||
      !/[^A-Za-z0-9]/.test(newPassword)
    ) {
      throw new ApiError(
        400,
        "New password must be at least 8 characters and contain an uppercase letter, a number, and a special character",
      );
    }
    if (!req.user?._id) {
      throw new ApiError(401, "Authentication required");
    }

    const user = await User.findById(req.user._id).select("+password +refreshToken");
    if (!user) {
      throw new ApiError(404, "Account not found");
    }
    if (!(await user.comparePassword(currentPassword))) {
      throw new ApiError(401, "Current password is incorrect");
    }

    user.password = newPassword;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    user.refreshToken = null;

    await user.save();
    await recordRbacAudit({
      actor: user,
      action: "user.password.changed",
      targetType: "user",
      targetUser: user._id,
      changes: { password: { changed: true } },
    });

    res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  }
);

export const updateEmployeeRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!mongoose.isObjectIdOrHexString(id)) {
      throw new ApiError(400, "Invalid employee ID");
    }

    if (!role || !USER_ROLES.includes(role)) {
      throw new ApiError(400, "Invalid or missing role");
    }

    if (req.user.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "Only Super Admin can change roles");
    }
    if (!req.user.businessName) {
      throw new ApiError(403, "A business scope is required to manage employees");
    }

    const persistedUser = await withUserManagementLock(
      req.user.businessName,
      async () => {
        const session = await mongoose.startSession();
        let updatedUser;
        try {
          await session.withTransaction(async () => {
            const targetUser = await User.findOne({
              _id: id,
              businessName: req.user.businessName,
              deletedAt: null,
            }).session(session);
            if (!targetUser) {
              throw new ApiError(404, "Employee not found");
            }

            if (targetUser.role === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
              await assertNotLastActiveSuperAdmin(targetUser, session);
            }

            const previousRole = targetUser.role;
            updatedUser = await User.findOneAndUpdate(
              {
                _id: targetUser._id,
                businessName: req.user.businessName,
                role: previousRole,
                accountStatus: targetUser.accountStatus,
                deletedAt: null,
              },
              { $set: { role } },
              { new: true, runValidators: true, session },
            )
              .select("_id fullName email role")
              .lean();
            if (!updatedUser) {
              throw new ApiError(
                409,
                "Employee changed during role update; refresh and try again",
              );
            }

            await recordRbacAudit({
              actor: req.user,
              action: "user.role.updated",
              targetType: "user",
              targetUser: updatedUser._id,
              changes: { role: { from: previousRole, to: role } },
              session,
            });
          });
        } finally {
          await session.endSession();
        }

        return updatedUser;
      },
    );

    return res.status(200).json({
      success: true,
      message: "Role updated successfully",
      data: {
        _id: persistedUser._id,
        fullName: persistedUser.fullName,
        email: persistedUser.email,
        role: persistedUser.role,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to update role",
      error: error.message,
    });
  }
};

export const getAllEmployees = asyncHandler(async (req, res) => {
  const requester = req.user;

  if (requester.role !== "SUPER_ADMIN") {
    throw new ApiError(403, "Only Super Admin can view employees");
  }
  if (!requester.businessName) {
    throw new ApiError(403, "A business scope is required to view employees");
  }

  // Scope to the same business, exclude the requester themself and soft-deleted users
  const employees = await User.find({
    businessName: requester.businessName,
    _id: { $ne: requester._id },
    deletedAt: null,
  })
    .select("fullName email mobileNumber role accountStatus createdAt")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    message: "Employees fetched successfully",
    data: employees,
  });
});