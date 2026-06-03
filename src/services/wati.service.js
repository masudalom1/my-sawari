import axios from "axios";

const API_URL = process.env.WATI_API_URL;
const TENANT_ID = process.env.WATI_TENANT_ID;
const API_TOKEN = process.env.WATI_API_TOKEN;

const formatPhone = (phone) => {
  let mobile = String(phone || "").replace(/\D/g, "");

  if (!mobile.startsWith("91")) {
    mobile = `91${mobile}`;
  }

  return mobile;
};

export const sendBookingConfirmation = async ({
  customer,
  vehicle,
  trip,
  payment,
}) => {
  try {
    const mobile = formatPhone(customer.mobileNumber);

    const pickupDate = new Date(
      trip.pickupDateTime
    ).toLocaleString("en-IN");

    const dropDate = new Date(
      trip.dropDateTime
    ).toLocaleString("en-IN");

    const message = `MY SAWARI BOOKING CONFIRMED

Customer: ${customer.fullName}

Vehicle: ${vehicle.vehicleName}
${vehicle.vehicleNumber}

Pickup: ${pickupDate}
Drop: ${dropDate}

Fare: ₹${payment.totalFare}
Received: ₹${payment.amountReceived}
Pending: ₹${payment.pendingAmount}

Support: +918638294494`;

    console.log("================================");
    console.log("PHONE:", mobile);
    console.log("MESSAGE:", message);
    console.log("================================");

    // WATI expects form-urlencoded data
    const params = new URLSearchParams();
    params.append("messageText", message);

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v1/sendSessionMessage/${mobile}`,
      params,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("WATI RESPONSE:");
    console.log(JSON.stringify(response.data, null, 2));

    return response.data;
  } catch (error) {
    console.log("========== WATI ERROR ==========");
    console.log("STATUS:", error?.response?.status);
    console.log(
      "DATA:",
      JSON.stringify(error?.response?.data, null, 2)
    );
    console.log("MESSAGE:", error?.message);
    console.log("================================");

    return null;
  }
};

