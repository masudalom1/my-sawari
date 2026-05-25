import Handover from "../models/handover.model.js";

//Car Handover 
export const createHandover = async (req, res, next) => {
  try {
    const {
      customer,
      identity,
      vehicle,
      trip,
      payment,
      notes,
      bookingStatus,
    } = req.body;

    const files = req.files || {};

    const handover = await Handover.create({
      company: req.user.company || req.user._id,
      createdBy: req.user._id,

      customer: {
        fullName: customer?.fullName,
        mobileNumber: customer?.mobileNumber,
        alternateMobileNumber: customer?.alternateMobileNumber || "",
        occupation: customer?.occupation || "",
        destination: customer?.destination,
      },

      identity: {
        idType: identity?.idType,
        idNumber: identity?.idNumber,
      },

      vehicle: {
        vehicleId: vehicle?.vehicleId,
        vehicleName: vehicle?.vehicleName,
        vehicleNumber: vehicle?.vehicleNumber,
        vehicleColor: vehicle?.vehicleColor || "",
      },

      trip: {
        tripType: trip?.tripType || "local",
        numberOfDays: Number(trip?.numberOfDays),
        pickupDateTime: trip?.pickupDateTime,
        dropDateTime: trip?.dropDateTime,
      },

      payment: {
        fuelLevel: payment?.fuelLevel || "medium",
        fastTagBalance: Number(payment?.fastTagBalance) || 0,
        fastTagPayableAmount:
          Number(payment?.fastTagPayableAmount) || 0,
        totalFare: Number(payment?.totalFare),
        amountReceived: Number(payment?.amountReceived),
        securityDeposit:
          Number(payment?.securityDeposit) || 0,
        advancePaid: Number(payment?.advancePaid) || 0,
        extraCharges: Number(payment?.extraCharges) || 0,
        paymentMethod: payment?.paymentMethod,
      },

      notes: notes || "",
      bookingStatus: bookingStatus || "confirmed",

      images: {
        customerPhoto: files.customerPhoto?.[0]?.path || "",
        customerWithVehicle:
          files.customerWithVehicle?.[0]?.path || "",
        vehicleFront: files.vehicleFront?.[0]?.path || "",
        vehicleRear: files.vehicleRear?.[0]?.path || "",
        vehicleLeft: files.vehicleLeft?.[0]?.path || "",
        vehicleRight: files.vehicleRight?.[0]?.path || "",
      },
    });

    res.status(201).json({
      success: true,
      message: "Handover created successfully",
      data: handover,
    });
  } catch (error) {
    next(error);
  }
};
export const uploadHandoverImages = async (req, res, next) => {
  try {
    console.log("FILES RECEIVED:", req.files);

    const { handoverId } = req.params;

    const handover = await Handover.findById(handoverId);

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    if (req.files?.customerPhoto?.[0]) {
      handover.images.customerPhoto =
        req.files.customerPhoto[0].path;
    }

    if (req.files?.customerWithVehicle?.[0]) {
      handover.images.customerWithVehicle =
        req.files.customerWithVehicle[0].path;
    }

    if (req.files?.vehicleFront?.[0]) {
      handover.images.vehicleFront =
        req.files.vehicleFront[0].path;
    }

    if (req.files?.vehicleRear?.[0]) {
      handover.images.vehicleRear =
        req.files.vehicleRear[0].path;
    }

    if (req.files?.vehicleLeft?.[0]) {
      handover.images.vehicleLeft =
        req.files.vehicleLeft[0].path;
    }

    if (req.files?.vehicleRight?.[0]) {
      handover.images.vehicleRight =
        req.files.vehicleRight[0].path;
    }

    await handover.save();

    res.status(200).json({
      success: true,
      message: "Handover images uploaded successfully",
      data: handover,
    });
  } catch (error) {
    console.log("UPLOAD ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// active rental screen 
export const getActiveHandovers = async (req, res) => {
  try {
    const activeHandovers = await Handover.find({
      company: req.user.company || req.user._id,
      handoverStatus: "active",
      isDeleted: false,
    })
      .populate("vehicle.vehicleId")
      .populate("createdBy", "fullName")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: activeHandovers.length,
      data: activeHandovers,
    });
  } catch (error) {
    console.log("ACTIVE HANDOVER ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
export const getSingleHandover = async (req, res) => {
  try {
    const { id } = req.params;

    const handover = await Handover.findOne({
      _id: id,
      company: req.user.company || req.user._id,
      isDeleted: false,
    })
      .populate("createdBy", "fullName email")
      .populate("vehicle.vehicleId");

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    res.status(200).json({
      success: true,
      data: handover,
    });
  } catch (error) {
    console.log("GET SINGLE HANDOVER ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// NOT USED
export const getAllHandovers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const filters = {
      company: req.user.company || req.user._id,
      isDeleted: false,
    };

    // optional filters
    if (req.query.bookingStatus) {
      filters.bookingStatus = req.query.bookingStatus;
    }

    if (req.query.handoverStatus) {
      filters.handoverStatus = req.query.handoverStatus;
    }

    if (req.query.paymentStatus) {
      filters["payment.paymentStatus"] = req.query.paymentStatus;
    }

    // search
    if (req.query.search) {
      filters.$or = [
        {
          "customer.fullName": {
            $regex: req.query.search,
            $options: "i",
          },
        },
        {
          "customer.mobileNumber": {
            $regex: req.query.search,
            $options: "i",
          },
        },
        {
          "vehicle.vehicleNumber": {
            $regex: req.query.search,
            $options: "i",
          },
        },
        {
          "vehicle.vehicleName": {
            $regex: req.query.search,
            $options: "i",
          },
        },
      ];
    }

    const [handovers, total] = await Promise.all([
      Handover.find(filters)
        .populate("createdBy", "fullName email role")
        .populate("vehicle.vehicleId", "name number color type")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Handover.countDocuments(filters),
    ]);

    res.status(200).json({
      success: true,
      message: "Handovers fetched successfully",
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      data: handovers,
    });
  } catch (error) {
    next(error);
  }
};

export const updateHandover = async (req, res, next) => {
  try {
    const handover = await Handover.findOne({
      _id: req.params.id,
      company: req.user.company || req.user._id,
      isDeleted: false,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    Object.assign(handover, req.body);

    await handover.save();

    res.status(200).json({
      success: true,
      message: "Handover updated successfully",
      data: handover,
    });
  } catch (error) {
  console.log("========== CLOUDINARY ERROR ==========");
  console.log(error);
  console.log("MESSAGE:", error.message);
  console.log("STACK:", error.stack);

  return res.status(500).json({
    success: false,
    message: error.message,
    fullError: error,
  });
}
};

export const markVehicleReturned = async (req, res, next) => {
  try {
    const { remarks, vehicleCondition } = req.body;

    const handover = await Handover.findOne({
      _id: req.params.id,
      company: req.user.company || req.user._id,
      isDeleted: false,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    handover.handoverStatus = "returned";

    handover.returnDetails = {
      returnedAt: new Date(),
      returnedBy: req.user._id,
      remarks,
      vehicleCondition,
    };

    await handover.save();

    res.status(200).json({
      success: true,
      message: "Vehicle marked as returned",
      data: handover,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteHandover = async (req, res, next) => {
  try {
    const handover = await Handover.findOne({
      _id: req.params.id,
      company: req.user.company || req.user._id,
    });

    if (!handover) {
      return res.status(404).json({
        success: false,
        message: "Handover not found",
      });
    }

    handover.isDeleted = true;

    await handover.save();

    res.status(200).json({
      success: true,
      message: "Handover deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};