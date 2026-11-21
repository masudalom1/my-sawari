import mongoose from "mongoose";

const apiActivityLogSchema = new mongoose.Schema(
  {},
  {
    collection: "apiactivitylogs",
    strict: false,
    versionKey: false,
  },
);

const ApiActivityLog =
  mongoose.models.ApiActivityLog ||
  mongoose.model("ApiActivityLog", apiActivityLogSchema);

export default ApiActivityLog;
