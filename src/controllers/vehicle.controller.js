import mongoose from "mongoose";
import fs from "fs/promises";
import cloudinary from "../config/cloudinary.js";
import Vehicle from "../models/vehicle.model.js";
import Maintenance from "../models/maintenance.model.js";

// add vehicle screen
export const createVehicle = async (req, res, next) => {
  try {
    const companyId = req.user.company || req.user._id;

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
        public_id: file.filename,
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
// manage vehicle page
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

export const updateVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);

    if (!vehicle || vehicle.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    if (req.files?.length > 0) {
      const newImages = req.files.map((file) => ({
        url: `/uploads/vehicles/${file.filename}`,
      }));

      vehicle.images.push(...newImages);
    }

    Object.assign(vehicle, req.body);

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
    // Only SUPER_ADMIN can delete vehicles
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

    vehicle.isDeleted = true;
    await vehicle.save();

    return res.status(200).json({
      success: true,
      message: "Vehicle deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const updateVehicleStatus = async (req, res, next) => {
  try {
    const { status } = req.body;

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

    vehicle.status = status;
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
    });

    /* ===============================
       VEHICLE STATUS UPDATE - TEMPORARILY DISABLED
    =============================== */

    // try {
    //   const updatedVehicle = await Vehicle.findByIdAndUpdate(
    //     existingVehicle._id,
    //     {
    //       $set: {
    //         status: "service",
    //         "maintenance.required": true,
    //         "maintenance.currentMaintenance": maintenance._id,
    //         "maintenance.reason": title.trim(),
    //         "maintenance.estimatedDays": Number(estimatedDays) || 0,
    //         "maintenance.estimatedCompletionDate":
    //           expectedCompletionDate || null,
    //         "maintenance.markedBy": req.user._id,
    //         "maintenance.markedAt": new Date(),
    //       },
    //       $push: {
    //         "maintenance.maintenanceHistory": maintenance._id,
    //       },
    //     },
    //     { new: true },
    //   );

    //   if (!updatedVehicle) {
    //     // Rollback maintenance record if vehicle update somehow failed
    //     await Maintenance.findByIdAndDelete(maintenance._id);
    //     return res.status(500).json({
    //       success: false,
    //       message: "Failed to update vehicle status",
    //     });
    //   }
    // } catch (vehicleUpdateError) {
    //   // Rollback maintenance record on error
    //   await Maintenance.findByIdAndDelete(maintenance._id);
    //   throw vehicleUpdateError;
    // }

    return res.status(201).json({
      success: true,
      message: "Maintenance created successfully",
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
        select: "name fullName email",
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
    const item = await Maintenance.findOne({
      _id: req.params.id,
      isDeleted: false,
    })
      .populate({ path: "vehicle", select: "vehicleName vehicleNumber images" })
      .populate({ path: "createdBy", select: "name fullName email" })
      .lean();

    if (!item) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

const VALID_STATUSES = ["Scheduled", "In Progress", "Completed", "Cancelled"];
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

    // No-op if status hasn't actually changed
    if (maintenance.status === status) {
      return res.status(200).json({
        success: true,
        message: "Status unchanged",
        data: maintenance,
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

    /* ===============================
       COMPLETED -> RESET VEHICLE TO "available" - TEMPORARILY DISABLED
    =============================== */

    // if (status === "Completed") {
    //   try {
    //     const updatedVehicle = await Vehicle.findByIdAndUpdate(
    //       maintenance.vehicle,
    //       {
    //         $set: {
    //           status: "available",
    //           "maintenance.required": false,
    //           "maintenance.currentMaintenance": null,
    //           "maintenance.reason": "",
    //           "maintenance.estimatedDays": 0,
    //           "maintenance.estimatedCompletionDate": null,
    //           "maintenance.markedBy": null,
    //           "maintenance.markedAt": null,
    //         },
    //       },
    //       { new: true },
    //     );

    //     if (!updatedVehicle) {
    //       // Roll back the status change if the vehicle couldn't be updated,
    //       // so the maintenance record and vehicle stay in sync.
    //       maintenance.status = previousStatus;
    //       maintenance.completedDate = null;
    //       maintenance.completionProof = undefined;
    //       maintenance.statusHistory.pop();
    //       await maintenance.save();

    //       return res.status(500).json({
    //         success: false,
    //         message:
    //           "Maintenance was updated but the linked vehicle could not be found to reset its status",
    //       });
    //     }
    //   } catch (vehicleUpdateError) {
    //     // Roll back the status change on error too
    //     maintenance.status = previousStatus;
    //     maintenance.completedDate = null;
    //     maintenance.completionProof = undefined;
    //     maintenance.statusHistory.pop();
    //     await maintenance.save();
    //     throw vehicleUpdateError;
    //   }
    // }

    const populated = await Maintenance.findById(maintenance._id)
      .populate({
        path: "vehicle",
        select:
          "vehicleName vehicleNumber manufacturer model variant vehicleType fuelType transmission seatingCapacity images status",
      })
      .populate({ path: "createdBy", select: "name fullName email" })
      .populate({ path: "statusHistory.changedBy", select: "name fullName" })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Status updated successfully",
      data: populated,
    });
  } catch (error) {
    next(error);
  }
};
