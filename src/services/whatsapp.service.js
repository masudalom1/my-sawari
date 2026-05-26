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
    const cleanPhone = phoneNumber.replace(/\D/g, "");

    const formattedPhone = cleanPhone.startsWith("91")
      ? cleanPhone
      : `91${cleanPhone}`;

    const message = `Hello ${customerName} 👋

Welcome to MySawari 🚗

Your vehicle handover has been confirmed successfully.

Vehicle: ${vehicleName}
Vehicle Number: ${vehicleNumber}

Pickup Time: ${pickupDate}
Return Time: ${returnDate}

Need help? Contact our support team.

Thank you for choosing MySawari ❤️`;

    await axios.post(
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

    console.log("WhatsApp welcome message sent");
  } catch (error) {
    console.log(
      "WHATSAPP ERROR:",
      error?.response?.data || error.message
    );
  }
};