import mongoose from "mongoose";
import fs from "fs/promises";
import cloudinary from "../config/cloudinary.js";
import Vehicle from "../models/vehicle.model.js";
import Maintenance from "../models/maintenance.model.js";
import Booking from "../models/booking.model.js";
import Handover from "../models/handover.model.js";
import { bookingTimestamp } from "../../shared/bookingDuration.mjs";
import {
  DEACTIVATION_NOTES_MAX_LENGTH,
  deactivationBlockStart,
  deactivationDateLabel,
  isBlockedByVehicleDeactivation,
  isDeactivationReason,
  vehicleDeactivationDate,
} from "../../shared/vehicleDeactivation.mjs";
import {
  sendVehicleAvailabilityError,
  VehicleAvailabilityError,
  withVehicleAvailabilityLock,
} from "../services/vehicleAvailability.js";
import { currentIndiaDate } from "../utils/indiaDateRange.js";

const parseDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const normalizeVehicleStatusInput = (status) => {
  const value = String(status || "").trim().toLowerCase();
  if (
    value === "service" ||
    value === "in_service" ||
    value === "in service" ||
    value === "maintenance" ||
    value === "under_maintenance" ||
    value === "under maintenance" ||
    value === "in maintenance"
  ) {
    return "service";
  }
  if (value === "available" || value === "rent") return value;
  return null;
};

/**
 * Close ongoing maintenance jobs when a vehicle transitions out of service to available.
 * Guards missing or malformed startDate and preserves future Scheduled maintenance blocks.
 */
const completeActiveMaintenancesForVehicle = async (vehicle, userId, now = new Date()) => {
  const currentMaintenanceId = vehicle.maintenance?.currentMaintenance
    ? String(vehicle.maintenance.currentMaintenance)
    : null;

  if (vehicle.maintenance) {
    vehicle.maintenance.required = false;
    vehicle.maintenance.currentMaintenance = null;
  }

  const activeMaintenances = await Maintenance.find({
    vehicle: vehicle._id,
    status: { $in: ["Scheduled", "In Progress"] },
    isDeleted: false,
  });

  for (const m of activeMaintenances) {
    const existingStart = parseDate(m.startDate);
    if (
      m.status === "Scheduled" &&
      existingStart &&
      existingStart > now &&
      String(m._id) !== currentMaintenanceId
    ) {
      continue;
    }

    const validStart = existingStart || parseDate(m.createdAt) || now;
    if (!existingStart) {
      m.startDate = validStart;
    }

    m.status = "Completed";
    m.completedDate = now;
    m.endDate = now > validStart ? now : new Date(validStart.getTime() + 60_000);
    if (!m.completionProof?.note) {
      m.completionProof = {
        ...(m.completionProof || {}),
        note: "Vehicle marked as Available",
      };
    }
    if (!Array.isArray(m.statusHistory)) {
      m.statusHistory = [];
    }
    m.statusHistory.push({
      status: "Completed",
      changedBy: userId,
      note: "Vehicle marked as Available",
      changedAt: now,
    });
    await m.save();
  }
};

// add vehicle screen
const CAR_VEHICLE_TYPES = [
  "SUV",
  "Sedan",
  "Hatchback",
  "Luxury",
  "Tempo Traveller",
  "Mini Bus",
  "Bus",
];
const OPTIONAL_VEHICLE_DATES = [
  "registrationDate",
  "insuranceValidUpto",
  "pucValidUpto",
  "fitnessValidUpto",
];

function parseOptionalVehicleDate(value) {
  if (value === undefined || value === null || value === "") {
    return { valid: true, value: null };
  }
  if (typeof value !== "string") return { valid: false, value: null };

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { valid: false, value: null };
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value: parsed };
}

async function cleanupUploadedVehicleImages(files) {
  const uploaded = files.filter((file) => file.filename);
  const results = await Promise.allSettled(
    uploaded.map(
      (file) =>
        new Promise((resolve, reject) => {
          cloudinary.uploader.destroy(
            file.filename,
            { resource_type: "image" },
            (error, result) => {
              if (error) reject(error);
              else if (result?.result === "error") {
                reject(new Error("Cloudinary did not delete the uploaded image"));
              } else resolve(result);
            },
          );
        }),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `Failed to clean up uploaded vehicle image ${uploaded[index].filename}:`,
        result.reason,
      );
    }
  });
}

export const createVehicle = async (req, res, next) => {
  const uploadedFiles = req.files || [];
  let persisted = false;

  try {
    // Same scope booking reads use: an employee's vehicles belong to the
    // owner who created them, otherwise New Booking can never select them.
    const companyId = req.user.company || req.user.createdBy || req.user._id;

    const {
      vehicleName,
      displayName,
      vehicleNumber,
      manufacturer,
      model,
      variant,
      modelYear,
      pricePerDay,
      category,
      vehicleType,
      fuelType,
      transmission,
      seatingCapacity,
      color,
      chassisNumber,
      engineNumber,
      notes,
      status,
    } = req.body;

    const normalizedVehicleNumber =
      typeof vehicleNumber === "string" ? vehicleNumber.trim().toUpperCase() : "";
    if (!normalizedVehicleNumber) {
      return res.status(400).json({
        success: false,
        message: "Vehicle number is required",
        fieldErrors: { vehicleNumber: "Vehicle number is required." },
      });
    }

    const normalizedCategory =
      typeof category === "string" && category.trim()
        ? category.trim().toLowerCase()
        : undefined;
    const fieldErrors = {};
    if (category !== undefined && category !== null) {
      if (typeof category !== "string" || !["bike", "car"].includes(normalizedCategory)) {
        fieldErrors.category = "Category must be Car or Bike.";
      }
    }

    let normalizedVehicleType;
    if (vehicleType !== undefined && vehicleType !== null && vehicleType !== "") {
      if (typeof vehicleType !== "string" || normalizedCategory !== "car") {
        fieldErrors.vehicleType = "Vehicle Type is only valid for cars.";
      } else {
        normalizedVehicleType = CAR_VEHICLE_TYPES.find(
          (type) => type.toLowerCase() === vehicleType.trim().toLowerCase(),
        );
        if (!normalizedVehicleType) {
          fieldErrors.vehicleType = `Vehicle Type must be one of: ${CAR_VEHICLE_TYPES.join(", ")}.`;
        }
      }
    } else if (normalizedCategory === "car") {
      fieldErrors.vehicleType = "Vehicle Type is required for cars.";
    }

    const normalizedSeatingCapacity = Number(seatingCapacity);
    if (
      seatingCapacity === undefined ||
      seatingCapacity === null ||
      String(seatingCapacity).trim() === "" ||
      !Number.isInteger(normalizedSeatingCapacity) ||
      normalizedSeatingCapacity < 1
    ) {
      fieldErrors.seatingCapacity = "Seating Capacity must be a whole number of at least 1.";
    }

    const normalizedPricePerDay =
      pricePerDay === undefined || pricePerDay === null || String(pricePerDay).trim() === ""
        ? 0
        : Number(pricePerDay);
    if (!Number.isFinite(normalizedPricePerDay) || normalizedPricePerDay < 0) {
      fieldErrors.pricePerDay = "Price per Day must be a nonnegative number.";
    }

    const normalizedModelYear =
      modelYear === undefined || modelYear === null || String(modelYear).trim() === ""
        ? null
        : Number(modelYear);
    if (
      normalizedModelYear !== null &&
      (!Number.isInteger(normalizedModelYear) ||
        normalizedModelYear < 1886 ||
        normalizedModelYear > 2100)
    ) {
      fieldErrors.modelYear = "Model Year must be a whole number between 1886 and 2100.";
    }

    const normalizedDates = {};
    for (const field of OPTIONAL_VEHICLE_DATES) {
      const parsed = parseOptionalVehicleDate(req.body[field]);
      if (!parsed.valid) fieldErrors[field] = `${field} must be a valid date.`;
      normalizedDates[field] = parsed.value;
    }

    if (
      displayName !== undefined &&
      displayName !== null &&
      String(displayName).trim().length > 100
    ) {
      fieldErrors.displayName = "Display Name cannot exceed 100 characters.";
    }
    if (notes !== undefined && notes !== null && String(notes).trim().length > 500) {
      fieldErrors.notes = "Notes cannot exceed 500 characters.";
    }

    if (status && status !== "available") {
      fieldErrors.status = ["rent", "service"].includes(status)
        ? "On Rent is set by a booking handover; Under Service is set through maintenance."
        : "Status must be available.";
    }
    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({
        success: false,
        message: "Please correct the highlighted fields.",
        fieldErrors,
      });
    }

    const existingVehicle = await Vehicle.findOne({
      vehicleNumber: normalizedVehicleNumber,
      isDeleted: false,
    });

    if (existingVehicle) {
      return res.status(400).json({
        success: false,
        message: "Vehicle with this number already exists",
        fieldErrors: {
          vehicleNumber: "A vehicle with this number already exists.",
        },
      });
    }

    const images = uploadedFiles.map((file) => ({
      url: file.path,
      publicId: file.filename,
    }));

    const vehicle = await Vehicle.create({
      company: companyId,
      createdBy: req.user._id,
      vehicleName,
      displayName: displayName || "",
      vehicleNumber: normalizedVehicleNumber,
      manufacturer,
      model,
      variant,
      modelYear: normalizedModelYear,
      pricePerDay: normalizedPricePerDay,
      category: normalizedCategory,
      vehicleType: normalizedVehicleType,
      fuelType,
      transmission,
      seatingCapacity: normalizedSeatingCapacity,
      color,
      chassisNumber,
      engineNumber,
      registrationDate: normalizedDates.registrationDate,
      insuranceValidUpto: normalizedDates.insuranceValidUpto,
      pucValidUpto: normalizedDates.pucValidUpto,
      fitnessValidUpto: normalizedDates.fitnessValidUpto,
      notes,
      status: "available",
      images,
    });
    persisted = true;

    res.status(201).json({
      success: true,
      message: "Vehicle added successfully",
      data: vehicle,
    });
  } catch (error) {
    if (sendVehicleSaveError(res, error)) return;
    return next(error);
  } finally {
    if (!persisted) await cleanupUploadedVehicleImages(uploadedFiles);
  }
};

