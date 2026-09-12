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

const formatDateTime = (date) => {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(date));
};

export const sendBookingConfirmation = async ({
  customer,
  vehicle,
  trip,
  payment,
}) => {
  try {
    const mobile = formatPhone(customer.mobileNumber);

    const payload = {
      template_name: "booking_confirmation_v2",
      broadcast_name: `booking_${Date.now()}`,
      parameters: [
        {
          name: "1",
          value: customer.fullName || "Customer",
        },
        {
          name: "2",
          value:
            vehicle.vehicleName ||
            vehicle.vehicleNumber ||
            "Vehicle",
        },
        {
          name: "3",
          value: formatDateTime(
            trip.pickupDateTime
          ),
        },
        {
          name: "4",
          value: formatDateTime(
            trip.dropDateTime
          ),
        },
        {
          name: "5",
          value: String(
            payment.totalAmount || 0
          ),
        },
      ],
    };

    console.log("========== WATI TEMPLATE REQUEST ==========");
    console.log("Mobile:", mobile);
    console.log(
      JSON.stringify(payload, null, 2)
    );

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v2/sendTemplateMessage?whatsappNumber=${mobile}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("========== WATI SUCCESS ==========");
    console.log(
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.log("========== WATI ERROR ==========");

    console.log("Status:");
    console.log(
      error?.response?.status
    );

    console.log("Response:");
    console.log(
      JSON.stringify(
        error?.response?.data,
        null,
        2
      )
    );

    console.log("Message:");
    console.log(error.message);

    return {
      success: false,
      error:
        error?.response?.data ||
        error.message,
    };
  }
};

export const sendBookingCreatedMessage = async (mobileNumber) => {
  try {
    const mobile = formatPhone(mobileNumber);

    const payload = {
      template_name: "booking_confirmation_message",
      broadcast_name: `booking_created_${Date.now()}`,
    };

    console.log("========== WATI BOOKING MESSAGE ==========");
    console.log("Mobile:", mobile);
    console.log("Payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v2/sendTemplateMessage?whatsappNumber=${mobile}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("========== WATI SUCCESS ==========");
    console.log(
      JSON.stringify(response.data, null, 2)
    );

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.log("========== WATI ERROR ==========");

    console.log("Status:", error?.response?.status);

    console.log(
      "Response:",
      JSON.stringify(
        error?.response?.data,
        null,
        2
      )
    );

    console.log("Message:", error.message);

    return {
      success: false,
      error:
        error?.response?.data ||
        error.message,
    };
  }
};