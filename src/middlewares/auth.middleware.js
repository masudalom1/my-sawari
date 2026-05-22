import User from "../models/user.model.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { verifyAccessToken } from "../services/token.service.js";

const authMiddleware = asyncHandler(async (req, res, next) => {
  let token = null;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token && req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }

  if (!token) {
    throw new ApiError(401, "Authentication required");
  }

  let decoded;

  try {
    decoded = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, "Invalid or expired token");
  }

  const user = await User.findById(decoded.userId);

  if (!user) {
    throw new ApiError(401, "User not found");
  }

  if (user.accountStatus !== "ACTIVE") {
    throw new ApiError(403, "Account access denied");
  }

  if (user.deletedAt) {
    throw new ApiError(403, "Account deleted");
  }

  req.user = user;

  next();
});

export default authMiddleware;