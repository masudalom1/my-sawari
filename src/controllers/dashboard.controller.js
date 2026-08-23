import Vehicle from "../models/vehicle.model.js";

export const getVehiclesForImport = async (req, res) => {
  try {
    // Company comes from authenticated user
    const companyId = req.user.company || req.user._id;

    if (!companyId) {
      return res.status(401).json({
        success: false,
        message: "Company information not found",
      });
    }

    const vehicles = await Vehicle.find({
      company: companyId,
      isDeleted: false,
    })
      .select("_id vehicleName vehicleNumber images status")
      .sort({ vehicleName: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: vehicles.length,
      vehicles,
    });
  } catch (error) {
    console.error("Get vehicles for import error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch vehicle details",
      error: error.message,
    });
  }
};