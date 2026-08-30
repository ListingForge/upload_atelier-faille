// MCP-Tooldefinitionen für den Remote-MCP-Endpoint (claude.ai Web-Connector).
//
// Gleiche drei Tools wie der stdio-Server (mcp/upload-mcp.mjs), aber sie rufen
// die App-Logik IN-PROCESS auf (runPipeline / getMockupLists / renderMockup) —
// keine HTTP-Selbstaufrufe, kein Basic Auth zwischen MCP und App nötig.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMockupLists, resolveMockupFile } from "./mockups";
import { renderMockup, renderStaticImage } from "./render";
import { runPipeline } from "./pipeline";
import type { Orientation } from "../types";

// Bild-Input auflösen: base64/dataUrl oder http(s)-URL -> nackter base64-String.
async function resolveImageBase64(input: {
  imageBase64?: string;
  imageUrl?: string;
}): Promise<string> {
  if (input.imageBase64) {
    const m = /^data:.+?;base64,(.+)$/.exec(input.imageBase64);
    return m ? m[1] : input.imageBase64;
  }
  if (input.imageUrl) {
    const r = await fetch(input.imageUrl);
    if (!r.ok) throw new Error(`Bild-URL ${input.imageUrl} -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  }
  throw new Error("imageBase64 oder imageUrl erforderlich");
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "atelier-faille-upload", version: "1.0.0" });

  server.tool(
    "list_mockups",
    "Listet die konfigurierten Mockup-Listen (vertikal/horizontal) mit Anzahl und Namen.",
    {},
    async () => {
      const lists = getMockupLists();
      const summary = {
        vertical: {
          count: lists.vertical.length,
          items: lists.vertical.map(i => `${i.id} ${i.kind}:${i.originalName}`),
        },
        horizontal: {
          count: lists.horizontal.length,
          items: lists.horizontal.map(i => `${i.id} ${i.kind}:${i.originalName}`),
        },
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
      imageUrl: z.string().optional(),
    },
    async ({ orientation, mockupId, imageBase64, imageUrl }) => {
      const b64 = await resolveImageBase64({ imageBase64, imageUrl });
      const resolved = resolveMockupFile(orientation as Orientation, mockupId);
      if (!resolved) {
        return { isError: true, content: [{ type: "text", text: `Mockup ${mockupId} nicht gefunden` }] };
      }
      const designBuf = Buffer.from(b64, "base64");
      const result = resolved.kind === "psd"
        ? await renderMockup(resolved.path, designBuf)
        : await renderStaticImage(resolved.path);
      return {
        content: [
          {
            type: "text",
            text: `Gerendert (${result.width}x${result.height}, ${(result.buffer.length / 1024).toFixed(0)} KB ${result.mime})`,
          },
          { type: "image", data: result.buffer.toString("base64"), mimeType: result.mime },
        ],
      };
    }
  );

  server.tool(
    "upload_design",
    "Lädt ein Design headless hoch: rendert alle Mockups, legt Printify-Produkte (Leinwand + Gerahmt) an, published zu Shopify und hängt die Mockups an. dryRun=true rendert nur (keine Produkte). ACHTUNG: ohne dryRun werden echte Produkte im Live-Shop erstellt.",
    {
      imageBase64: z.string().optional(),
      imageUrl: z.string().optional(),
      filename: z.string().optional(),
      scope: z.enum(["auto", "vertical", "horizontal", "both"]).optional().describe("welche Mockup-Listen (default auto)"),
      publish: z.boolean().optional().describe("zu Shopify publishen (default true)"),
      dryRun: z.boolean().optional().describe("nur rendern, keine Produkte anlegen (default false)"),
    },
    async ({ imageBase64, imageUrl, filename, scope, publish, dryRun }) => {
      const b64 = await resolveImageBase64({ imageBase64, imageUrl });
      const result = await runPipeline({ imageBase64: b64, filename, scope, publish, dryRun });
      // sampleMockup (großer dataUrl) für die Textantwort kürzen.
      const trimmed: Record<string, unknown> = { ...result };
      if (typeof result.sampleMockup === "string") {
        trimmed.sampleMockup = `[${result.sampleMockup.length} bytes dataUrl]`;
      }
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }],
      };
    }
  );

  return server;
}
