import Vehicle from "../models/vehicle.model.js";

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
    })
      .select(
        "_id vehicleName vehicleNumber color manufacturer model vehicleType status"
      )
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles,
    });
  } catch (error) {
    next(error);
  }
};

export const getSingleVehicle = async (
  req,
  res,
  next
) => {
  try {
    const vehicle =
      await Vehicle.findOne({
        _id: req.params.id,
        company:
          req.user.company ||
          req.user._id,
        isDeleted: false,
      });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    res.status(200).json({
      success: true,
      data: vehicle,
    });
  } catch (error) {
    next(error);
  }
};

export const updateVehicle = async (
  req,
  res,
  next
) => {
  try {
    const vehicle =
      await Vehicle.findOne({
        _id: req.params.id,
        company:
          req.user.company ||
          req.user._id,
        isDeleted: false,
      });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    if (req.files?.length > 0) {
      const newImages =
        req.files.map((file) => ({
          url: `/uploads/vehicles/${file.filename}`,
        }));

      vehicle.images.push(...newImages);
    }

    Object.assign(vehicle, req.body);

    await vehicle.save();

    res.status(200).json({
      success: true,
      message: "Vehicle updated",
      data: vehicle,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteVehicle = async (
  req,
  res,
  next
) => {
  try {
    const vehicle =
      await Vehicle.findOne({
        _id: req.params.id,
        company:
          req.user.company ||
          req.user._id,
      });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    vehicle.isDeleted = true;

    await vehicle.save();

    res.status(200).json({
      success: true,
      message: "Vehicle deleted",
    });
  } catch (error) {
    next(error);
  }
};

export const updateVehicleStatus = async (
  req,
  res,
  next
) => {
  try {
    const { status } = req.body;

    const vehicle =
      await Vehicle.findOne({
        _id: req.params.id,
        company:
          req.user.company ||
          req.user._id,
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

    res.status(200).json({
      success: true,
      message:
        "Vehicle status updated",
      data: vehicle,
    });
  } catch (error) {
    next(error);
  }
};