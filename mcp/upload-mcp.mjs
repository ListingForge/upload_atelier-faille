#!/usr/bin/env node
// MCP-Server für das Atelier-Faille-Upload-Programm.
// Erlaubt Claude, Designs headless hochzuladen — ohne die Website zu bedienen.
//
// Spricht die Prod-App über HTTP an (Basic Auth). Konfiguration via Env:
//   UPLOAD_BASE_URL   z.B. https://upload.atelier-faille.de   (Pflicht)
//   UPLOAD_USER       Basic-Auth-User                          (Pflicht)
//   UPLOAD_PASS       Basic-Auth-Passwort                      (Pflicht)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";

const BASE = (process.env.UPLOAD_BASE_URL || "").replace(/\/$/, "");
const USER = process.env.UPLOAD_USER || "";
const PASS = process.env.UPLOAD_PASS || "";

if (!BASE) {
  console.error("UPLOAD_BASE_URL fehlt (z.B. https://upload.atelier-faille.de)");
  process.exit(1);
}

function authHeader() {
  if (USER && PASS) return { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") };
  return {};
}

async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init.headers || {}) },
  });
  return r;
}

// Bild-Input auflösen: base64, dataUrl, lokaler Pfad oder http(s)-URL -> base64.
async function resolveImageBase64({ imageBase64, imagePath, imageUrl }) {
  if (imageBase64) {
    const m = /^data:.+?;base64,(.+)$/.exec(imageBase64);
    return m ? m[1] : imageBase64;
  }
  if (imagePath) return fs.readFileSync(imagePath).toString("base64");
  if (imageUrl) {
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`Bild-URL ${imageUrl} -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  }
  throw new Error("imageBase64, imagePath oder imageUrl erforderlich");
}

const server = new McpServer({ name: "atelier-faille-upload", version: "1.0.0" });

server.tool(
  "list_mockups",
  "Listet die konfigurierten Mockup-Listen (vertikal/horizontal) mit Anzahl und Namen.",
  {},
  async () => {
    const r = await api("/api/mockups");
    if (!r.ok) return { isError: true, content: [{ type: "text", text: `Fehler ${r.status}: ${await r.text()}` }] };
    const lists = await r.json();
    const summary = {
      vertical: { count: lists.vertical?.length || 0, items: (lists.vertical || []).map(i => `${i.kind}:${i.originalName}`) },
      horizontal: { count: lists.horizontal?.length || 0, items: (lists.horizontal || []).map(i => `${i.kind}:${i.originalName}`) },
    };
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  "render_preview",
  "Rendert EIN Mockup mit einem Design (headless, kein Upload) und gibt das Bild zurück. Zum Prüfen der Platzierung vor dem echten Upload.",
  {
    orientation: z.enum(["vertical", "horizontal"]),
    mockupId: z.string().describe("id aus list_mockups"),
    imageBase64: z.string().optional(),
    imagePath: z.string().optional().describe("lokaler Dateipfad zum Design"),
    imageUrl: z.string().optional(),
  },
  async ({ orientation, mockupId, imageBase64, imagePath, imageUrl }) => {
    const b64 = await resolveImageBase64({ imageBase64, imagePath, imageUrl });
    const r = await api("/api/render/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orientation, id: mockupId, imageBase64: b64 }),
    });
    if (!r.ok) return { isError: true, content: [{ type: "text", text: `Render-Fehler ${r.status}: ${await r.text()}` }] };
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      content: [
        { type: "text", text: `Gerendert (${r.headers.get("x-render-dims") || "?"}, ${(buf.length / 1024).toFixed(0)} KB WebP)` },
        { type: "image", data: buf.toString("base64"), mimeType: "image/webp" },
      ],
    };
  }
);

server.tool(
  "upload_design",
  "Lädt ein Design headless hoch: rendert alle Mockups, legt Printify-Produkte (Leinwand + Gerahmt) an, published zu Shopify und hängt die Mockups an. dryRun=true rendert nur (keine Produkte). ACHTUNG: ohne dryRun werden echte Produkte im Live-Shop erstellt.",
  {
    imageBase64: z.string().optional(),
    imagePath: z.string().optional().describe("lokaler Dateipfad zum Design"),
    imageUrl: z.string().optional(),
    filename: z.string().optional(),
    scope: z.enum(["auto", "vertical", "horizontal", "both"]).optional().describe("welche Mockup-Listen (default auto)"),
    publish: z.boolean().optional().describe("zu Shopify publishen (default true)"),
    dryRun: z.boolean().optional().describe("nur rendern, keine Produkte anlegen (default false)"),
  },
  async ({ imageBase64, imagePath, imageUrl, filename, scope, publish, dryRun }) => {
    const b64 = await resolveImageBase64({ imageBase64, imagePath, imageUrl });
    const r = await api("/api/pipeline/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: b64, filename, scope, publish, dryRun }),
    });
    const text = await r.text();
    if (!r.ok) return { isError: true, content: [{ type: "text", text: `Pipeline-Fehler ${r.status}: ${text}` }] };
    // sampleMockup (großer dataUrl) aus der Text-Antwort kürzen.
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (obj?.sampleMockup) obj.sampleMockup = `[${obj.sampleMockup.length} bytes dataUrl]`;
    return { content: [{ type: "text", text: obj ? JSON.stringify(obj, null, 2) : text }] };
  }
);

await server.connect(new StdioServerTransport());
console.error("atelier-faille-upload-mcp läuft (stdio)");
