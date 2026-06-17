import type { Request, Response, NextFunction } from "express";

// Paths that bypass Basic Auth so Shopify (and the user's browser following the
// OAuth redirect from Shopify) can hit them without credentials.
const PUBLIC_PATHS = [
  "/api/shopify/install",
  "/api/shopify/callback",
];

function isPublic(req: Request): boolean {
  return PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + "/"));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function basicAuth(req: Request, res: Response, next: NextFunction) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();
  if (isPublic(req)) return next();

  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      if (timingSafeEqual(u, user) && timingSafeEqual(p, pass)) return next();
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Atelier Faille Upload", charset="UTF-8"');
  res.status(401).send("Authentication required.");
}
