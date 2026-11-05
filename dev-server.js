// Local test server. Not used on Vercel.
// Usage: DATABASE_URL=postgres://... ANTHROPIC_API_KEY=... node dev-server.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handle } from "./lib/core.js";

const PUB = path.resolve("public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".json": "application/json" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return handle(req, res, url.pathname.slice(5).replace(/[^a-z_]/g, ""));
  let p = path.join(PUB, url.pathname === "/" ? "index.html" : url.pathname);
  if (!p.startsWith(PUB) || !fs.existsSync(p)) p = path.join(PUB, "index.html");
  res.setHeader("content-type", TYPES[path.extname(p)] || "application/octet-stream");
  fs.createReadStream(p).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
