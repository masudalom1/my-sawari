import ApiError from "./ApiError.js";

const INDIA_OFFSET_MS = 330 * 60 * 1000;

export function currentIndiaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseIndiaDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${name} must be a date in YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ApiError(400, `${name} must be a valid calendar date`);
  }
  return new Date(date.getTime() - INDIA_OFFSET_MS);
}

export function resolveIndiaDateRange(query = {}) {
  if ((query.from === undefined) !== (query.to === undefined)) {
    throw new ApiError(400, "from and to must be provided together");
  }
  const today = currentIndiaDate();
  const from = query.from ?? today;
  const to = query.to ?? from;
  const start = parseIndiaDate(from, "from");
  const end = parseIndiaDate(to, "to");
  if (start > end) {
    throw new ApiError(400, "from must be earlier than or equal to to");
  }
  return {
    from,
    to,
    start,
    endExclusive: new Date(end.getTime() + 24 * 60 * 60 * 1000),
  };
}

export function shiftIndiaDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