// Schema and duplicate-number failures become per-field errors the vehicle
// form can show. Returns false for anything else.
function sendVehicleSaveError(res, error) {
  if (error instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      success: false,
      message: "Please correct the highlighted fields.",
      fieldErrors: Object.fromEntries(
        Object.entries(error.errors).map(([field, detail]) => [
          field,
          detail.message,
        ]),
      ),
    });
    return true;
  }
  if (
    error?.code === 11000 &&
    (error.keyPattern?.vehicleNumber ||
      error.keyValue?.vehicleNumber ||
      String(error.message).includes("vehicleNumber"))
  ) {
    res.status(400).json({
      success: false,
      message: "A vehicle with this number already exists.",
      fieldErrors: {
        vehicleNumber: "A vehicle with this number already exists.",
      },
    });
    return true;
  }
  return false;
}
// manage vehicle page v1.0
export const getAllVehicle = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    // Default limit brought down from 1000 to 20 — 1000 meant this
    // endpoint was never really paginating, just quietly capping itself.
    // A real page size lets the list start rendering fast regardless of
    // fleet size, with more loaded on scroll.
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 100);
    const skip = (page - 1) * limit;
    const filters = { isDeleted: false };

    if (req.query.status && req.query.status !== "All") {
      filters.status = req.query.status;
    }

    // Search now happens in the query, not by downloading every vehicle
    // and running .filter() in the app. Escaped so special regex
    // characters in a plate number ("MH-12...") can't break the match.
    if (req.query.search) {
      const term = req.query.search.trim();
      if (term) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "i");
        filters.$or = [{ vehicleName: regex }, { vehicleNumber: regex }];
      }
    }

    const [vehicles, total, stats] = await Promise.all([
      Vehicle.find(filters)
        // Only the fields the fleet-list card actually renders, plus
        // just the FIRST image (the list only ever shows one cover
        // photo per card) instead of the full images array.
        .select({
          vehicleName: 1,
          vehicleNumber: 1,
          fuelType: 1,
          transmission: 1,
          seatingCapacity: 1,
          status: 1,
          registrationDate: 1,
          pricePerDay: 1,
          images: { $slice: 1 },
          createdAt: 1,
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      // Count respects the same filters, so pagination math (hasMore /
      // pages) is correct for whatever search/status the user has active.
      Vehicle.countDocuments(filters),

      // Stat cards are intentionally fleet-WIDE and unfiltered — they
      // always reflect the whole fleet regardless of which tab/search
      // is active, matching what the four cards at the top mean to show.
      Vehicle.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasMore: page * limit < total,
      stats,
      data: vehicles,
    });
  } catch (error) {
    next(error);
  }
};
// The Fleet Manager filter value for deactivated vehicles.
const DEACTIVATED_FILTER = "deactivated";
// A vehicle counts as deactivated once a deactivation date is saved.
const IS_DEACTIVATED = { $ne: [{ $ifNull: ["$deactivation.date", null] }, null] };
// Names for the audit details the Deactivated list shows.
const AUDIT_USER_FIELDS = [
  { path: "createdBy", select: "fullName" },
  { path: "deactivation.deactivatedBy", select: "fullName" },
];

// v1.1
export const getAllVehicles = (req, res, next) =>
  listFleetVehicles(req, res, next, { separateDeactivated: false });

// Fleet Manager: deactivated vehicles form their own count and filter and are
// left out of the Available / On Rent / Service counts and lists. Total still
// covers every vehicle that has not been removed.
export const getFleetManagerVehicles = (req, res, next) =>
  listFleetVehicles(req, res, next, { separateDeactivated: true });

