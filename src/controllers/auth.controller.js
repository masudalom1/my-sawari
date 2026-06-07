import User from "../models/user.model.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import {
  validateLoginInput,
  validateRegisterInput,
} from "../utils/validators.js";
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  cookieOptions,
} from "../services/token.service.js";

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

export const registerUser = asyncHandler(async (req, res) => {
  validateRegisterInput(req.body);

  const {
    fullName,
    mobileNumber,
    email,
    businessName,
    password,
    role,
  } = req.body;

  const existingUser = await User.findOne({
    $or: [
      { email: email.toLowerCase() },
      { mobileNumber },
    ],
  });

  if (existingUser) {
    if (existingUser.email === email.toLowerCase()) {
      throw new ApiError(409, "Email already registered");
    }

    if (existingUser.mobileNumber === mobileNumber) {
      throw new ApiError(409, "Mobile number already registered");
    }
  }

  const user = await User.create({
    fullName,
    mobileNumber,
    email: email.toLowerCase(),
    businessName,
    password,
    role,
  });

  await sendAuthResponse(user, res, 201);
});

export const createEmployee = asyncHandler(async (req, res) => {
  const superAdmin = req.user;

  if (superAdmin.role !== "SUPER_ADMIN") {
    throw new ApiError(
      403,
      "Only Super Admin can create employees"
    );
  }

  const {
    fullName,
    mobileNumber,
    email,
    password,
    role,
  } = req.body;

  if (
    !fullName ||
    !mobileNumber ||
    !email ||
    !password ||
    !role
  ) {
    throw new ApiError(
      400,
      "All fields are required"
    );
  }

  const existingUser = await User.findOne({
    $or: [
      { email: email.toLowerCase() },
      { mobileNumber },
    ],
  });

  if (existingUser) {
    if (existingUser.email === email.toLowerCase()) {
      throw new ApiError(
        409,
        "Email already registered"
      );
    }

    if (
      existingUser.mobileNumber === mobileNumber
    ) {
      throw new ApiError(
        409,
        "Mobile number already registered"
      );
    }
  }

  const employee = await User.create({
    fullName,
    mobileNumber,
    email: email.toLowerCase(),
    businessName:
      superAdmin.businessName,
    password,
    role,
    createdBy: superAdmin._id,
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