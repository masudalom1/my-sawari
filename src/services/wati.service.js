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
    const mobile = formatPhone(
      customer.mobileNumber
    );

    const payload = {
      template_name: "booking_confirmation",
      broadcast_name: `booking_${Date.now()}`,
      parameters: [
        {
          name: "name",
          value: customer.fullName,
        },
        {
          name: "vehicle",
          value: vehicle.vehicleName,
        },
        {
          name: "pickup",
          value: new Date(
            trip.pickupDateTime
          ).toLocaleString("en-IN"),
        },
        {
          name: "drop",
          value: new Date(
            trip.dropDateTime
          ).toLocaleString("en-IN"),
        },
        {
          name: "fare",
          value: String(payment.totalFare),
        },
      ],
    };

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

    console.log(
      "TEMPLATE RESPONSE:"
    );
    console.log(
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    return response.data;
  } catch (error) {
    console.log(
      "TEMPLATE ERROR:"
    );
    console.log(
      error?.response?.data ||
        error.message
    );

    return null;
  }
};