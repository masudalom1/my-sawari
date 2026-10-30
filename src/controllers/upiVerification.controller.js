import { readUpiView, verifyUpi } from "../services/upiVerification.service.js";

export const getUpiVerification = async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); return res.json(await readUpiView(req.user, req.query)); }
  catch (error) { next(error); }
};
export const verifyUpiPayment = async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); return res.json(await verifyUpi(req.user, req.params.id, req.body)); }
  catch (error) { next(error); }
};
