import mongoose from "mongoose";
import fs from "fs/promises";
import cloudinary from "../config/cloudinary.js";
import Vehicle from "../models/vehicle.model.js";
import Maintenance from "../models/maintenance.model.js";

// add vehicle screen
export const createVehicle = async (req, res, next) => {
  try {
    // Same scope booking reads use: an employee's vehicles belong to the
    // owner who created them, otherwise New Booking can never select them.
    const companyId = req.user.company || req.user.createdBy || req.user._id;

    const {
      vehicleName,
      vehicleNumber,
      manufacturer,
      model,
      variant,
      vehicleType,
      fuelType,
      transmission,
      seatingCapacity,
      color,
      chassisNumber,
      engineNumber,
      registrationDate,
      insuranceValidUpto,
      pucValidUpto,
      fitnessValidUpto,
      notes,
      status,
    } = req.body;

    if (!vehicleNumber) {
      return res.status(400).json({
        success: false,
        message: "Vehicle number is required",
      });
    }

    const existingVehicle = await Vehicle.findOne({
      vehicleNumber: vehicleNumber.toUpperCase(),
      isDeleted: false,
    });

    if (existingVehicle) {
      return res.status(400).json({
        success: false,
        message: "Vehicle with this number already exists",
      });
    }

    const images =
      req.files?.map((file) => ({
        url: file.path,
        publicId: file.filename, // schema field name; "public_id" was silently dropped
      })) || [];

    const vehicle = await Vehicle.create({
      company: companyId,
      createdBy: req.user._id,
      vehicleName,
      vehicleNumber: vehicleNumber.toUpperCase(),
      manufacturer,
      model,
      variant,
      vehicleType,
      fuelType,
      transmission,
      seatingCapacity: Number(seatingCapacity),
      color,
      chassisNumber,
      engineNumber,
      registrationDate: registrationDate || null,
      insuranceValidUpto: insuranceValidUpto || null,
      pucValidUpto: pucValidUpto || null,
      fitnessValidUpto: fitnessValidUpto || null,
      notes,
      status: status || "available",
      images,
    });

    res.status(201).json({
      success: true,
      message: "Vehicle added successfully",
      data: vehicle,
    });
  } catch (error) {
    next(error);
  }
};
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
// v1.1
export const getAllVehicles = async (req, res, next) => {
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

    // NEW: optional category filter (car / bike). Only applied when a
    // caller explicitly sends it, so existing screens hitting this same
    // controller without a category param behave exactly as before.
    if (req.query.category && req.query.category !== "All") {
      const categoryTerm = String(req.query.category).trim();
      if (categoryTerm) {
        // Case-insensitive exact match so "Car"/"car"/"CAR" all work
        // regardless of how it's stored in the DB.
        filters.category = new RegExp(`^${categoryTerm}$`, "i");
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
          category: 1,
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
      // pages) is correct for whatever search/status/category the user
      // has active.
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

export const getAvailableVehicles = async (req, res, next) => {
  try {
    const vehicles = await Vehicle.find({
      status: "available",
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
 
export const updateVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);
 
    if (!vehicle || vehicle.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }
 
    const allowedFields = [
      "vehicleName",
      "displayName",
      "vehicleNumber",
      "manufacturer",
      "model",
      "variant",
      "pricePerDay",
      "category",
      "vehicleType",
      "fuelType",
      "transmission",
      "seatingCapacity",
      "color",
      "chassisNumber",
      "engineNumber",
      "registrationDate",
      "insuranceValidUpto",
      "pucValidUpto",
      "fitnessValidUpto",
      "notes",
    ];
 
    // -----------------------------------------
    // Display name validation (optional field)
    // An empty string is allowed so employees can clear it.
    // -----------------------------------------
    if (req.body.displayName !== undefined && req.body.displayName !== null) {
      const incomingDisplayName = String(req.body.displayName).trim();
 
      if (incomingDisplayName.length > DISPLAY_NAME_MAX_LENGTH) {
        return res.status(400).json({
          success: false,
          message: `Display name cannot exceed ${DISPLAY_NAME_MAX_LENGTH} characters`,
        });
      }
 
      req.body.displayName = incomingDisplayName; // normalize whitespace
    } else if (req.body.displayName === null) {
      req.body.displayName = "";
    }
 
    // -----------------------------------------
    // Category validation (must run BEFORE assignment)
    // -----------------------------------------
    if (
      req.body.category !== undefined &&
      req.body.category !== null &&
      req.body.category !== "" &&
      !["bike", "car"].includes(req.body.category)
    ) {
      return res.status(400).json({
        success: false,
        message: "Category must be either bike or car",
      });
    }
 
    const effectiveCategory = req.body.category ?? vehicle.category;
 
    // -----------------------------------------
    // vehicleType validation (must run BEFORE assignment)
    // -----------------------------------------
    const carVehicleTypes = [
      "SUV",
      "Sedan",
      "Hatchback",
      "Luxury",
      "Tempo Traveller",
      "Mini Bus",
      "Bus",
    ];
 
    if (req.body.vehicleType !== undefined) {
      const incomingType = String(req.body.vehicleType).trim();
 
      if (effectiveCategory === "car") {
        const matched = carVehicleTypes.find(
          (t) => t.toLowerCase() === incomingType.toLowerCase(),
        );
 
        if (!matched) {
          return res.status(400).json({
            success: false,
            message: `vehicleType must be one of: ${carVehicleTypes.join(", ")}. Received: "${incomingType}"`,
          });
        }
 
        req.body.vehicleType = matched; // normalize casing
      } else {
        return res.status(400).json({
          success: false,
          message: "vehicleType only applies to vehicles with category 'car'",
        });
      }
    }
 
    // -----------------------------------------
    // Update fields (now safe — bad values already rejected above)
    // -----------------------------------------
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        vehicle[field] = req.body[field];
      }
    });
 
    // -----------------------------------------
    // Vehicle number normalization
    // -----------------------------------------
    if (vehicle.vehicleNumber) {
      vehicle.vehicleNumber = vehicle.vehicleNumber.toUpperCase().trim();
    }
 
    // -----------------------------------------
    // Status
    // -----------------------------------------
    if (req.body.status !== undefined) {
      const allowedStatuses = ["available", "rent", "service"];
 
      if (!allowedStatuses.includes(req.body.status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be available, rent, or service",
        });
      }
 
      vehicle.status = req.body.status;
    }
 
    // -----------------------------------------
    // Add new images
    // -----------------------------------------
    if (req.files?.length > 0) {
      const newImages = req.files.map((file) => ({
        url: `/uploads/vehicles/${file.filename}`,
        publicId: null,
      }));
 
      vehicle.images.push(...newImages);
    }
 
    await vehicle.save();
 
    return res.status(200).json({
      success: true,
      message: "Vehicle updated successfully",
      data: vehicle,
    });
  } catch (error) {
    next(error);
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
      { $set: { isDeleted: true } }
    );

    return res.status(200).json({
      success: true,
      message: "Vehicle deleted successfully",
    });
  } catch (error) {
    next(error);
  }
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

    vehicle.status = normalizedStatus;
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
  "maintenance",
  "under_maintenance",
  "under maintenance",
  "Service",
  "In Service",
  "Under Maintenance",
  /^(service|in[\s_-]*service|(under[\s_-]*)?maintenance)$/i,
];

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
  const otherOpenBlocking = await Maintenance.find({
    _id: { $ne: maintenance._id },
    vehicle: maintenance.vehicle,
    status: { $in: ["Scheduled", "In Progress"] },
    isDeleted: false,
  })
    .select("_id title expectedCompletionDate")
    .limit(1)
    .lean();

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
    if (maintenance.status !== previousStatus && VALID_STATUSES.includes(maintenance.status)) {
      const changedAt = new Date();
      maintenance.completedDate = maintenance.status === "Completed" ? changedAt : null;
      if (maintenance.status === "Completed" && changedAt > maintenance.startDate) {
        maintenance.endDate = changedAt;
      }
      maintenance.statusHistory.push({
        status: maintenance.status, changedBy: req.user?._id,
        note: req.body.statusNote || "", changedAt,
      });
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