async function listFleetVehicles(req, res, next, { separateDeactivated }) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    // Default limit brought down from 1000 to 20 — 1000 meant this
    // endpoint was never really paginating, just quietly capping itself.
    // A real page size lets the list start rendering fast regardless of
    // fleet size, with more loaded on scroll.
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 100);
    const skip = (page - 1) * limit;
    const filters = { isDeleted: false };

    const status = req.query.status;
    const statusSelected = Boolean(status) && status !== "All" && status !== "all";
    const deactivatedView = separateDeactivated && status === DEACTIVATED_FILTER;
    if (deactivatedView) {
      filters["deactivation.date"] = { $ne: null };
    } else if (statusSelected) {
      filters.status = status;
      // `null` also matches vehicles saved before deactivation existed.
      if (separateDeactivated) filters["deactivation.date"] = null;
    }

    // NEW: optional category filter (car / bike). Only applied when a
    // caller explicitly sends it, so existing screens hitting this same
    // controller without a category param behave exactly as before.
    if (req.query.category && !["All", "all"].includes(req.query.category)) {
      const categoryTerm = String(req.query.category).trim();
      if (categoryTerm) {
        // Case-insensitive exact match so "Car"/"car"/"CAR" all work
        // regardless of how it's stored in the DB. Escaped so the value is
        // matched literally, never run as a pattern.
        const escapedCategory = categoryTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filters.category = new RegExp(`^${escapedCategory}$`, "i");
      }
    }

    // Search now happens in the query, not by downloading every vehicle
    // and running .filter() in the app. Escaped so special regex
    // characters in a plate number ("MH-12...") can't break the match.
    if (req.query.search) {
      const term = req.query.search.trim();
      if (term) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "i");
        filters.$or = [
          { vehicleName: regex },
          { displayName: regex },
          { vehicleNumber: regex },
          // Fleet Manager also finds vehicles by brand and model.
          ...(separateDeactivated ? [{ manufacturer: regex }, { model: regex }] : []),
        ];
      }
    }

    const listQuery = Vehicle.find(filters);
    // The Deactivated view also shows who created and deactivated each
    // vehicle and when it last changed.
    if (deactivatedView) listQuery.populate(AUDIT_USER_FIELDS);

    const [vehicles, total, stats] = await Promise.all([
      listQuery
        // Only the fields the fleet-list card actually renders, plus
        // just the FIRST image (the list only ever shows one cover
        // photo per card) instead of the full images array.
        .select({
          vehicleName: 1,
          displayName: 1,
          vehicleNumber: 1,
          fuelType: 1,
          transmission: 1,
          seatingCapacity: 1,
          status: 1,
          category: 1,
          registrationDate: 1,
          pricePerDay: 1,
          deactivation: 1,
          images: { $slice: 1 },
          createdAt: 1,
          ...(deactivatedView ? { createdBy: 1, updatedAt: 1 } : {}),
        })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      // Count respects the same filters, so pagination math (hasMore /
      // pages) is correct for whatever search/status/category the user
      // has active.
      Vehicle.countDocuments(filters),

      // Stat cards are intentionally fleet-WIDE and unfiltered — they
      // always reflect the whole fleet regardless of which tab/search
      // is active, matching what the four cards at the top mean to show.
      Vehicle.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: separateDeactivated
              ? { $cond: [IS_DEACTIVATED, DEACTIVATED_FILTER, "$status"] }
              : "$status",
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    res.status(200).json({
      success: true,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasMore: page * limit < total,
      stats,
      data: vehicles,
    });
  } catch (error) {
    next(error);
  }
}

