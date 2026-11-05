

import { handle } from "../core.js";
export const config = { maxDuration: 60 };
export default function handler(req, res) {
  return handle(req, res, String(req.query?.route || "").replace(/[^a-z_]/g, ""));
}
