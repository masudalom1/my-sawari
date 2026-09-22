import Handover from "../models/handover.model.js";
import Vehicle from "../models/vehicle.model.js";
import VehicleReturn from "../models/vehicleReturn.model.js";
import Booking from "../models/booking.model.js";
import PaymentHistory from "../models/paymentHistory.model.js";

export const receiveVehicle = async (req, res) => {
  try {
    const { handoverId } = req.params;

    const {
      fuelLevel,
      kilometersAtReturn,
      hasDamage,
      damageNotes,
      inspection,

      repairEstimate,
      repairDays,

      lateReturnFine,
      extraKmFine,
      fuelUsageAmount,
      amountCollected,
      paymentMode,
      paymentBreakdown, // ADDED: raw breakdown value coming from FormData (arrives as a JSON string)
      balanceReason,
      upiLast4,

      needsMaintenance,
      maintenanceReason,
      maintenanceDays,
    } = req.body;

    const files = req.files || {};

    /* ==========================
       BASIC VALIDATION
    ========================== */

    if (!fuelLevel || !kilometersAtReturn) {
      return res.status(400).json({
        success: false,
        message: "Fuel level and kilometers at return are required",
      });
    }

    if (
      !files.vehicleFront?.[0] ||
      !files.vehicleRear?.[0] ||
      !files.vehicleLeft?.[0] ||
      !files.vehicleRight?.[0]
    ) {
      return res.status(400).json({
        success: false,
        message: "Front, Rear, Left and Right vehicle images are required",
      });
    }

    /* ==========================
       FIND HANDOVER
    ========================== */
    const handover = await Handover.findById(handoverId);

    if (!handover) {
      return res
        .status(404)
        .json({ success: false, message: "Handover not found" });
    }

    const companyId = handover.company;

    if (handover.handoverStatus === "returned") {
      return res.status(400).json({
        success: false,
        message: "Vehicle already received",
      });
    }

    /* ==========================
       FIND VEHICLE
    ========================== */

    const vehicleId = handover.vehicle?.vehicleId || handover.vehicle;

    const vehicle = await Vehicle.findById(vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    if (vehicle.status !== "rent") {
      return res.status(400).json({
        success: false,
        message: "Vehicle is not currently on rent",
      });
    }

    /* ==========================
       EXISTING RETURN CHECK
    ========================== */

    const existingReturn = await VehicleReturn.findOne({
      handover: handoverId,
    });

    if (existingReturn) {
      return res.status(400).json({
        success: false,
        message: "Return already submitted",
      });
    }

    /* ==========================
       INSPECTION PARSE
    ========================== */

    let parsedInspection = [];

    try {
      if (inspection) {
        parsedInspection =
          typeof inspection === "string" ? JSON.parse(inspection) : inspection;
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid inspection data format",
      });
    }

    let parsedPaymentBreakdown = { cash: 0, phonePe: 0, razorpay: 0 }; // ADDED

    try {
      if (paymentBreakdown) {
        const raw =
          typeof paymentBreakdown === "string"
            ? JSON.parse(paymentBreakdown)
            : paymentBreakdown;

        parsedPaymentBreakdown = {
          cash: Number(raw?.cash) || 0,
          phonePe: Number(raw?.phonePe) || 0,
          razorpay: Number(raw?.razorpay) || 0,
        };
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment breakdown format",
      }); // ADDED
    }

    const ALLOWED_PAYMENT_MODES = ["Cash", "PhonePe", "Razorpay", "Mixed"];
    const normalizedPaymentMode = ALLOWED_PAYMENT_MODES.includes(paymentMode)
      ? paymentMode
      : "Cash";
    let normalizedUpiLast4 = [];

    try {
      normalizedUpiLast4 =
        typeof upiLast4 === "string" ? JSON.parse(upiLast4) : upiLast4;

      if (!Array.isArray(normalizedUpiLast4)) {
        normalizedUpiLast4 = [];
      }

      normalizedUpiLast4 = normalizedUpiLast4
        .map((value) => String(value).trim())
        .filter(Boolean);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid UPI last 4 digits format",
      });
    }

    const isUpiPayment =
      normalizedPaymentMode === "PhonePe" ||
      (normalizedPaymentMode === "Mixed" && parsedPaymentBreakdown.phonePe > 0);

    if (
      isUpiPayment &&
      (normalizedUpiLast4.length === 0 ||
        normalizedUpiLast4.some((value) => !/^\d{4}$/.test(value)))
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid UPI last 4 digits",
      });
    }

    if (normalizedPaymentMode !== "Mixed" && !paymentBreakdown) {
      const singleAmount = Number(amountCollected) || 0;
      parsedPaymentBreakdown = {
        cash: normalizedPaymentMode === "Cash" ? singleAmount : 0,
        phonePe: normalizedPaymentMode === "PhonePe" ? singleAmount : 0,
        razorpay: normalizedPaymentMode === "Razorpay" ? singleAmount : 0,
      };
    }

    /* ==========================
       DAMAGE DATA
    ========================== */

    const isDamaged = hasDamage === true || hasDamage === "true";

    const damageImages = files.damageImages?.map((file) => file.path) || [];

    if (isDamaged && damageImages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Damage images are required when damage is reported",
      });
    }

    /* ==========================
       ADDITIONAL IMAGES (optional)
       No validation — user may
       upload zero, one, or many.
    ========================== */

    const additionalImages =
      files.additionalImages?.map((file) => file.path) || [];

    const maintenanceRequired =
      needsMaintenance === true ||
      needsMaintenance === "true" ||
      needsMaintenance === "yes";

    if (maintenanceRequired && !maintenanceReason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Maintenance reason is required",
      });
    }

    if (
      maintenanceRequired &&
      (!maintenanceDays || Number(maintenanceDays) <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Maintenance days are required",
      });
    }

    const estimate = Number(repairEstimate) || 0;

    const repairDuration = Number(repairDays) || 0;

    /* ==========================
       SETTLEMENT CALCULATIONS
    ========================== */

    const pendingAmount =
      Number(handover.payment?.billSummary?.balanceAmount) || 0;

    const lateFine = Number(lateReturnFine) || 0;

    const kmFine = Number(extraKmFine) || 0;

    const fuelFine = Number(fuelUsageAmount) || 0;

    const collected = Number(amountCollected) || 0;

    const totalBalanceAmount =
      pendingAmount + lateFine + kmFine + fuelFine + estimate;

    const finalBalance = Math.max(totalBalanceAmount - collected, 0);

    /* ==========================
       VALIDATE REASON
    ========================== */

    if (finalBalance > 0 && !balanceReason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Reason is required when full amount is not collected",
      });
    }

    // ADDED: server-side guard mirroring the frontend's mixed-payment
    // validation — the breakdown total must actually match the amount
    // collected so settlementDetails and PaymentHistory never drift.
    if (normalizedPaymentMode === "Mixed") {
      const mixedTotal =
        parsedPaymentBreakdown.cash +
        parsedPaymentBreakdown.phonePe +
        parsedPaymentBreakdown.razorpay;

      if (mixedTotal <= 0) {
        return res.status(400).json({
          success: false,
          message: "Please provide mixed payment amounts",
        });
      }

      if (Math.round(mixedTotal) !== Math.round(collected)) {
        return res.status(400).json({
          success: false,
          message:
            "Payment breakdown total does not match the amount collected",
        });
      }

      if (mixedTotal > totalBalanceAmount) {
        return res.status(400).json({
          success: false,
          message: "Received amount cannot exceed total balance",
        });
      }
    }

    /* ==========================
       SETTLEMENT STATUS
    ========================== */

    let settlementStatus = "Pending Collection";

    if (totalBalanceAmount === 0 || collected >= totalBalanceAmount) {
      settlementStatus = "Collected";
    } else if (collected > 0) {
      settlementStatus = "Partially Collected";
    }
    /* ==========================
   TIME CALCULATIONS
========================== */

    const actualReceivingTime = new Date();

    const scheduledReturnTime = new Date(handover.trip.dropDateTime);

    const diffMs = actualReceivingTime - scheduledReturnTime;

    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    let timeStatus = "On Time";
    let delayInMinutes = 0;
    let delayText = "0 minutes";

    if (diffMinutes > 15) {
      // More than 15 minutes late
      timeStatus = "Delayed";

      delayInMinutes = diffMinutes;

      const days = Math.floor(delayInMinutes / (24 * 60));

      const hours = Math.floor((delayInMinutes % (24 * 60)) / 60);

      const mins = delayInMinutes % 60;

      delayText =
        `${days > 0 ? `${days}d ` : ""}` +
        `${hours > 0 ? `${hours}h ` : ""}` +
        `${mins}m`;
    } else if (diffMinutes < -15) {
      // More than 15 minutes early
      timeStatus = "Before Time";

      delayText = "Received Early";
    }

    /* ==========================
       CREATE RETURN
    ========================== */

    const vehicleReturn = await VehicleReturn.create({
      company: companyId,

      createdBy: req.user._id,

      // New fields
      receivedBy: req.user._id,

      receivingTime: actualReceivingTime,

      scheduledReturnTime,

      timeStatus,

      delayInMinutes,

      delayText,

      handover: handover._id,

      vehicle: vehicle._id,

      customerName: handover.customer?.fullName || "",

      fuelLevel: Number(fuelLevel),

      kilometersAtReturn: Number(kilometersAtReturn),

      hasDamage: isDamaged,

      damageNotes: damageNotes || "",

      inspection: parsedInspection,

      maintenanceDetails: {
        required: maintenanceRequired,

        reason: maintenanceReason || "",

        estimatedDays: Number(maintenanceDays) || 0,

        estimatedCompletionDate: maintenanceRequired
          ? new Date(Date.now() + Number(maintenanceDays) * 24 * 60 * 60 * 1000)
          : null,
      },

      /* ======================
     VEHICLE RETURN IMAGES
  ====================== */
      images: {
        vehicleFront: files.vehicleFront?.[0]?.path || "",
        vehicleRear: files.vehicleRear?.[0]?.path || "",
        vehicleLeft: files.vehicleLeft?.[0]?.path || "",
        vehicleRight: files.vehicleRight?.[0]?.path || "",

        tyreFrontLeft: files.tyreFrontLeft?.[0]?.path || "",
        tyreFrontRight: files.tyreFrontRight?.[0]?.path || "",
        tyreRearLeft: files.tyreRearLeft?.[0]?.path || "",
        tyreRearRight: files.tyreRearRight?.[0]?.path || "",
        spareTyre: files.spareTyre?.[0]?.path || "",
        toolkit: files.toolkit?.[0]?.path || "",
      },

      /* ======================
     DAMAGE IMAGES
  ====================== */

      damageImages,

      /* ======================
     ADDITIONAL IMAGES (optional)
  ====================== */

      additionalImages,

      /* ======================
     DAMAGE DETAILS
  ====================== */

      damageCostDetails: isDamaged
        ? {
            repairEstimate: estimate,

            repairDays: repairDuration,

            actualRepairCost: 0,

            repairedAt: null,

            remarks: "",

            status: "Pending",
          }
        : undefined,

      /* ======================
     SETTLEMENT DETAILS
  ====================== */

      settlementDetails: {
        pendingAmount,

        lateReturnFine: lateFine,

        extraKmFine: kmFine,

        fuelUsageAmount: fuelFine,

        damageAmount: estimate,

        totalBalanceAmount,

        amountCollected: collected,

        paymentMode: normalizedPaymentMode,
        paymentBreakdown: parsedPaymentBreakdown,

        finalBalance,

        balanceReason: balanceReason || "",

        status: settlementStatus,

        settledAt: new Date(),
      },

      returnStatus: "completed",
    });

    /* ==========================================================
   PAYMENT HISTORY
   Create a separate payment record for money collected
   during vehicle return.
========================================================== */

    const receivedAmount = Number(amountCollected) || 0;

    if (receivedAmount > 0) {
      try {
        // --------------------------------------------------------
        // NORMALIZE PAYMENT METHOD
        // --------------------------------------------------------

        const finalPaymentMethod = (() => {
          const mode = String(normalizedPaymentMode || "Cash").toLowerCase();

          const paymentMethodMap = {
            cash: "cash",
            phonepe: "phonepe",
            razorpay: "razorpay",
            mixed: "mixed",
          };

          return paymentMethodMap[mode] || "cash";
        })();

        // --------------------------------------------------------
        // CREATE PAYMENT HISTORY
        // --------------------------------------------------------

        const paymentHistory = await PaymentHistory.create({
          company: companyId,

          bookingId: handover.bookingId || null,

          handoverId: handover._id,

          // ------------------------------------------------------
          // CUSTOMER
          // ------------------------------------------------------

          customer: {
            fullName: handover.customer?.fullName || "",
            mobileNumber: handover.customer?.mobileNumber || "",
          },

          // ------------------------------------------------------
          // VEHICLE
          // ------------------------------------------------------

          vehicle: {
            vehicleId: vehicle._id,

            vehicleName: vehicle.vehicleName || "",

            vehicleNumber: vehicle.vehicleNumber || "",
          },

          // ------------------------------------------------------
          // RENTAL / BOOKING PERIOD
          // IMPORTANT:
          // Store the actual rental period with every payment.
          // ------------------------------------------------------

          booking: {
            fromDate: handover.trip?.pickupDateTime || null,

            toDate: handover.trip?.dropDateTime || null,

            bookingAmount: Number(handover.payment?.totalAmount) || 0,
          },

          // ------------------------------------------------------
          // PAYMENT AMOUNT
          // ------------------------------------------------------

          amount: receivedAmount,

          // ------------------------------------------------------
          // PAYMENT METHOD
          // ------------------------------------------------------

          paymentMethod: finalPaymentMethod,

          // ------------------------------------------------------
          // PHONEPE UPI REFERENCES
          // ------------------------------------------------------

          upiLast4: isUpiPayment ? normalizedUpiLast4 : [],

          // ------------------------------------------------------
          // PAYMENT BREAKDOWN
          // ------------------------------------------------------

          paymentBreakdown: {
            cash: Number(parsedPaymentBreakdown?.cash) || 0,

            phonePe: Number(parsedPaymentBreakdown?.phonePe) || 0,

            razorpay: Number(parsedPaymentBreakdown?.razorpay) || 0,
          },

          // ------------------------------------------------------
          // PAYMENT TYPE
          // ------------------------------------------------------

          type: "receive",

          // ------------------------------------------------------
          // NOTE
          // ------------------------------------------------------

          note:
            balanceReason?.trim() || "Payment received during vehicle return",

          // ------------------------------------------------------
          // CREATED BY
          // ------------------------------------------------------

          createdBy: req.user?._id || null,
        });

        // --------------------------------------------------------
        // CONNECT PAYMENT HISTORY TO VEHICLE
        // --------------------------------------------------------

        if (vehicle?._id && paymentHistory?._id) {
          await Vehicle.findByIdAndUpdate(vehicle._id, {
            $push: {
              payments: paymentHistory._id,
            },
          });
        }

        console.log(
          "Vehicle Return Payment History Created:",
          paymentHistory._id.toString(),
        );
      } catch (paymentHistoryError) {
        // --------------------------------------------------------
        // IMPORTANT:
        // Don't silently hide the actual error.
        // --------------------------------------------------------

        console.error(
          "RECEIVE PAYMENT HISTORY CREATION ERROR:",
          paymentHistoryError,
        );

        console.error(
          "PAYMENT HISTORY ERROR MESSAGE:",
          paymentHistoryError?.message,
        );
      }
    }

    /* ==========================
       UPDATE VEHICLE
    ========================== */

    if (maintenanceRequired) {
      const estimatedDays = Number(maintenanceDays) || 0;

      const completionDate = new Date();

      completionDate.setDate(completionDate.getDate() + estimatedDays);

      vehicle.status = "service";

      vehicle.maintenance = {
        required: true,

        reason: maintenanceReason || "",

        estimatedDays,

        estimatedCompletionDate: completionDate,

        markedBy: req.user._id,

        markedAt: new Date(),
      };
    } else {
      vehicle.status = "available";

      vehicle.maintenance = {
        required: false,

        reason: "",

        estimatedDays: 0,

        estimatedCompletionDate: null,

        markedBy: null,

        markedAt: null,
      };
    }

    await vehicle.save();

    /* ==========================
       UPDATE HANDOVER
    ========================== */

    handover.handoverStatus = "returned";

    handover.returnDetails = {
      returnedAt: new Date(),
      returnedBy: req.user._id,
      remarks: balanceReason || "",
    };

    handover.payment.balanceAmount = finalBalance;

    if (finalBalance === 0) {
      handover.payment.paymentStatus = "paid";
    } else if (collected > 0) {
      handover.payment.paymentStatus = "partial";
    } else {
      handover.payment.paymentStatus = "pending";
    }

    // ── Fold the return-time settlement into payment.billSummary too,
    // since that's the single object every screen (handover details,
    // vehicle-return details, dashboards) renders the bill from. Without
    // this, billSummary would keep showing the pre-return numbers even
    // though fines/damage were added and money was collected just now.
    const existingBill = handover.payment.billSummary || {};

    // Fines/damage collected during return count as extra charges on
    // top of whatever was already billed at handover time.
    const returnTimeExtras = lateFine + kmFine + fuelFine + estimate;

    const updatedExtraCharges =
      Number(existingBill.extraCharges || 0) + returnTimeExtras;

    const updatedTotalAmount =
      Number(existingBill.totalAmount || 0) + returnTimeExtras;

    const updatedTotalCollected =
      Number(existingBill.totalCollected || 0) + collected;

    const updatedAmountReceivedNow =
      Number(existingBill.amountReceivedNow || 0) + collected;

    handover.payment.billSummary = {
      ...existingBill,
      extraCharges: updatedExtraCharges,
      totalAmount: updatedTotalAmount,
      amountReceivedNow: updatedAmountReceivedNow,
      totalCollected: updatedTotalCollected,
      balanceAmount: finalBalance,
    };

    handover.markModified("payment.billSummary");

    await handover.save();

    /* ==========================
   UPDATE BOOKING
========================== */

    if (handover.bookingId) {
      const booking = await Booking.findByIdAndUpdate(
        handover.bookingId,
        {
          $set: {
            toDate: actualReceivingTime,
            status: "completed",
          },
        },
        {
          new: true,
          runValidators: true,
        },
      );

      if (!booking) {
        console.warn(`Booking not found: ${handover.bookingId}`);
      }
    }

    /* ==========================
       RESPONSE
    ========================== */

    return res.status(201).json({
      success: true,
      message: "Vehicle received successfully",
      data: vehicleReturn,
    });
  } catch (error) {
    console.error("RECEIVE VEHICLE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error",
    });
  }
};