export const getAvailableVehicles = async (req, res, next) => {
  try {
    const { fromDate, toDate, pickupTime, dropTime } = req.query;

    let conflictingVehicleIds = new Set();
    // Without a valid range, "available" means available right now.
    let deactivationCheckEnd = Date.now();
    if (fromDate && toDate) {
      const requestedStart = bookingTimestamp(fromDate, pickupTime || "08:00 AM");
      const requestedEnd = bookingTimestamp(toDate, dropTime || "08:00 AM");

      if (!isNaN(requestedStart) && !isNaN(requestedEnd) && requestedEnd > requestedStart) {
        deactivationCheckEnd = requestedEnd;
        const overlappingBookings = await Booking.find({
          isDeleted: false,
          status: { $nin: ["cancelled", "completed", "returned"] },
        })
          .select("vehicleId fromDate toDate pickupTime dropTime")
          .lean();

        for (const b of overlappingBookings) {
          if (!b.vehicleId) continue;
          const bStart = bookingTimestamp(b.fromDate, b.pickupTime || "08:00 AM");
          const bEnd = bookingTimestamp(b.toDate, b.dropTime || "08:00 AM");
          if (!isNaN(bStart) && !isNaN(bEnd) && bStart < requestedEnd && bEnd > requestedStart) {
            conflictingVehicleIds.add(String(b.vehicleId));
          }
        }
      }
    }

    const query = {
      isDeleted: false,
      status: { $nin: ["service", "maintenance"] },
    };

    if (conflictingVehicleIds.size > 0) {
      query._id = { $nin: Array.from(conflictingVehicleIds).map((id) => new mongoose.Types.ObjectId(id)) };
    } else if (!fromDate || !toDate) {
      query.status = "available";
    }

    const vehicles = await Vehicle.find(query)
      .select(
        `
        _id
        vehicleName
        vehicleNumber
        manufacturer
        model
        variant
        color
        vehicleType
        seatingCapacity
        transmission
        fuelType
        pricePerDay
        status
        deactivation
      `,
      )
      .sort({ vehicleName: 1 })
      .lean();

    const data = vehicles
      .filter(
        (vehicle) => !isBlockedByVehicleDeactivation(vehicle, deactivationCheckEnd),
      )
      .map((vehicle) => ({
        ...vehicle,

        pricing: {
          pricePerDay: vehicle.pricePerDay || 0,
          currency: "INR",
        },
      }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
};
export const getAll = async (req, res, next) => {
  try {
    const vehicles = await Vehicle.find({
      isDeleted: false,
    })
      .select(
        `
        _id
        vehicleName
        vehicleNumber
        manufacturer
        model
        variant
        color
        vehicleType
        seatingCapacity
        transmission
        fuelType
        pricePerDay
        status
      `,
      )
      .sort({ vehicleName: 1 })
      .lean();

    const data = vehicles.map((vehicle) => ({
      ...vehicle,

      pricing: {
        pricePerDay: vehicle.pricePerDay || 0,
        currency: "INR",
      },
    }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getSingleVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findOne({
      _id: req.params.id,
      isDeleted: false,
    });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: vehicle,
    });
  } catch (error) {
    next(error);
  }
};

const DISPLAY_NAME_MAX_LENGTH = 100;
const MAX_VEHICLE_IMAGES = 5;
const UPDATABLE_TEXT_FIELDS = [
  "vehicleName",
  "manufacturer",
  "model",
  "variant",
  "fuelType",
  "transmission",
  "color",
  "chassisNumber",
  "engineNumber",
  "notes",
];
const REQUIRED_TEXT_FIELDS = {
  vehicleName: "Vehicle name is required.",
  manufacturer: "Manufacturer is required.",
  fuelType: "Fuel type is required.",
  transmission: "Transmission is required.",
};

const isBlank = (value) =>
  value === undefined || value === null || String(value).trim() === "";

// Partial update: only fields present in the body are validated and saved.
// An empty optional field clears it, so the Fleet Manager form can send the
// whole form back.
export const updateVehicle = async (req, res, next) => {
  const uploadedFiles = req.files || [];
  let persisted = false;

  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vehicle id.",
      });
    }

    // Unified fleet: the clicked vehicle by _id, whichever company it carries.
    const vehicle = await Vehicle.findById(req.params.id);

    if (!vehicle || vehicle.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    const body = req.body || {};
    const has = (field) => body[field] !== undefined;
    const updates = {};
    const fieldErrors = {};

    for (const field of UPDATABLE_TEXT_FIELDS) {
      if (has(field)) updates[field] = body[field] === null ? "" : String(body[field]).trim();
    }
    for (const [field, message] of Object.entries(REQUIRED_TEXT_FIELDS)) {
      if (has(field) && !updates[field]) fieldErrors[field] = message;
    }
    if ((updates.notes || "").length > 500) {
      fieldErrors.notes = "Notes cannot exceed 500 characters.";
    }

    if (has("displayName")) {
      const displayName = body.displayName === null ? "" : String(body.displayName).trim();
      if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
        fieldErrors.displayName = `Display name cannot exceed ${DISPLAY_NAME_MAX_LENGTH} characters.`;
      } else {
        updates.displayName = displayName;
      }
    }

    if (has("vehicleNumber")) {
      const vehicleNumber =
        typeof body.vehicleNumber === "string" ? body.vehicleNumber.trim().toUpperCase() : "";
      if (!vehicleNumber) fieldErrors.vehicleNumber = "Vehicle number is required.";
      else updates.vehicleNumber = vehicleNumber;
    }

    let category = vehicle.category;
    if (has("category")) {
      const normalized = isBlank(body.category) ? "" : String(body.category).trim().toLowerCase();
      if (!["bike", "car"].includes(normalized)) {
        fieldErrors.category = "Category must be Car or Bike.";
      } else {
        category = normalized;
        updates.category = normalized;
      }
    }

    // Vehicle type is a car body type: required for cars, cleared for bikes.
    let clearVehicleType = false;
    if (category === "car") {
      if (has("vehicleType")) {
        const vehicleType = CAR_VEHICLE_TYPES.find(
          (type) => type.toLowerCase() === String(body.vehicleType ?? "").trim().toLowerCase(),
        );
        if (vehicleType) updates.vehicleType = vehicleType;
        else {
          fieldErrors.vehicleType = isBlank(body.vehicleType)
            ? "Vehicle type is required for cars."
            : `Vehicle type must be one of: ${CAR_VEHICLE_TYPES.join(", ")}.`;
        }
      } else if (!vehicle.vehicleType) {
        fieldErrors.vehicleType = "Vehicle type is required for cars.";
      }
    } else if (has("vehicleType")) {
      if (isBlank(body.vehicleType)) clearVehicleType = true;
      else fieldErrors.vehicleType = "Vehicle type only applies to cars.";
    } else if (updates.category === "bike" && vehicle.vehicleType) {
      clearVehicleType = true;
    }

    if (has("pricePerDay")) {
      const price = isBlank(body.pricePerDay) ? 0 : Number(body.pricePerDay);
      if (!Number.isFinite(price) || price < 0) {
        fieldErrors.pricePerDay = "Price per day must be zero or more.";
      } else {
        updates.pricePerDay = price;
      }
    }

    if (has("modelYear")) {
      const modelYear = isBlank(body.modelYear) ? null : Number(body.modelYear);
      if (
        modelYear !== null &&
        (!Number.isInteger(modelYear) || modelYear < 1886 || modelYear > 2100)
      ) {
        fieldErrors.modelYear = "Model year must be a whole number between 1886 and 2100.";
      } else {
        updates.modelYear = modelYear;
      }
    }

    if (has("seatingCapacity")) {
      const seats = isBlank(body.seatingCapacity) ? NaN : Number(body.seatingCapacity);
      if (!Number.isInteger(seats) || seats < 1) {
        fieldErrors.seatingCapacity = "Seating capacity must be a whole number of at least 1.";
      } else {
        updates.seatingCapacity = seats;
      }
    }

    for (const field of OPTIONAL_VEHICLE_DATES) {
      if (!has(field)) continue;
      const parsed = parseOptionalVehicleDate(body[field]);
      if (parsed.valid) updates[field] = parsed.value;
      else fieldErrors[field] = "Enter a valid date.";
    }

    if (has("status") && !normalizeVehicleStatusInput(body.status)) {
      fieldErrors.status = "Status must be available, rent, or service";
    }

    if (vehicle.images.length + uploadedFiles.length > MAX_VEHICLE_IMAGES) {
      fieldErrors.images = `A vehicle can have up to ${MAX_VEHICLE_IMAGES} photos.`;
    }

    if (
      updates.vehicleNumber &&
      updates.vehicleNumber !== vehicle.vehicleNumber &&
      (await Vehicle.exists({
        _id: { $ne: vehicle._id },
        vehicleNumber: updates.vehicleNumber,
        isDeleted: false,
      }))
    ) {
      fieldErrors.vehicleNumber = "A vehicle with this number already exists.";
    }

    const errorMessages = Object.values(fieldErrors);
    if (errorMessages.length) {
      return res.status(400).json({
        success: false,
        message:
          errorMessages.length === 1
            ? errorMessages[0]
            : "Please correct the highlighted fields.",
        fieldErrors,
      });
    }

    vehicle.set(updates);
    if (clearVehicleType) vehicle.vehicleType = undefined;

    // -----------------------------------------
    // Status
    // -----------------------------------------
    // Validated above. Only auto-complete active maintenance when the status
    // actually changes out of service/maintenance into "available".
    if (has("status")) {
      const incomingStatus = normalizeVehicleStatusInput(body.status);
      const previousStatus = normalizeVehicleStatusInput(vehicle.status);
      const wasInMaintenance =
        previousStatus === "service" ||
        Boolean(vehicle.maintenance?.required || vehicle.maintenance?.currentMaintenance);

      vehicle.status = incomingStatus;
      if (
        incomingStatus === "available" &&
        previousStatus !== "available" &&
        wasInMaintenance
      ) {
        await completeActiveMaintenancesForVehicle(vehicle, req.user?._id);
      }
    }

    // New photos are appended and stored on Cloudinary, like Add Vehicle's.
    vehicle.images.push(
      ...uploadedFiles.map((file) => ({ url: file.path, publicId: file.filename })),
    );

    await vehicle.save();
    persisted = true;

    return res.status(200).json({
      success: true,
      message: "Vehicle updated successfully",
      data: vehicle,
    });
  } catch (error) {
    if (sendVehicleSaveError(res, error)) return;
    return next(error);
  } finally {
    if (!persisted) await cleanupUploadedVehicleImages(uploadedFiles);
  }
};

