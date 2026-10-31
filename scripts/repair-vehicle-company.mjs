// One-time repair: vehicles registered by an employee were stamped with
// company = employee id, but every booking read scopes vehicles by the
// owner's company (req.user.company || req.user.createdBy || req.user._id).
// Re-stamps those vehicles to the owner. Only the `company` field changes.
//
//   node scripts/repair-vehicle-company.mjs          # dry run (default)
//   node scripts/repair-vehicle-company.mjs --apply  # write changes

import "dotenv/config";
import mongoose from "mongoose";

const apply = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const stampedCompanies = await db.collection("vehicles").distinct("company");
const employees = await db.collection("users")
  .find(
    { _id: { $in: stampedCompanies }, createdBy: { $ne: null } },
    { projection: { company: 1, createdBy: 1 } },
  )
  .toArray();

let total = 0;
for (const employee of employees) {
  const owner = employee.company || employee.createdBy;
  if (String(owner) === String(employee._id)) continue;
  const filter = { company: employee._id };
  const count = await db.collection("vehicles").countDocuments(filter);
  console.log(`${apply ? "Moving" : "Would move"} ${count} vehicle(s): company ${employee._id} -> ${owner}`);
  if (apply) await db.collection("vehicles").updateMany(filter, { $set: { company: owner } });
  total += count;
}

console.log(`${apply ? "Updated" : "Dry run:"} ${total} vehicle(s).${apply ? "" : " Re-run with --apply to write."}`);
await mongoose.disconnect();
