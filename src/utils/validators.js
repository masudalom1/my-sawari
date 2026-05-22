import ApiError from "./ApiError.js";
import { USER_ROLES } from "../models/user.model.js";

export const validateRegisterInput = (data) => {
  const {
    fullName,
    mobileNumber,
    email,
    businessName,
    password,
    confirmPassword,
    role,
  } = data;

  if (
    !fullName ||
    !mobileNumber ||
    !email ||
    !businessName ||
    !password ||
    !confirmPassword ||
    !role
  ) {
    throw new ApiError(400, "All fields are required");
  }

  if (password !== confirmPassword) {
    throw new ApiError(400, "Passwords do not match");
  }

  if (password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters");
  }

  if (!/[A-Z]/.test(password)) {
    throw new ApiError(400, "Password must contain uppercase letter");
  }

  if (!/[0-9]/.test(password)) {
    throw new ApiError(400, "Password must contain a number");
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new ApiError(400, "Password must contain special character");
  }

  if (!USER_ROLES.includes(role)) {
    throw new ApiError(400, "Invalid role selected");
  }
};

export const validateLoginInput = (data) => {
  const { emailOrMobile, password } = data;

  if (!emailOrMobile || !password) {
    throw new ApiError(400, "Email/mobile and password required");
  }
};