import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { basicAuth } from "./src/server/basicAuth";
import { createShopifyOAuthRouter } from "./src/server/shopifyOAuth";
import { listShopifyShops, getShopifyToken } from "./src/server/tokenStore";
import { createMockupsRouter } from "./src/server/mockups";
import { createPrintifyRouter } from "./src/server/printify";
import { createShopifyRouter } from "./src/server/shopify";
import { createGeminiRouter } from "./src/server/gemini";
import { createRenderRouter } from "./src/server/renderRoutes";
import { createPipelineRouter } from "./src/server/pipeline";
import { createMcpOAuthRouter } from "./src/server/mcpOAuth";
import { createMcpHttpRouter } from "./src/server/mcpHttp";

dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
app.use(express.json({ limit: "1024mb" }));

// Remote-MCP für claude.ai-Web-Connector: eigene OAuth-2.1-Auth (Bearer), daher
// VOR basicAuth gemountet — claude.ai kann kein Basic Auth senden.
app.use("/", createMcpOAuthRouter());
app.use("/mcp", createMcpHttpRouter());

app.use(basicAuth);

const PORT = Number(process.env.PORT) || 3000;

// Shopify OAuth install + callback
app.use("/api/shopify", createShopifyOAuthRouter());

// Status endpoint
app.get("/api/shopify/status", (_req, res) => {
  const shops = listShopifyShops();
  const envShop = process.env.SHOPIFY_STORE;
  const active = envShop ? getShopifyToken(envShop) : undefined;
  res.json({
    connectedShops: shops,
    activeShop: envShop || null,
    hasToken: Boolean(active),
    scopes: active?.scope || null,
  });
});

// Mockup lists (CRUD + file upload + file serving)
app.use("/api/mockups", createMockupsRouter());

// Printify backend (catalog, uploads, products, publish)
app.use("/api/printify", createPrintifyRouter());

// Shopify backend (products list + edit)
app.use("/api/sh", createShopifyRouter());

// Gemini (image → customer-friendly title + description)
app.use("/api/gemini", createGeminiRouter());

// Server-seitiges Mockup-Rendering (Preview, headless)
app.use("/api/render", createRenderRouter());

// Headless Upload-Pipeline (Design → Mockups → Printify → Shopify)
app.use("/api/pipeline", createPipelineRouter());

// Vite & App Entrypoint
const startServer = async () => {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();