export const getServiceVehicles = async (req, res) => {
  try {
    const companyId = req.user.company || req.user._id;

    const vehicles = await Vehicle.find({
      company: companyId,
      isDeleted: false,
      status: "service",
    })
      .populate("maintenance.markedBy", "fullName role")
      .sort({
        "maintenance.markedAt": -1,
      });

    const data = vehicles.map((vehicle) => {
      const today = new Date();

      const completionDate = vehicle.maintenance?.estimatedCompletionDate;

      let remainingDays = 0;

      if (completionDate) {
        remainingDays = Math.ceil(
          (new Date(completionDate) - today) / (1000 * 60 * 60 * 24),
        );
      }

      return {
        _id: vehicle._id,

        vehicleName: vehicle.vehicleName,
        vehicleNumber: vehicle.vehicleNumber,
        manufacturer: vehicle.manufacturer,
        model: vehicle.model,
        variant: vehicle.variant,
        color: vehicle.color,

        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        transmission: vehicle.transmission,
        seatingCapacity: vehicle.seatingCapacity,

        status: vehicle.status,

        images: vehicle.images,

        maintenance: {
          required: vehicle.maintenance?.required || false,

          reason: vehicle.maintenance?.reason || "",

          estimatedDays: vehicle.maintenance?.estimatedDays || 0,

          estimatedCompletionDate: vehicle.maintenance?.estimatedCompletionDate,

          remainingDays,

          markedAt: vehicle.maintenance?.markedAt,

          markedBy: vehicle.maintenance?.markedBy
            ? {
                _id: vehicle.maintenance.markedBy._id,
                fullName: vehicle.maintenance.markedBy.fullName,
                role: vehicle.maintenance.markedBy.role,
              }
            : null,
        },
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("GET SERVICE VEHICLES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch service vehicles",
    });
  }
};
export const markVehicleAvailable = async (req, res) => {
  try {
    const { id } = req.params;

    const companyId = req.user.company || req.user._id;

    const vehicle = await Vehicle.findOne({
      _id: id,
      company: companyId,
      isDeleted: false,
    });

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found",
      });
    }

    vehicle.status = "available";

    vehicle.maintenance = {
      required: false,
      reason: "",
      estimatedDays: 0,
      estimatedCompletionDate: null,
      markedBy: null,
      markedAt: null,
    };

    await vehicle.save();

    return res.status(200).json({
      success: true,
      message: "Vehicle marked as available",
      data: vehicle,
    });
  } catch (error) {
    console.error("MARK AVAILABLE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getReturnDetails = async (req, res) => {
  try {
    const { handoverId } = req.params;

    const vehicleReturn = await VehicleReturn.findOne({ handover: handoverId })
      // Vehicle info block on screen — exactly the fields InfoRow renders,
      // plus `images` (used by "Vehicle Catalog Photos").
      .populate({
        path: "vehicle",
        select:
          "vehicleName vehicleNumber manufacturer model variant color images",
      })
      // "Received By" row.
      .populate("receivedBy", "fullName role")
      // Handover: trimmed to just the three things the screen reads —
      // customer (for the Customer Information card), payment.billSummary
      // (for the Bill Details card), and createdAt (for the Timeline's
      // "Booking Created" entry). Everything else that used to be
      // populated here (bookingId, extensionBills, vehicleHistory,
      // returnDetails, handover.vehicle.vehicleId, company) isn't
      // referenced anywhere in the detail screen — populating them was
      // pure wasted work on every request.
      .populate({
        path: "handover",
        select: "customer payment.billSummary createdAt",
        populate: {
          path: "customer",
          select: "fullName mobileNumber",
        },
      })
      // .lean() — this response is read-only JSON going straight to the
      // client, so there's no need to pay for a full hydrated Mongoose
      // document with change-tracking, virtuals, etc.
      .lean();

    if (!vehicleReturn) {
      return res.status(404).json({
        success: false,
        message: "Return details not found for this handover",
      });
    }

    return res.status(200).json({
      success: true,
      data: vehicleReturn,
    });
  } catch (error) {
    console.error("GET RETURN DETAILS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error",
    });
  }
};

