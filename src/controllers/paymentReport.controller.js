import { once } from "node:events";
import ApiError from "../utils/ApiError.js";
import { paymentExportFilename } from "../../../shared/paymentReporting.mjs";
import { exportPaymentReport, loadPaymentDetail, loadPaymentReport, parsePaymentReport } from "../services/paymentReport.service.js";

function requestSignal(res) {
  const controller = new AbortController();
  const close = () => controller.abort();
  res.on("close", close);
  return { signal: controller.signal, cleanup: () => res.off("close", close) };
}

function reportParams(req) {
  // HPP may normalize duplicate values before the controller sees req.query.
  // Reject duplicates from the original URL rather than silently choosing one.
  const seen = new Set();
  for (const key of new URL(req.originalUrl, "http://internal").searchParams.keys()) {
    if (seen.has(key)) throw new ApiError(400, `Repeated report parameter: ${key}`);
    seen.add(key);
  }
  return parsePaymentReport(req.query, req.user);
}

export async function getPaymentReport(req, res, next) {
  const { signal, cleanup } = requestSignal(res);
  try {
    const params = reportParams(req);
    const report = await loadPaymentReport(params, signal);
    if (!signal.aborted) res.set("Cache-Control", "private, no-store").json({ success: true, ...report });
  } catch (error) { if (!signal.aborted) next(error); }
  finally { cleanup(); }
}

export async function getPaymentReportExport(req, res, next) {
  const { signal, cleanup } = requestSignal(res);
  try {
    const params = reportParams(req);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${paymentExportFilename()}"`, "Cache-Control": "private, no-store" });
    for await (const chunk of exportPaymentReport(params, signal)) if (!res.write(chunk)) await once(res, "drain", { signal });
    res.end();
  } catch (error) {
    if (!signal.aborted) { if (res.headersSent) res.destroy(error); else next(error); }
  } finally { cleanup(); }
}

export async function getPaymentReportDetail(req, res, next) {
  try {
    const params = reportParams(req);
    const data = await loadPaymentDetail(req.params.id, params.match.company);
    res.set("Cache-Control", "private, no-store").json({ success: true, data });
  } catch (error) { next(error); }
}

export async function getPaymentReportSummary(req, res, next) {
  const { signal, cleanup } = requestSignal(res);
  try {
    const params = reportParams(req);
    const summary = await loadPaymentReport(params, signal, { summaryOnly: true });
    if (!signal.aborted) res.set("Cache-Control", "private, no-store").json({ success: true, ...summary });
  } catch (error) { if (!signal.aborted) next(error); }
  finally { cleanup(); }
}
