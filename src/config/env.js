// Startup check for environment variables. Only names are ever printed, never values.

const REQUIRED = ["MONGO_URI", "JWT_ACCESS_SECRET"];

// Features that degrade (uploads / WhatsApp fail) but should not stop the API.
const OPTIONAL_GROUPS = {
  Cloudinary: ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
  WATI: ["WATI_API_URL", "WATI_TENANT_ID", "WATI_API_TOKEN"],
};

const isMissing = (name) => !String(process.env[name] ?? "").trim();

export const validateEnv = () => {
  const missing = REQUIRED.filter(isMissing);

  if (missing.length) {
    console.error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Set them in .env (see .env.example) or in the hosting dashboard.",
    );
    process.exit(1);
  }

  for (const [feature, names] of Object.entries(OPTIONAL_GROUPS)) {
    const absent = names.filter(isMissing);
    if (absent.length) {
      console.warn(`${feature} is not fully configured (missing: ${absent.join(", ")}).`);
    }
  }
};
