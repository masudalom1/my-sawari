import axios from "axios";

const API_URL = process.env.WATI_API_URL?.trim().replace(/\/+$/, "");
const TENANT_ID = process.env.WATI_TENANT_ID;
const API_TOKEN = process.env.WATI_API_TOKEN;

// Callers await these before responding, so a slow WATI must not hang the request.
const WATI_TIMEOUT_MS = 15000;
const BOOKING_CREATED_TEMPLATE = "booking_confirmation_message";

const isConfigured = () => Boolean(API_URL && TENANT_ID && API_TOKEN);

// Logs only the last 4 digits of the customer's number.
const maskPhone = (mobile) => `******${String(mobile).slice(-4)}`;

// WATI answers HTTP 200 with { result: false, info } for e.g. invalid numbers.
const failedResult = (data) => {
  if (data?.result === true) return null;
  if (data?.result === false) return data.info || data.message || "WATI rejected the message";
  return "WATI returned an unconfirmed API response";
};

const formatPhone = (phone) => {
  const value = String(phone || "").trim();
  if (!/^\+?[\d\s()-]+$/.test(value)) return "";
  let mobile = value.replace(/\D/g, "");
  if (mobile.startsWith("00")) mobile = mobile.slice(2);
  if (!value.startsWith("+") && mobile.length === 11 && mobile.startsWith("0")) mobile = mobile.slice(1);
  // Decide from length as well as prefix: an Indian local number may begin 91.
  if (!value.startsWith("+") && mobile.length === 10) mobile = `91${mobile}`;
  return /^[1-9]\d{7,14}$/.test(mobile) ? mobile : "";
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
    if (!mobile) return { success: false, error: "Invalid customer mobile number" };

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

const templateConfigurationError = (reason) => {
  const error = `WATI template configuration error: ${BOOKING_CREATED_TEMPLATE} ${reason}`;
  console.error(error);
  return { success: false, error };
};

// Use the account's existing template metadata; never substitute another
// template, language, namespace or guessed media-parameter name.
export const verifyBookingCreatedTemplate = async () => {
  if (!isConfigured()) return templateConfigurationError("cannot be verified because WATI is not configured.");
  const startedAt = Date.now();
  try {
    for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
      const remaining = WATI_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) return templateConfigurationError("approval lookup timed out; sending skipped.");
      const response = await axios.get(`${API_URL}/${TENANT_ID}/api/v1/getMessageTemplates`, {
        headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: "application/json" },
        params: { pageSize: 100, pageNumber },
        timeout: remaining,
      });
      const data = response.data;
      // The connected account returns result:"success" for this GET API;
      // template-send responses use result:true instead.
      if (!["success", true].includes(data?.result) || !Array.isArray(data?.messageTemplates)) {
        return templateConfigurationError("lookup did not return confirmed template metadata; sending skipped.");
      }
      const template = data.messageTemplates.find(item => item?.elementName === BOOKING_CREATED_TEMPLATE);
      if (template) {
        if (template.status !== "APPROVED") return templateConfigurationError("is not APPROVED; sending skipped.");
        if (!Array.isArray(template.customParams)) return templateConfigurationError("has unverifiable parameter metadata; sending skipped.");
        const content = JSON.stringify({ body: template.body, header: template.header, footer: template.footer, buttons: template.buttons });
        if (template.customParams.length || /\{\{[^}]+\}\}/.test(content)) {
          return templateConfigurationError("requires parameters that the empty booking parameter list does not supply; sending skipped.");
        }
        const header = template.header;
        if (header?.headerParamMapping && Object.keys(header.headerParamMapping).length) {
          return templateConfigurationError("requires mapped header parameters that the booking payload does not supply; sending skipped.");
        }
        const headerType = String(header?.typeString || header?.headerTypeString || "").toLowerCase();
        const hasStaticMedia = [header?.mediaHeaderId, header?.link].some(value => typeof value === "string" && value.trim());
        if (["image", "video", "document"].includes(headerType) && !hasStaticMedia) {
          return templateConfigurationError("has a media header without a configured WATI asset; sending skipped.");
        }
        const channelTimeout = WATI_TIMEOUT_MS - (Date.now() - startedAt);
        if (channelTimeout <= 0) return templateConfigurationError("sender lookup timed out; sending skipped.");
        const channelResponse = await axios.get(`${API_URL}/${TENANT_ID}/api/v2/whatsapp/phoneNumbers`, {
          headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: "application/json" }, timeout: channelTimeout,
        });
        if (!Array.isArray(channelResponse.data)) return templateConfigurationError("sender lookup returned unconfirmed metadata; sending skipped.");
        const contexts = Array.isArray(template.wabaContextIds) ? template.wabaContextIds.map(String) : [];
        const channels = channelResponse.data.filter(channel => {
          if (channel?.enabled !== true) return false;
          const sameWaba = template.wabaId && channel.wabaId && String(channel.wabaId) === String(template.wabaId);
          // The account's default sender has no wabaContextId; its WABA ID
          // still binds it to the approved template without guessing a number.
          if (contexts.length) return channel.wabaContextId ? contexts.includes(String(channel.wabaContextId)) : sameWaba;
          return !template.wabaId || sameWaba;
        });
        const channelNumber = channels.length === 1 ? formatPhone(channels[0].phoneNumber) : "";
        if (!channelNumber) return templateConfigurationError("does not have one unambiguous enabled sender channel; sending skipped.");
        return { success: true, template: {
          name: BOOKING_CREATED_TEMPLATE, status: template.status,
          language: typeof template.language === "string" ? template.language : template.language?.value,
          parameterNames: [], headerType, hasStaticMedia,
        }, channelNumber };
      }
      if (data.messageTemplates.length < 100) break;
    }
    return templateConfigurationError("was not found in the connected account; sending skipped.");
  } catch {
    // Do not log Axios URLs, authorization headers or raw provider responses.
    return templateConfigurationError("approval/parameter lookup failed; sending skipped.");
  }
};

export const sendBookingCreatedMessage = async (mobileNumber) => {
  try {
    if (!isConfigured()) {
      console.warn("WATI is not configured; booking created message not sent.");
      return { success: false, error: "WATI is not configured" };
    }

    const mobile = formatPhone(mobileNumber);
    if (!mobile) return { success: false, error: "Invalid customer mobile number" };

    const verification = await verifyBookingCreatedTemplate();
    if (!verification.success) return verification;

    const payload = {
      template_name: BOOKING_CREATED_TEMPLATE,
      broadcast_name: `booking_created_${Date.now()}`,
      channel_number: verification.channelNumber,
      parameters: [], // Verified against the account; static header stays in WATI.
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
      console.warn("WATI booking confirmation rejected.");
      return { success: false, error: rejection };
    }

    console.log("WATI booking confirmation accepted.");

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    // Provider responses and Axios messages may contain the full recipient URL.
    console.warn("WATI booking confirmation failed.", {
      status: error?.response?.status,
      code: error?.code,
    });

    return {
      success: false,
      error:
        error?.response?.data ||
        error.message,
    };
  }
};
