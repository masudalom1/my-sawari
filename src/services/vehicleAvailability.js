import Vehicle from "../models/vehicle.model.js";
import {
  isBlockedByVehicleDeactivation,
  vehicleDeactivatedResponse,
} from "../../shared/vehicleDeactivation.mjs";

// A failure whose JSON body is sent as-is (with `code` and conflict details).
export class VehicleAvailabilityError extends Error {
  constructor(statusCode, body) {
    super(body.message);
    this.statusCode = statusCode;
    this.responseBody = body;
  }
}

export function sendVehicleAvailabilityError(res, error) {
  if (!(error instanceof VehicleAvailabilityError)) return false;
  res.status(error.statusCode).json(error.responseBody);
  return true;
}

// Throws 409 VEHICLE_DEACTIVATED when an interval ending at `intervalEnd`
// runs into the vehicle's blocked period.
export function assertBookableUntil(vehicle, intervalEnd) {
  if (isBlockedByVehicleDeactivation(vehicle, intervalEnd)) {
    throw new VehicleAvailabilityError(409, vehicleDeactivatedResponse(vehicle));
  }
}

// The app's booking-availability lock. Booking creation, rescheduling,
// rental extensions and vehicle exchanges, and deactivation all bump the
// vehicle's bookingAvailabilityVersion inside their transaction before
// checking availability, so two of them for one vehicle cannot both commit
// on stale reads: MongoDB rejects the second write as a write conflict and
// the transaction retries against the committed state.
export async function lockVehicleAvailability(vehicleId, session) {
  return Vehicle.findOneAndUpdate(
    { _id: vehicleId, isDeleted: false },
    { $inc: { bookingAvailabilityVersion: 1 } },
    { session, new: true, projection: { deactivation: 1, status: 1 } },
  ).lean();
}

// Runs `work(session, lockedVehicle)` in a transaction holding the lock.
// Mongoose resets documents saved inside `work` if the transaction retries.
export async function withVehicleAvailabilityLock(vehicleId, work) {
  let result;
  await Vehicle.db.transaction(async (session) => {
    const vehicle = await lockVehicleAvailability(vehicleId, session);
    if (!vehicle) {
      throw new VehicleAvailabilityError(404, {
        success: false,
        message: "Vehicle not found.",
      });
    }
    result = await work(session, vehicle);
  });
  return result;
}