export const deleteVehicle = async (req, res, next) => {
  try {
    if (req.user.role !== "SUPER_ADMIN") {
      return res.status(403).json({
        success: false,
        message:
          "Only Super Admin can delete vehicles. Please contact your administrator.",
      });
    }

    const vehicle = await Vehicle.findOne({
      _id: req.params.id,
      isDeleted: false,
    });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    await Vehicle.updateOne(
      { _id: vehicle._id },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );

    return res.status(200).json({
      success: true,
      message: "Vehicle deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// Bookings that still hold the vehicle; same statuses booking creation checks.
const ACTIVE_BOOKING_STATUS_FILTER = { $nin: ["cancelled", "completed"] };
const LISTED_DEACTIVATION_CONFLICTS = 10;

function conflictFromBooking(booking) {
  return {
    kind: "booking",
    bookingId: booking._id,
    bookingCode: booking.bookingCode || null,
    customerName: booking.customerName || "",
    fromDate: booking.fromDate,
    toDate: booking.toDate,
    pickupTime: booking.pickupTime,
    dropTime: booking.dropTime,
    status: booking.status,
  };
}

function conflictFromRental(handover, overdue) {
  return {
    kind: "rental",
    overdue,
    handoverId: handover._id,
    bookingId: handover.bookingId || null,
    bookingCode: null,
    customerName: handover.customer?.fullName || "",
    fromDate: handover.trip?.pickupDateTime || null,
    toDate: handover.trip?.dropDateTime || null,
    status: handover.handoverStatus,
  };
}

// Active or future bookings and running rentals on the vehicle that overlap
// the blocked period starting at `blockStart`. A rental counts separately
// because a handover can carry its own vehicle (after an exchange) and drop
// time.
async function findDeactivationConflicts(vehicleId, blockStart, session) {
  const [bookings, rentals] = await Promise.all([
    Booking.find({
      vehicleId,
      isDeleted: false,
      status: ACTIVE_BOOKING_STATUS_FILTER,
    })
      .select("_id bookingCode customerName fromDate toDate pickupTime dropTime status")
      .sort({ fromDate: 1, _id: 1 })
      .session(session)
      .lean(),
    Handover.find({
      "vehicle.vehicleId": vehicleId,
      isDeleted: { $ne: true },
      handoverStatus: "active",
      bookingStatus: { $in: ["confirmed", "active"] },
    })
      .select("_id bookingId customer.fullName trip.pickupDateTime trip.dropDateTime handoverStatus")
      .sort({ "trip.pickupDateTime": 1, _id: 1 })
      .session(session)
      .lean(),
  ]);

  // Same exact-boundary rule as booking overlaps.
  const conflicts = bookings
    .filter(
      (booking) =>
        bookingTimestamp(booking.toDate, booking.dropTime || "08:00 AM") > blockStart,
    )
    .map(conflictFromBooking);
  // A running rental conflicts when it is due back after the block starts,
  // or when it is overdue: until it is returned its real end is unknown.
  const now = Date.now();
  const listedBookings = new Set(conflicts.map(({ bookingId }) => String(bookingId)));
  for (const rental of rentals) {
    const dueBack = new Date(rental.trip?.dropDateTime).getTime();
    const overdue = !Number.isFinite(dueBack) || dueBack <= now;
    if ((overdue || dueBack > blockStart) && !listedBookings.has(String(rental.bookingId))) {
      conflicts.push(conflictFromRental(rental, overdue));
    }
  }
  return conflicts;
}

// Saves a deactivation date: the vehicle's last bookable day (India time).
// From 12:00 AM on the next day it cannot be booked. Refused while any active
// or future booking or rental overlaps that blocked period, so existing
// bookings are never left on a deactivated vehicle; staff resolve them through
// the booking workflow first. The vehicle and its history are kept.
export const deactivateVehicle = async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: "Invalid vehicle id." });
  }

  const deactivationDate = req.body?.deactivationDate;
  const parsedDate =
    typeof deactivationDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deactivationDate)
      ? parseOptionalVehicleDate(deactivationDate)
      : { valid: false };
  if (!parsedDate.valid || !parsedDate.value) {
    return res.status(400).json({
      success: false,
      message: "Choose a valid deactivation date.",
      fieldErrors: { deactivationDate: "Choose a valid deactivation date." },
    });
  }
  if (deactivationDate < currentIndiaDate()) {
    return res.status(400).json({
      success: false,
      message: "The deactivation date cannot be in the past.",
      fieldErrors: { deactivationDate: "The deactivation date cannot be in the past." },
    });
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!isDeactivationReason(reason)) {
    const message = "Choose a reason for deactivating this vehicle.";
    return res.status(400).json({ success: false, message, fieldErrors: { reason: message } });
  }
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
  if (notes.length > DEACTIVATION_NOTES_MAX_LENGTH || (reason === "other" && !notes)) {
    const message = notes
      ? `Keep the notes within ${DEACTIVATION_NOTES_MAX_LENGTH} characters.`
      : "Describe the reason when you choose Other.";
    return res.status(400).json({ success: false, message, fieldErrors: { notes: message } });
  }

  try {
    const blockStart = deactivationBlockStart(deactivationDate);
    await withVehicleAvailabilityLock(id, async (session, vehicle) => {
      if (vehicleDeactivationDate(vehicle)) {
        throw new VehicleAvailabilityError(409, {
          success: false,
          code: "VEHICLE_ALREADY_DEACTIVATED",
          message: `This vehicle is already deactivated after ${deactivationDateLabel(
            vehicleDeactivationDate(vehicle),
          )}.`,
        });
      }

      const conflicts = await findDeactivationConflicts(id, blockStart, session);
      if (conflicts.length) {
        const label = deactivationDateLabel(deactivationDate);
        throw new VehicleAvailabilityError(409, {
          success: false,
          code: "VEHICLE_DEACTIVATION_CONFLICT",
          message: `${conflicts.length === 1 ? "1 booking continues" : `${conflicts.length} bookings continue`} after ${label}. Cancel or reschedule ${conflicts.length === 1 ? "it" : "them"} in the booking workflow, or choose a later date.`,
          conflictCount: conflicts.length,
          conflicts: conflicts.slice(0, LISTED_DEACTIVATION_CONFLICTS),
        });
      }

      // updateOne, not save(): legacy records with incomplete fields must
      // still be deactivatable.
      await Vehicle.updateOne(
        { _id: id },
        {
          $set: {
            deactivation: {
              date: parsedDate.value,
              deactivatedBy: req.user._id,
              deactivatedAt: new Date(),
              reason,
              notes,
              // Read under the lock, so it is the status at this moment.
              previousStatus: ["available", "rent", "service"].includes(vehicle.status)
                ? vehicle.status
                : null,
            },
          },
        },
        { session },
      );
    });

    const updated = await Vehicle.findById(id).populate(AUDIT_USER_FIELDS).lean();
    return res.status(200).json({
      success: true,
      message: "Vehicle deactivated",
      data: updated,
    });
  } catch (error) {
    if (sendVehicleAvailabilityError(res, error)) return;
    return next(error);
  }
};

const REACTIVATION_REASON_MAX_LENGTH = 500;
const CLEARED_DEACTIVATION = {
  date: null,
  deactivatedBy: null,
  deactivatedAt: null,
  reason: "",
  notes: "",
  previousStatus: null,
};

// The statuses a deactivated vehicle may return to. A vehicle out on a rental
// stays On Rent (its return makes it Available); one under maintenance right
// now can only return Under Service; otherwise Available (the default) or
// Under Service.
async function reactivationOptions(vehicleId, session = null) {
  const [rental, maintenances] = await Promise.all([
    Handover.findOne({
      "vehicle.vehicleId": vehicleId,
      isDeleted: { $ne: true },
      handoverStatus: "active",
      bookingStatus: { $in: ["confirmed", "active"] },
    })
      .select("_id customer.fullName trip.dropDateTime")
      .session(session)
      .lean(),
    Maintenance.find({
      vehicle: vehicleId,
      isDeleted: { $ne: true },
      status: { $in: ["Scheduled", "In Progress"] },
    })
      .select("_id title maintenanceType status startDate endDate expectedCompletionDate")
      .session(session)
      .lean(),
  ]);
  if (rental) {
    return {
      statuses: ["rent"],
      defaultStatus: "rent",
      rule: "rental",
      message: "The vehicle is out on a rental, so it stays On Rent until it is returned.",
      rental: {
        handoverId: rental._id,
        customerName: rental.customer?.fullName || "",
        dueBack: rental.trip?.dropDateTime || null,
      },
    };
  }
  const maintenance = maintenances.find((doc) => isMaintenanceCurrentlyBlocking(doc));
  if (maintenance) {
    return {
      statuses: ["service"],
      defaultStatus: "service",
      rule: "maintenance",
      message: "Maintenance is in progress, so the vehicle can only return Under Service.",
      maintenance: {
        maintenanceId: maintenance._id,
        title: maintenance.title || maintenance.maintenanceType || "",
        endDate: maintenance.endDate || null,
      },
    };
  }
  return { statuses: ["available", "service"], defaultStatus: "available", rule: null, message: "" };
}

