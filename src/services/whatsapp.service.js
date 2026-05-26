import axios from "axios";

export const sendWhatsAppWelcomeMessage = async ({
  phoneNumber,
  customerName,
  vehicleName,
  vehicleNumber,
  pickupDate,
  returnDate,
}) => {
  try {
    console.log("ENV TOKEN:", process.env.WHATSAPP_TOKEN ? "FOUND" : "MISSING");
    console.log("PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
    console.log("RAW PHONE:", phoneNumber);

    const cleanPhone = String(phoneNumber).replace(/\D/g, "");

    const formattedPhone = cleanPhone.startsWith("91")
      ? cleanPhone
      : `91${cleanPhone}`;

    console.log("FORMATTED PHONE:", formattedPhone);

    const message = `Hello ${customerName} 👋

Welcome to MySawari 🚗

Your vehicle handover has been confirmed successfully.

Vehicle: ${vehicleName}
Vehicle Number: ${vehicleNumber}

Pickup Time: ${pickupDate}
Return Time: ${returnDate}

Thank you for choosing MySawari ❤️`;

    const response = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: formattedPhone,
        type: "text",
        text: {
          body: message,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("WHATSAPP SUCCESS:", response.data);
  } catch (error) {
    console.log(
      "WHATSAPP FULL ERROR:",
      error?.response?.data || error.message
    );
  }
};