import mongoose from "mongoose";
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
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 1000;
    const skip = (page - 1) * limit;

    const filters = {
      isDeleted: false,
    };

    if (req.query.status) {
      filters.status = req.query.status;
    }

    const vehicles = await Vehicle.find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Vehicle.countDocuments(filters);

    const stats = await Vehicle.aggregate([
      {
        $match: {
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    res.status(200).json({
      success: true,
      total,
      page,
      pages: Math.ceil(total / limit),
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
    const totalCost =
      Number(costs?.totalCost) || (partsCost + labourCost);

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
        odometer !== "" && odometer !== undefined
          ? Number(odometer)
          : null,

      expectedCompletionDate,

      images: Array.isArray(images) ? images : [],

      additionalNotes: additionalNotes?.trim() || "",

      createdBy: req.user._id,
    });

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