// Whether a vehicle can be reactivated, and to which statuses.
export const getReactivationOptions = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid vehicle id." });
    }
    const vehicle = await Vehicle.findOne({ _id: req.params.id, isDeleted: false })
      .select("deactivation")
      .lean();
    if (!vehicle) {
      return res.status(404).json({ success: false, message: "Vehicle not found" });
    }
    if (!vehicleDeactivationDate(vehicle)) {
      return res.status(409).json({
        success: false,
        code: "VEHICLE_NOT_DEACTIVATED",
        message: "This vehicle is not deactivated.",
      });
    }
    return res.status(200).json({
      success: true,
      data: { eligible: true, ...(await reactivationOptions(vehicle._id)) },
    });
  } catch (error) {
    return next(error);
  }
};

// Puts a deactivated vehicle back into service with the chosen status. The
// finished deactivation moves to deactivationHistory with who reactivated it,
// when (server time) and why; nothing is deleted.
export const reactivateVehicle = async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: "Invalid vehicle id." });
  }
  const status = req.body?.status;
  if (!["available", "service", "rent"].includes(status)) {
    const message = "Choose the status the vehicle returns to.";
    return res.status(400).json({ success: false, message, fieldErrors: { status: message } });
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length > REACTIVATION_REASON_MAX_LENGTH) {
    const message = `Keep the reason within ${REACTIVATION_REASON_MAX_LENGTH} characters.`;
    return res.status(400).json({ success: false, message, fieldErrors: { reason: message } });
  }

  try {
    // Under the booking-availability lock, like deactivation, so the two
    // cannot interleave.
    await withVehicleAvailabilityLock(id, async (session, vehicle) => {
      if (!vehicleDeactivationDate(vehicle)) {
        throw new VehicleAvailabilityError(409, {
          success: false,
          code: "VEHICLE_NOT_DEACTIVATED",
          message: "This vehicle is not deactivated.",
        });
      }
      const options = await reactivationOptions(vehicle._id, session);
      if (!options.statuses.includes(status)) {
        const message = options.message || "That status is not allowed for this vehicle.";
        throw new VehicleAvailabilityError(400, {
          success: false,
          code: "REACTIVATION_STATUS_NOT_ALLOWED",
          message,
          fieldErrors: { status: message },
          options,
        });
      }
      await Vehicle.updateOne(
        { _id: id },
        {
          $set: {
            status,
            deactivation: CLEARED_DEACTIVATION,
            ...(status === "available"
              ? { "maintenance.required": false, "maintenance.currentMaintenance": null }
              : {}),
          },
          $push: {
            deactivationHistory: {
              ...vehicle.deactivation,
              reactivatedBy: req.user._id,
              reactivatedAt: new Date(),
              reactivationReason: reason,
              reactivatedStatus: status,
            },
          },
        },
        { session },
      );
    });

    const updated = await Vehicle.findById(id).populate(AUDIT_USER_FIELDS).lean();
    return res.status(200).json({ success: true, message: "Vehicle reactivated", data: updated });
  } catch (error) {
    if (sendVehicleAvailabilityError(res, error)) return;
    return next(error);
  }
};

export const updateVehicleStatus = async (req, res, next) => {
  try {
    const normalizedStatus = normalizeVehicleStatusInput(req.body?.status);

    if (!normalizedStatus) {
      return res.status(400).json({
        success: false,
        message: "Status must be available, rent, or service",
      });
    }

    const vehicle = await Vehicle.findOne({
      _id: req.params.id,
      isDeleted: false,
    });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    const previousStatus = normalizeVehicleStatusInput(vehicle.status);
    const wasInMaintenance =
      previousStatus === "service" ||
      Boolean(vehicle.maintenance?.required || vehicle.maintenance?.currentMaintenance);

    vehicle.status = normalizedStatus;
    if (normalizedStatus === "available" && wasInMaintenance) {
      await completeActiveMaintenancesForVehicle(vehicle, req.user?._id);
    }
    await vehicle.save();

    return res.status(200).json({
      success: true,
      message: "Vehicle status updated successfully",
      data: vehicle,
    });
  } catch (error) {
    next(error);
  }
};

