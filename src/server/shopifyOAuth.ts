import type { Request, Response, Router } from "express";
import express from "express";
import crypto from "crypto";
import { setShopifyToken } from "./tokenStore";

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

function appUrl(): string {
  const u = process.env.APP_URL;
  if (!u) throw new Error("APP_URL is not set");
  return u.replace(/\/+$/, "");
}

function verifyHmac(query: Record<string, string | undefined>, secret: string): boolean {
  const { hmac, signature: _sig, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k] ?? ""}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(hmac, "hex"));
  } catch {
    return false;
  }
}

export function createShopifyOAuthRouter(): Router {
  const router = express.Router();

  // Step 1: GET /api/shopify/install?shop=xxxxx.myshopify.com
  // Either visited manually or as Shopify's first hit on App-URL during install.
  router.get("/install", (req: Request, res: Response) => {
    const shop = String(req.query.shop || process.env.SHOPIFY_STORE || "");
    if (!SHOP_DOMAIN_RE.test(shop)) {
      return res.status(400).send("Missing or invalid ?shop=xxx.myshopify.com");
    }

    const apiKey = process.env.SHOPIFY_API_KEY;
    const scopes = process.env.SHOPIFY_SCOPES;
    if (!apiKey || !scopes) {
      return res.status(500).send("SHOPIFY_API_KEY / SHOPIFY_SCOPES missing in env.");
    }

    const state = crypto.randomBytes(16).toString("hex");
    res.cookie("shopify_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: appUrl().startsWith("https://"),
      maxAge: 10 * 60 * 1000,
    });

    const redirectUri = `${appUrl()}/api/shopify/callback`;
    const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
    authorize.searchParams.set("client_id", apiKey);
    authorize.searchParams.set("scope", scopes);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);

    res.redirect(authorize.toString());
  });

  // Step 2: GET /api/shopify/callback?code=...&shop=...&hmac=...&state=...
  router.get("/callback", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const { shop, code, state } = q;

    if (!shop || !SHOP_DOMAIN_RE.test(shop)) return res.status(400).send("Bad shop param");
    if (!code) return res.status(400).send("Missing code");

    const cookieHeader = req.headers.cookie || "";
    const expectedState = cookieHeader
      .split(";")
      .map(c => c.trim())
      .find(c => c.startsWith("shopify_oauth_state="))
      ?.slice("shopify_oauth_state=".length);
    if (!expectedState || expectedState !== state) {
      return res.status(403).send("OAuth state mismatch — please retry install.");
    }

    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) return res.status(500).send("SHOPIFY_API_SECRET missing");
    if (!verifyHmac(q, secret)) return res.status(403).send("HMAC validation failed");

    try {
      const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: secret,
          code,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error("Shopify token exchange failed:", tokenRes.status, body);
        return res.status(502).send(`Token exchange failed: ${tokenRes.status}`);
      }

      const data = (await tokenRes.json()) as { access_token: string; scope: string };
      setShopifyToken({
        shop,
        accessToken: data.access_token,
        scope: data.scope,
        installedAt: new Date().toISOString(),
      });
      console.log(`Shopify install complete for ${shop}, scopes: ${data.scope}`);

      res.clearCookie("shopify_oauth_state");
      res.send(`<!doctype html>
<meta charset="utf-8">
<title>Installation erfolgreich</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}div{max-width:480px;padding:32px;background:#1e293b;border-radius:12px;border:1px solid #334155}a{color:#818cf8}</style>
<div>
  <h1>Installation erfolgreich</h1>
  <p>Shopify Store <code>${shop}</code> ist verbunden. Access Token wurde gespeichert.</p>
  <p><a href="/">Zur App</a></p>
</div>`);
    } catch (err: any) {
      console.error("OAuth callback error:", err);
      res.status(500).send("OAuth callback error: " + (err?.message || "unknown"));
    }
  });

  return router;
}
