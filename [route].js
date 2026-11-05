import { handle } from "../lib/core.js";

export const config = { maxDuration: 60 };

export default function handler(req, res) {
  const route = String(req.query?.route || "").replace(/[^a-z_]/g, "");
  return handle(req, res, route);
}