// maintenance controller
export const uploadMaintenanceImage = async (req, res, next) => {
  const localPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided",
      });
    }

    const result = await cloudinary.uploader.upload(localPath, {
      folder: "fleet/maintenance",
      resource_type: "image",
      transformation: [{ quality: "auto", fetch_format: "auto" }],
    });

    await fs.unlink(localPath).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Image uploaded successfully",
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (error) {
    if (localPath) {
      await fs.unlink(localPath).catch(() => {});
    }
    console.log("Cloudinary upload error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to upload image. Please try again.",
    });
  }
};
export const createMaintenance = async (req, res, next) => {
  try {
    const {
      vehicle,
      maintenanceType,
      title,
      description,
      garage,
      costs,
      odometer,
      expectedCompletionDate,
      images,
      additionalNotes,
      estimatedDays,
    } = req.body;

    /* ===============================
       VALIDATION
    =============================== */

    const missing = [];

    if (!vehicle) missing.push("vehicle");
    if (!maintenanceType) missing.push("maintenanceType");
    if (!title?.trim()) missing.push("title");
    if (!description?.trim()) missing.push("description");
    if (!garage?.name?.trim()) missing.push("garage.name");

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required field(s): ${missing.join(", ")}`,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(vehicle)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vehicle id",
      });
    }

    if (!["Major", "Minor"].includes(maintenanceType)) {
      return res.status(400).json({
        success: false,
        message: "Maintenance type must be Major or Minor",
      });
    }

    /* ===============================
       CHECK VEHICLE EXISTS
    =============================== */

    const existingVehicle = await Vehicle.findOne({
      _id: vehicle,
      isDeleted: false,
    });

    if (!existingVehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    /* ===============================
       COST CALCULATION
    =============================== */

    const partsCost = Number(costs?.partsCost) || 0;
    const labourCost = Number(costs?.labourCost) || 0;
    const totalCost = Number(costs?.totalCost) || partsCost + labourCost;

    /* ===============================
       CREATE MAINTENANCE
    =============================== */

    const maintenance = await Maintenance.create({
      vehicle: existingVehicle._id,

      maintenanceType,

      title: title.trim(),

      description: description.trim(),

      garage: {
        name: garage.name.trim(),
        contact: garage.contact?.trim() || "",
        address: garage.address?.trim() || "",
        gstin: garage.gstin?.trim() || "",
      },

      costs: {
        partsCost,
        labourCost,
        totalCost,
      },

      odometer:
        odometer !== "" && odometer !== undefined ? Number(odometer) : null,

      expectedCompletionDate,

      images: Array.isArray(images) ? images : [],

      additionalNotes: additionalNotes?.trim() || "",

      createdBy: req.user._id,
      createdByName: req.user?.fullName || req.user?.name || "",
      createdFrom: "operation",
      statusHistory: [
        {
          status: "Scheduled",
          changedBy: req.user._id,
          note: "Maintenance created",
        },
      ],
    });

    const parseValidDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    let updatedVehicle;
    try {
      updatedVehicle = await Vehicle.findOneAndUpdate(
        { _id: existingVehicle._id, isDeleted: false },
        {
          $set: {
            status: "service",
            "maintenance.required": true,
            "maintenance.currentMaintenance": maintenance._id,
            "maintenance.reason": maintenance.title || title.trim(),
            "maintenance.estimatedDays": Number(estimatedDays) || 0,
            "maintenance.estimatedCompletionDate": parseValidDate(
              expectedCompletionDate,
            ),
            "maintenance.markedBy": req.user?._id || null,
            "maintenance.markedAt": new Date(),
          },
          $addToSet: {
            "maintenance.maintenanceHistory": maintenance._id,
          },
        },
        { new: true },
      );

      if (!updatedVehicle) {
        await Maintenance.findByIdAndDelete(maintenance._id);
        return res.status(500).json({
          success: false,
          message: "Failed to update vehicle status",
        });
      }
    } catch (vehicleUpdateError) {
      await Maintenance.findByIdAndDelete(maintenance._id);
      throw vehicleUpdateError;
    }

    await maintenance.populate([
      { path: "createdBy", select: "name fullName email role" },
      { path: "statusHistory.changedBy", select: "name fullName role" },
    ]);

    return res.status(201).json({
      success: true,
      message: "Maintenance created successfully",
      vehicleStatus: updatedVehicle.status,
      data: maintenance,
    });
  } catch (error) {
    next(error);
  }
};

export const getMaintenances = async (req, res, next) => {
  try {
    const {
      status,
      maintenanceType,
      vehicle,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const filter = {
      isDeleted: false,
    };

    if (status) {
      filter.status = status;
    }

    if (maintenanceType) {
      filter.maintenanceType = maintenanceType;
    }

    if (vehicle && mongoose.Types.ObjectId.isValid(vehicle)) {
      filter.vehicle = vehicle;
    }

    let query = Maintenance.find(filter)
      .populate({
        path: "vehicle",
        select: `
          vehicleName
          vehicleNumber
          manufacturer
          model
          variant
          vehicleType
          fuelType
          transmission
          seatingCapacity
          images
          status
        `,
      })
      .populate({
        path: "createdBy",
        select: "name fullName email role",
      })
      .sort({
        createdAt: -1,
      });

    const maintenances = await query.lean();

    let data = maintenances;

    if (search) {
      const keyword = search.toLowerCase();

      data = maintenances.filter((item) => {
        return (
          item.title?.toLowerCase().includes(keyword) ||
          item.description?.toLowerCase().includes(keyword) ||
          item.garage?.name?.toLowerCase().includes(keyword) ||
          item.vehicle?.vehicleName?.toLowerCase().includes(keyword) ||
          item.vehicle?.vehicleNumber?.toLowerCase().includes(keyword)
        );
      });
    }

    const start = (Number(page) - 1) * Number(limit);
    const end = start + Number(limit);

    const result = data.slice(start, end);

    return res.status(200).json({
      success: true,
      total: data.length,
      page: Number(page),
      limit: Number(limit),
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getMaintenanceById = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid maintenance id" });
    }
    const item = await Maintenance.findOne({
      _id: req.params.id,
      isDeleted: false,
    })
      .populate({ path: "vehicle", select: "vehicleName vehicleNumber images" })
      .populate({ path: "createdBy", select: "name fullName email role" })
      .populate({ path: "statusHistory.changedBy", select: "name fullName role" })
      .lean();

    // Unified fleet: any maintenance on a Fleet Dashboard (non-deleted)
    // vehicle, whichever company registered it, like New Booking.
    if (!item || !await Vehicle.exists({
      _id: item.vehicle?._id || item.vehicle,
      isDeleted: false,
    })) {
      return res.status(404).json({ success: false, message: "Maintenance record not found" });
    }

    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

const VALID_STATUSES = ["Scheduled", "In Progress", "Completed", "Cancelled"];
const TERMINAL_MAINTENANCE_STATUSES = ["Completed", "Cancelled"];
const VEHICLE_SERVICE_STATUSES = [
  "service",
  "in_service",
  "in service",
  "in-service",
  "maintenance",
  "in_maintenance",
  "in maintenance",
  "in-maintenance",
  "under_maintenance",
  "under maintenance",
  "under-maintenance",
  "Service",
  "In Service",
  "In Maintenance",
  "Under Maintenance",
  /^(service|in[\s_-]*service|((in|under)[\s_-]*)?maintenance)$/i,
];

function isMaintenanceCurrentlyBlocking(doc, now = new Date()) {
  if (!doc) return false;
  if (doc.status === "In Progress") return true;
  if (doc.status !== "Scheduled") return false;

  const start = doc.startDate ? new Date(doc.startDate) : null;
  const end = doc.endDate ? new Date(doc.endDate) : null;
  const expected = doc.expectedCompletionDate
    ? new Date(doc.expectedCompletionDate)
    : null;

  if (start && !Number.isNaN(start.getTime()) && start > now) {
    return false;
  }

  if (expected && !Number.isNaN(expected.getTime()) && expected <= now) {
    return false;
  }

  if (
    end &&
    start &&
    !Number.isNaN(end.getTime()) &&
    !Number.isNaN(start.getTime()) &&
    end > start &&
    end <= now
  ) {
    return false;
  }

  if (
    start &&
    end &&
    !Number.isNaN(start.getTime()) &&
    end.getTime() === start.getTime() &&
    (!expected || Number.isNaN(expected.getTime()))
  ) {
    return now.getTime() - start.getTime() < 24 * 60 * 60 * 1000;
  }

  return true;
}

async function markVehicleInServiceForMaintenance(
  vehicleId,
  maintenance,
  userId,
) {
  const parsedExpected = maintenance?.expectedCompletionDate
    ? new Date(maintenance.expectedCompletionDate)
    : null;
  const estimatedCompletionDate =
    parsedExpected && !Number.isNaN(parsedExpected.getTime())
      ? parsedExpected
      : null;

  return Vehicle.findOneAndUpdate(
    { _id: vehicleId, isDeleted: false },
    {
      $set: {
        status: "service",
        "maintenance.required": true,
        "maintenance.currentMaintenance": maintenance._id,
        "maintenance.reason": maintenance.title || "",
        "maintenance.estimatedCompletionDate": estimatedCompletionDate,
        "maintenance.markedBy": userId || null,
        "maintenance.markedAt": new Date(),
      },
      $addToSet: { "maintenance.maintenanceHistory": maintenance._id },
    },
    { new: true },
  ).lean();
}

async function releaseVehicleFromMaintenance(maintenance) {
  const now = new Date();
  const openCandidates = await Maintenance.find({
    _id: { $ne: maintenance._id },
    vehicle: maintenance.vehicle,
    status: { $in: ["Scheduled", "In Progress"] },
    isDeleted: { $ne: true },
  })
    .select("_id title status startDate endDate expectedCompletionDate createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const otherOpenBlocking = openCandidates.filter((doc) =>
    isMaintenanceCurrentlyBlocking(doc, now),
  );

  if (otherOpenBlocking.length > 0) {
    const nextJob = otherOpenBlocking[0];
    const parsedExpected = nextJob.expectedCompletionDate
      ? new Date(nextJob.expectedCompletionDate)
      : null;
    await Vehicle.findOneAndUpdate(
      { _id: maintenance.vehicle, status: { $ne: "rent" } },
      {
        $set: {
          status: "service",
          "maintenance.required": true,
          "maintenance.currentMaintenance": nextJob._id,
          "maintenance.reason": nextJob.title || "",
          "maintenance.estimatedCompletionDate":
            parsedExpected && !Number.isNaN(parsedExpected.getTime())
              ? parsedExpected
              : null,
        },
      },
      { new: true },
    );
    return;
  }

  const clearMaintenanceUpdate = {
    $set: {
      "maintenance.required": false,
      "maintenance.currentMaintenance": null,
      "maintenance.reason": "",
      "maintenance.estimatedDays": 0,
      "maintenance.estimatedCompletionDate": null,
      "maintenance.markedBy": null,
      "maintenance.markedAt": null,
    },
    $addToSet: { "maintenance.maintenanceHistory": maintenance._id },
  };

  const released = await Vehicle.findOneAndUpdate(
    {
      _id: maintenance.vehicle,
      status: { $in: VEHICLE_SERVICE_STATUSES },
    },
    {
      ...clearMaintenanceUpdate,
      $set: {
        ...clearMaintenanceUpdate.$set,
        status: "available",
      },
    },
    { new: true },
  ).lean();

  if (!released) {
    await Vehicle.updateOne(
      {
        _id: maintenance.vehicle,
        "maintenance.currentMaintenance": maintenance._id,
      },
      clearMaintenanceUpdate,
    );
  }
}

export const updateMaintenance = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid maintenance id" });
    }
    const maintenance = await Maintenance.findOne({ _id: req.params.id, isDeleted: false });
    if (!maintenance || !await Vehicle.exists({
      _id: maintenance.vehicle, isDeleted: false,
    })) {
      return res.status(404).json({ success: false, message: "Maintenance record not found" });
    }
    if (Object.hasOwn(req.body, "vehicle") && !await Vehicle.exists({
      _id: req.body.vehicle, isDeleted: false,
    })) {
      return res.status(404).json({ success: false, message: "Vehicle not found" });
    }
    const previousStatus = maintenance.status;
    const previousVehicle = maintenance.vehicle;
    const fields = [
      "vehicle", "startDate", "endDate", "maintenanceType", "title", "description",
      "garage", "costs", "odometer", "expectedCompletionDate", "images",
      "additionalNotes", "status", "completionProof",
    ];
    for (const field of fields) {
      if (Object.hasOwn(req.body, field)) {
        maintenance.set(field, field === "maintenanceType" && req.body[field] === "" ? undefined : req.body[field]);
      }
    }
    if (
      maintenance.status === "Completed" &&
      maintenance.startDate &&
      maintenance.endDate &&
      maintenance.endDate.getTime() === maintenance.startDate.getTime()
    ) {
      maintenance.endDate = new Date(
        Math.max(Date.now(), maintenance.startDate.getTime() + 1000),
      );
    }
    if (!maintenance.startDate || !maintenance.endDate || maintenance.endDate <= maintenance.startDate) {
      return res.status(400).json({ success: false, message: "Maintenance end date must be after the start date" });
    }
    if (maintenance.status === "Completed" &&
        (!maintenance.completionProof?.billImage || !maintenance.completionProof?.cardImage)) {
      return res.status(400).json({ success: false, message: "Bill photo and card photo are required to mark maintenance as completed" });
    }
    const changedAt = new Date();
    if (maintenance.status !== previousStatus && VALID_STATUSES.includes(maintenance.status)) {
      maintenance.completedDate = maintenance.status === "Completed" ? changedAt : null;
      maintenance.statusHistory.push({
        status: maintenance.status, changedBy: req.user?._id,
        note: req.body.statusNote || "", changedAt,
      });
    }
    if (maintenance.status === "Completed") {
      if (!maintenance.completedDate) {
        maintenance.completedDate = changedAt;
      }
      if (maintenance.endDate > maintenance.completedDate || maintenance.endDate > changedAt) {
        maintenance.endDate = maintenance.completedDate;
      }
      if (maintenance.endDate <= maintenance.startDate) {
        maintenance.endDate = new Date(maintenance.startDate.getTime() + 60_000);
      }
    }
    await maintenance.save();
    const vehicleChanged = String(previousVehicle) !== String(maintenance.vehicle);
    if (vehicleChanged) {
      await releaseVehicleFromMaintenance({
        _id: maintenance._id,
        vehicle: previousVehicle,
      });
    }
    if (TERMINAL_MAINTENANCE_STATUSES.includes(maintenance.status)) {
      if (
        maintenance.status !== previousStatus ||
        vehicleChanged ||
        mongoose.connection?.readyState === 1
      ) {
        await releaseVehicleFromMaintenance(maintenance);
      }
    } else if (
      TERMINAL_MAINTENANCE_STATUSES.includes(previousStatus) ||
      vehicleChanged ||
      mongoose.connection?.readyState === 1
    ) {
      await markVehicleInServiceForMaintenance(
        maintenance.vehicle,
        maintenance,
        req.user?._id,
      );
    }
    const populated = (await maintenance.populate([
      { path: "vehicle", select: "vehicleName vehicleNumber images status" },
      { path: "createdBy", select: "name fullName email role" },
      { path: "statusHistory.changedBy", select: "name fullName role" },
    ])) || maintenance;
    return res.status(200).json({
      success: true,
      message: "Maintenance updated successfully",
      vehicleStatus: populated.vehicle?.status || null,
      data: populated,
    });
  } catch (error) {
    next(error);
  }
};

export const updateMaintenanceStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, note, billImage, cardImage } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid maintenance id",
      });
    }

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    // Completing a job requires proof — bill and card photos, plus a note
    if (status === "Completed") {
      if (!billImage || !cardImage) {
        return res.status(400).json({
          success: false,
          message:
            "Bill photo and card photo are required to mark maintenance as completed",
        });
      }
    }

    const maintenance = await Maintenance.findOne({
      _id: id,
      isDeleted: false,
    });

    if (!maintenance) {
      return res.status(404).json({
        success: false,
        message: "Maintenance record not found",
      });
    }

    // No-op if status hasn't actually changed (still ensure terminal status releases vehicle)
    if (maintenance.status === status) {
      if (TERMINAL_MAINTENANCE_STATUSES.includes(status)) {
        await releaseVehicleFromMaintenance(maintenance);
      }
      const populatedUnchanged = (await maintenance.populate([
        { path: "vehicle", select: "vehicleName vehicleNumber images status" },
      ])) || maintenance;
      return res.status(200).json({
        success: true,
        message: "Status unchanged",
        vehicleStatus: populatedUnchanged?.vehicle?.status || null,
        data: populatedUnchanged,
      });
    }

    const previousStatus = maintenance.status;

    maintenance.status = status;

    if (status === "Completed") {
      const completionTime = new Date();

      // Actual maintenance completion date & time
      maintenance.completedDate = completionTime;

      // Update endDate to actual completion date & time
      maintenance.endDate = completionTime;

      maintenance.completionProof = {
        billImage,
        cardImage,
        note: note || "",
      };
    } else if (maintenance.completedDate) {
      maintenance.completedDate = null;
    }

    maintenance.statusHistory.push({
      status,
      changedBy: req.user?._id,
      note: note || "",
      changedAt: new Date(),
    });

    await maintenance.save();

    if (TERMINAL_MAINTENANCE_STATUSES.includes(status)) {
      await releaseVehicleFromMaintenance(maintenance);
    } else if (TERMINAL_MAINTENANCE_STATUSES.includes(previousStatus)) {
      await markVehicleInServiceForMaintenance(
        maintenance.vehicle,
        maintenance,
        req.user?._id,
      );
    }

    const populated = await Maintenance.findById(maintenance._id)
      .populate({
        path: "vehicle",
        select:
          "vehicleName vehicleNumber manufacturer model variant vehicleType fuelType transmission seatingCapacity images status",
      })
      .populate({ path: "createdBy", select: "name fullName email role" })
      .populate({ path: "statusHistory.changedBy", select: "name fullName role" })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Status updated successfully",
      vehicleStatus: populated?.vehicle?.status || null,
      data: populated,
    });
  } catch (error) {
    next(error);
  }
};