export const getVehicleReturnsDashboard = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 15, 1),
      50,
    );
    const tab = req.query.tab || "All"; // "All" | "Today" | "Yesterday" | "Due"

    const getISTDate = (date) =>
      new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    const now = new Date();
    const today = getISTDate(now);
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = getISTDate(yesterdayDate);

    // Real Date boundaries (not stringified comparisons) so Mongo can use
    // the createdAt index for a range match instead of loading every
    // document into Node just to compare dates in JS.
    const istStart = (dateStr) => new Date(`${dateStr}T00:00:00+05:30`);
    const todayStart = istStart(today);
    const yesterdayStart = istStart(yesterday);
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);

    // Build the filter for the tab that's actually being viewed — we only
    // ever query the slice the user is looking at, never the whole table.
    const match = {};
    if (tab === "Today")
      match.createdAt = { $gte: todayStart, $lt: tomorrowStart };
    else if (tab === "Yesterday")
      match.createdAt = { $gte: yesterdayStart, $lt: todayStart };
    else if (tab === "Due") match.isDue = true;

    // ---- Stats: pure indexed counts, no document bodies fetched at all ----
    // These run in parallel and stay fast at any collection size because
    // they only touch indexes, never actual row data.
    const [total, todayCount, yesterdayCount, dueCount] = await Promise.all([
      VehicleReturn.countDocuments({}),
      VehicleReturn.countDocuments({
        createdAt: { $gte: todayStart, $lt: tomorrowStart },
      }),
      VehicleReturn.countDocuments({
        createdAt: { $gte: yesterdayStart, $lt: todayStart },
      }),
      VehicleReturn.countDocuments({ isDue: true }),
    ]);
    const stats = {
      total,
      today: todayCount,
      yesterday: yesterdayCount,
      due: dueCount,
    };

    // ---- Page of cards: only the fields the list card actually renders ----
    // .lean() skips building full Mongoose documents (notably faster for
    // read-only responses), and trimmed .select()/populate keeps the
    // payload small so the response serializes and transfers quickly.
    const rows = await VehicleReturn.find(match)
      .select(
        "vehicle handover receivedBy fuelLevel kilometersAtReturn receivingTime " +
          "scheduledReturnTime timeStatus delayText hasDamage damageCostDetails " +
          "customerName mobileNumber balanceAmount isDue createdAt updatedAt",
      )
      .populate({
        path: "vehicle",
        select: "vehicleName vehicleNumber manufacturer model variant color",
      })
      .populate({
        path: "handover",
        select:
          "customer payment.billSummary.totalAmount payment.billSummary.amountReceivedNow payment.billSummary.totalCollected",
        populate: { path: "customer", select: "fullName mobileNumber" },
      })
      .populate("receivedBy", "fullName")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const dashboard = rows.map((item) => {
      const returnDate = getISTDate(item.createdAt);
      let itemTab = "Older";
      if (returnDate === today) itemTab = "Today";
      else if (returnDate === yesterday) itemTab = "Yesterday";

      const billSummary = item.handover?.payment?.billSummary || {};
      const totalAmount = billSummary.totalAmount || 0;
      const amountReceivedNow = billSummary.amountReceivedNow || 0;
      const totalCollected = billSummary.totalCollected || 0;
      const balanceAmount = item.balanceAmount || 0;
      const isDue = !!item.isDue;

      return {
        _id: item._id,
        handoverId: item.handover?._id,
        tab: itemTab,
        isDue,
        customerName:
          item.customerName || item.handover?.customer?.fullName || "",
        mobileNumber:
          item.mobileNumber || item.handover?.customer?.mobileNumber || "",
        vehicleName: item.vehicle?.vehicleName || "",
        vehicleNumber: item.vehicle?.vehicleNumber || "",
        manufacturer: item.vehicle?.manufacturer || "",
        model: item.vehicle?.model || "",
        variant: item.vehicle?.variant || "",
        color: item.vehicle?.color || "",
        fuelLevel: item.fuelLevel ?? 0,
        kilometersAtReturn: item.kilometersAtReturn ?? 0,
        returnTime: item.receivingTime,
        scheduledReturnTime: item.scheduledReturnTime,
        timeStatus: item.timeStatus || "On Time",
        delayText: item.delayText || "",
        hasDamage: item.hasDamage || false,
        damageStatus: item.damageCostDetails?.status || "",
        repairEstimate: item.damageCostDetails?.repairEstimate || 0,
        totalAmount,
        amountReceivedNow,
        totalCollected,
        pendingAmount: balanceAmount,
        totalBalance: totalAmount,
        amountCollected: totalCollected || amountReceivedNow,
        finalBalance: balanceAmount,
        settlementStatus: balanceAmount > 0 ? "pending" : "paid",
        receivedBy: item.receivedBy?.fullName || "",
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    return res.status(200).json({
      success: true,
      stats,
      page,
      limit,
      hasMore:
        page * limit <
        (tab === "Due"
          ? dueCount
          : tab === "Today"
            ? todayCount
            : tab === "Yesterday"
              ? yesterdayCount
              : total),
      returns: dashboard,
    });
  } catch (error) {
    console.error("Vehicle Returns Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch dashboard",
    });
  }
};
