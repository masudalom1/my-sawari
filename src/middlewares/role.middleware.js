import ApiError from "../utils/ApiError.js";

const allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, "Unauthorized");
    }

    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, "Access forbidden");
    }

    next();
  };
};

export default allowRoles;