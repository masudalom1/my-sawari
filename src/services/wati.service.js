import axios from "axios";

const API_URL = process.env.WATI_API_URL;
const TENANT_ID = process.env.WATI_TENANT_ID;
const API_TOKEN = process.env.WATI_API_TOKEN;

const formatPhone = (phone) => {
  return String(phone || "").replace(/\D/g, "");
};

const getHeaders = () => ({
  Authorization: `Bearer ${API_TOKEN}`,
});

export const createWatiContact = async (
  name,
  phone
) => {
  try {
    const mobile = formatPhone(phone);

    console.log(
      `Creating WATI Contact: ${mobile}`
    );

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v1/addContact/${mobile}`,
      {
        name,
      },
      {
        headers: {
          ...getHeaders(),
          "Content-Type": "application/json",
        },
      }
    );

    console.log(
      "CONTACT RESPONSE:",
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    return response.data;
  } catch (error) {
    console.log(
      "CONTACT ERROR:",
      error?.response?.data || error.message
    );

    return null;
  }
};

export const sendBookingConfirmation = async ({
  customer,
  vehicle,
  trip,
  payment,
}) => {
  try {
    const mobile = formatPhone(
      customer.mobileNumber
    );

    // Step 1: Create contact first
    await createWatiContact(
      customer.fullName,
      mobile
    );

    const pickupDate = new Date(
      trip.pickupDateTime
    ).toLocaleString("en-IN");

    const dropDate = new Date(
      trip.dropDateTime
    ).toLocaleString("en-IN");

    const message = `🚗 MY SAWARI BOOKING CONFIRMED

Customer: ${customer.fullName}

Vehicle:
${vehicle.vehicleName}
${vehicle.vehicleNumber}

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

Support:
+91 8638294494`;

    console.log("================================");
    console.log("PHONE:", mobile);
    console.log("MESSAGE:", message);
    console.log("================================");

    const params = new URLSearchParams();
    params.append(
      "messageText",
      message
    );

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v1/sendSessionMessage/${mobile}`,
      params,
      {
        headers: {
          ...getHeaders(),
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
      }
    );

    console.log(
      "========== WATI RESPONSE =========="
    );
    console.log(
      JSON.stringify(
        response.data,
        null,
        2
      )
    );
    console.log(
      "==================================="
    );

    return response.data;
  } catch (error) {
    console.log(
      "========== WATI ERROR =========="
    );
    console.log(
      "STATUS:",
      error?.response?.status
    );
    console.log(
      "DATA:",
      JSON.stringify(
        error?.response?.data,
        null,
        2
      )
    );
    console.log(
      "MESSAGE:",
      error?.message
    );
    console.log(
      "================================"
    );

    return null;
  }
};