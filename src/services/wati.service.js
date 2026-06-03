import axios from "axios";

const API_URL = process.env.WATI_API_URL;
const TENANT_ID = process.env.WATI_TENANT_ID;
const API_TOKEN = process.env.WATI_API_TOKEN;

const getHeaders = () => ({
  Authorization: `Bearer ${API_TOKEN}`,
  "Content-Type": "application/json",
});

const formatPhone = (phone) => {
  let mobile = String(phone).replace(/\D/g, "");

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

    const pickupDate = new Date(trip.pickupDateTime).toLocaleString("en-IN");

    const dropDate = new Date(trip.dropDateTime).toLocaleString("en-IN");

    const message = `🚗 MY SAWARI BOOKING CONFIRMED

Dear ${customer.fullName},

Your booking has been confirmed.

━━━━━━━━━━━━━━

Vehicle:
${vehicle.vehicleName}
(${vehicle.vehicleNumber})

Destination:
${customer.destination}

Pickup:
${pickupDate}

Drop:
${dropDate}

Fare:
₹${payment.totalFare}

Received:
₹${payment.amountReceived}

Pending:
₹${payment.pendingAmount}

━━━━━━━━━━━━━━

Thank you for choosing My Sawari.

For support:
📞 +918638294494`;

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v1/sendSessionMessage/${mobile}`,
      {
        messageText: message,
      },
      {
        headers: getHeaders(),
      },
    );

    console.log("WATI RESPONSE DATA:");
    console.log(JSON.stringify(response.data, null, 2));

    return response.data;
  } catch (error) {
    console.error("WATI ERROR:", error?.response?.data || error.message);

    return null;
  }
};
