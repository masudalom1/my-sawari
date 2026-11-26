import { createRequire } from "module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { Resvg } = require("@resvg/resvg-js");
const QRCode = require("qrcode/lib/core/qrcode");

// Keep libvips memory tight on small container instances
sharp.cache({ memory: 24, files: 0, items: 10 });

const FONT_FILES = [
  require.resolve("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf"),
  require.resolve("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
  require.resolve("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
];

const MAX_CACHE_ITEMS = 8;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const templateBufferCache = new Map();
let cachedBytesTotal = 0;

function getCachedTemplateBuffer(url) {
  if (!templateBufferCache.has(url)) return null;
  const buf = templateBufferCache.get(url);
  templateBufferCache.delete(url);
  templateBufferCache.set(url, buf);
  return buf;
}

function setCachedTemplateBuffer(url, buf) {
  if (!Buffer.isBuffer(buf) || buf.length > 10 * 1024 * 1024) return;
  if (templateBufferCache.has(url)) {
    cachedBytesTotal -= templateBufferCache.get(url).length;
    templateBufferCache.delete(url);
  }
  while (
    templateBufferCache.size >= MAX_CACHE_ITEMS ||
    cachedBytesTotal + buf.length > MAX_CACHE_BYTES
  ) {
    const oldestKey = templateBufferCache.keys().next().value;
    if (!oldestKey) break;
    cachedBytesTotal -= templateBufferCache.get(oldestKey).length;
    templateBufferCache.delete(oldestKey);
  }
  templateBufferCache.set(url, buf);
  cachedBytesTotal += buf.length;
}

async function fetchTemplateBuffer(url) {
  const cached = getCachedTemplateBuffer(url);
  if (cached) return cached;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error("Invalid template image URL"), { statusCode: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw Object.assign(new Error("Unsupported template URL protocol"), { statusCode: 400 });
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Failed to fetch template image (${res.status})`),
      { statusCode: 502 }
    );
  }
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > 15 * 1024 * 1024) {
    throw Object.assign(new Error("Template image exceeds maximum render size"), {
      statusCode: 400,
    });
  }
  setCachedTemplateBuffer(url, buf);
  return buf;
}

export const getQrTargetUrl = (token) => {
  const base = (
    process.env.QR_BASE_URL ||
    process.env.NEXT_PUBLIC_QR_BASE_URL ||
    "https://app.mysawari.in/r"
  )
    .trim()
    .replace(/\/+$/, "");
  return `${base}/${String(token || "").trim().toUpperCase()}`;
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const escapeXml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const isLightHex = (hex) => {
  const clean = String(hex || "").replace("#", "");
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.78;
};

function buildQrPathD(modules, offsetX, offsetY, qrSize) {
  const count = modules.size;
  const cell = qrSize / count;
  const parts = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (modules.get(r, c)) {
        const x = (offsetX + c * cell).toFixed(2);
        const y = (offsetY + r * cell).toFixed(2);
        const s = (cell + 0.05).toFixed(2);
        parts.push(`M${x},${y}h${s}v${s}h-${s}z`);
      }
    }
  }
  return parts.join("");
}

function renderSvgWithFonts(svgString) {
  const resvg = new Resvg(svgString, {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: true,
      defaultFontFamily: "Inter",
    },
    fitTo: { mode: "original" },
  });
  return Buffer.from(resvg.render().asPng());
}

export function computeQrBoxLayout({ width, height, template, hasBusinessName }) {
  const W = Math.max(200, Math.round(Number(width) || 1080));
  const H = Math.max(200, Math.round(Number(height) || 1080));
  const minDim = Math.min(W, H);

  const sizePct = clamp(Number(template?.qrSizePct ?? 44), 18, 82);
  const centerXPct = clamp(Number(template?.qrCenterXPct ?? 50), 15, 85);
  const centerYPct = clamp(Number(template?.qrCenterYPct ?? 50), 15, 85);

  const showQuietZone = template?.showQuietZone !== false;
  const showCodeText = template?.showCodeText !== false;
  const showBusinessName = Boolean(template?.showBusinessName !== false && hasBusinessName);

  const qrSize = Math.max(80, Math.round(minDim * (sizePct / 100)));
  const outerPad = showQuietZone
    ? Math.max(12, Math.round(qrSize * 0.09))
    : Math.max(8, Math.round(qrSize * 0.06));
  const topFontSize = Math.max(13, Math.round(qrSize * 0.088));
  const botFontSize = Math.max(15, Math.round(qrSize * 0.11));
  const topGap = showBusinessName ? Math.round(topFontSize * 1.8) : 0;
  const botGap = showCodeText ? Math.round(botFontSize * 1.75) : 0;

  const boxW = qrSize + outerPad * 2;
  const boxH = qrSize + outerPad * 2 + topGap + botGap;
  const cx = Math.round(W * (centerXPct / 100));
  const cy = Math.round(H * (centerYPct / 100));
  const boxLeft = clamp(Math.round(cx - boxW / 2), 0, Math.max(0, W - boxW));
  const boxTop = clamp(Math.round(cy - boxH / 2), 0, Math.max(0, H - boxH));

  return {
    W,
    H,
    qrSize,
    outerPad,
    topFontSize,
    botFontSize,
    topGap,
    botGap,
    boxW,
    boxH,
    boxLeft,
    boxTop,
    showQuietZone,
    showCodeText,
    showBusinessName,
  };
}

function truncateText(text, maxChars = 24) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(4, maxChars - 1)).trimEnd()}…`;
}

export function buildClassicQrSvg({ token, businessName }) {
  const cleanCode = String(token || "").trim().toUpperCase();
  const cleanName = String(businessName || "").trim();
  const W = 720;
  const H = cleanName ? 980 : 912;
  const qrSize = 560;
  const qrX = (W - qrSize) / 2;
  const qrY = cleanName ? 228 : 172;
  const targetUrl = getQrTargetUrl(cleanCode);
  const qrData = QRCode.create(targetUrl, { errorCorrectionLevel: "M" });
  const qrPath = buildQrPathD(qrData.modules, qrX, qrY, qrSize);
  const spacedCode = cleanCode.split("").join(" ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="0" y="0" width="${W}" height="${H}" rx="36" fill="#FFFFFF"/>
    <rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="34" fill="none" stroke="#E2E8F0" stroke-width="4"/>
    <text x="${W / 2}" y="84" text-anchor="middle" font-family="Inter" font-weight="700" font-size="40" fill="#0F172A">MySawari</text>
    <text x="${W / 2}" y="126" text-anchor="middle" font-family="Inter" font-weight="500" font-size="22" fill="#64748B">Car Rental · Scan to book your ride</text>
    ${
      cleanName
        ? `<rect x="110" y="152" width="500" height="48" rx="24" fill="#ECFDF5"/>
           <text x="${W / 2}" y="184" text-anchor="middle" font-family="Inter" font-weight="600" font-size="23" fill="#047857">${escapeXml(truncateText(cleanName, 30))}</text>`
        : ""
    }
    <path d="${qrPath}" fill="#0F172A"/>
    <text x="${W / 2}" y="${qrY + qrSize + 88}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="42" letter-spacing="4" fill="#0F172A">${escapeXml(spacedCode)}</text>
  </svg>`;
}

export function buildTemplateOverlaySvg({ token, businessName, template, width, height }) {
  const cleanCode = String(token || "").trim().toUpperCase();
  const cleanName = String(businessName || "").trim();
  const layout = computeQrBoxLayout({
    width,
    height,
    template,
    hasBusinessName: Boolean(cleanName),
  });

  const targetUrl = getQrTargetUrl(cleanCode);
  const qrData = QRCode.create(targetUrl, { errorCorrectionLevel: "M" });

  const qrX = layout.outerPad;
  const qrY = layout.outerPad + layout.topGap;
  const qrPath = buildQrPathD(qrData.modules, qrX, qrY, layout.qrSize);

  const rawTextColor = /^#[0-9A-Fa-f]{6}$/.test(template?.textColor || "")
    ? template.textColor
    : "#0F172A";
  const textColor =
    layout.showQuietZone && isLightHex(rawTextColor) ? "#0F172A" : rawTextColor;

  const radius = Math.round(layout.outerPad * 1.15);
  const qrBackingPad = Math.max(6, Math.round(layout.qrSize * 0.05));
  const spacedCode = cleanCode.split("").join(" ");

  const cardBg = layout.showQuietZone
    ? `<rect x="1" y="1" width="${layout.boxW - 2}" height="${layout.boxH - 2}" rx="${radius}" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="2"/>`
    : `<rect x="${qrX - qrBackingPad}" y="${qrY - qrBackingPad}" width="${layout.qrSize + qrBackingPad * 2}" height="${layout.qrSize + qrBackingPad * 2}" rx="${Math.round(qrBackingPad * 1.4)}" fill="#FFFFFF"/>`;

  const topText = layout.showBusinessName
    ? `<text x="${layout.boxW / 2}" y="${layout.outerPad + Math.round(layout.topFontSize * 1.05)}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${layout.topFontSize}" fill="${textColor}">${escapeXml(truncateText(cleanName, 22))}</text>`
    : "";

  const botText = layout.showCodeText
    ? `<text x="${layout.boxW / 2}" y="${qrY + layout.qrSize + Math.round(layout.botGap * 0.78)}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${layout.botFontSize}" fill="${textColor}">${escapeXml(spacedCode)}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.boxW}" height="${layout.boxH}" viewBox="0 0 ${layout.boxW} ${layout.boxH}">
    ${cardBg}
    ${topText}
    <path d="${qrPath}" fill="#0F172A"/>
    ${botText}
  </svg>`;

  return { svg, layout };
}

export async function renderQrCardPng({ token, businessName, template, templateBuffer }) {
  if (!template || (!template.imageUrl && !templateBuffer)) {
    const svg = buildClassicQrSvg({ token, businessName });
    return renderSvgWithFonts(svg);
  }

  const rawTemplateBuf = Buffer.isBuffer(templateBuffer)
    ? templateBuffer
    : await fetchTemplateBuffer(template.imageUrl);
  const oriented = sharp(rawTemplateBuf).rotate();
  const meta = await oriented.metadata();

  const W = clamp(Math.round(Number(template.width || meta.width || 1080)), 200, 2400);
  const H = clamp(Math.round(Number(template.height || meta.height || 1080)), 200, 2400);

  const { svg, layout } = buildTemplateOverlaySvg({
    token,
    businessName,
    template,
    width: W,
    height: H,
  });

  const overlayPng = renderSvgWithFonts(svg);

  return oriented
    .resize(W, H, { fit: "fill" })
    .composite([
      {
        input: overlayPng,
        left: layout.boxLeft,
        top: layout.boxTop,
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
