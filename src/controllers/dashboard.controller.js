import Vehicle from "../models/vehicle.model.js";

export const getVehiclesForImport = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({
      isDeleted: false,
    })
      .select("_id vehicleName vehicleNumber vehicleType images status")
      .sort({ vehicleName: 1 })
      .lean();

    const formattedVehicles = vehicles.map((vehicle) => ({
      _id: vehicle._id,
      vehicleName: vehicle.vehicleName,
      vehicleNumber: vehicle.vehicleNumber,
      vehicleType: vehicle.vehicleType,
      image: vehicle.images?.[0]?.url || null,
      status: vehicle.status,
    }));

    return res.status(200).json({
      success: true,
      count: formattedVehicles.length,
      vehicles: formattedVehicles,
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