import axios from "axios";

const API_URL = process.env.WATI_API_URL;
const TENANT_ID = process.env.WATI_TENANT_ID;
const API_TOKEN = process.env.WATI_API_TOKEN;

// Callers await these before responding, so a slow WATI must not hang the request.
const WATI_TIMEOUT_MS = 15000;

const isConfigured = () => Boolean(API_URL && TENANT_ID && API_TOKEN);

// Logs only the last 4 digits of the customer's number.
const maskPhone = (mobile) => `******${String(mobile).slice(-4)}`;

// WATI answers HTTP 200 with { result: false, info } for e.g. invalid numbers.
const failedResult = (data) =>
  data?.result === false ? data.info || data.message || "WATI rejected the message" : null;

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
    if (!isConfigured()) {
      console.warn("WATI is not configured; booking confirmation not sent.");
      return { success: false, error: "WATI is not configured" };
    }

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
    console.log("Mobile:", maskPhone(mobile));
    console.log("Template:", payload.template_name);

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v2/sendTemplateMessage?whatsappNumber=${mobile}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: WATI_TIMEOUT_MS,
      }
    );

    const rejection = failedResult(response.data);
    if (rejection) {
      console.log("========== WATI REJECTED ==========");
      console.log(rejection);
      return { success: false, error: rejection };
    }

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
    if (!isConfigured()) {
      console.warn("WATI is not configured; booking created message not sent.");
      return { success: false, error: "WATI is not configured" };
    }

    const mobile = formatPhone(mobileNumber);

    const payload = {
      template_name: "booking_confirmation_message",
      broadcast_name: `booking_created_${Date.now()}`,
    };

    console.log("========== WATI BOOKING MESSAGE ==========");
    console.log("Mobile:", maskPhone(mobile));
    console.log("Payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `${API_URL}/${TENANT_ID}/api/v2/sendTemplateMessage?whatsappNumber=${mobile}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: WATI_TIMEOUT_MS,
      }
    );

    const rejection = failedResult(response.data);
    if (rejection) {
      console.log("========== WATI REJECTED ==========");
      console.log(rejection);
      return { success: false, error: rejection };
    }

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