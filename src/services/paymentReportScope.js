import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";

// Reporting is an internal admin module with one deployment-owned target.
// Authentication and admin authorization run at every route. User membership,
// user IDs and request parameters can never override this company.
export function resolvePaymentReportScope(_user, configuration = process.env.PAYMENTS_REPORT_COMPANY_ID) {
  if (typeof configuration !== "string" || configuration.length !== 24 || !/^[a-f\d]{24}$/i.test(configuration) || !mongoose.isValidObjectId(configuration)) {
    throw new ApiError(503, "Invalid payments report company configuration. Configure PAYMENTS_REPORT_COMPANY_ID on the backend.");
  }
  return { company: new mongoose.Types.ObjectId(configuration), source: "configured" };
}
