// MCP-Tooldefinitionen für den Remote-MCP-Endpoint (claude.ai Web-Connector).
//
// Gleiche Tools wie der stdio-Server, aber sie rufen die App-Logik IN-PROCESS
// auf (runPipeline / getMockupLists / renderMockup) — keine HTTP-Selbstaufrufe.
//
// Bild-Input: base64, http(s)-URL ODER Google-Drive-Datei-ID (Service-Account,
// read-only). Jeder Input läuft VOR der Pipeline durch prepDesign() (Pflicht-
// Downscale, sonst sprengt ein 100-MB-PNG den RAM).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMockupLists, resolveMockupFile } from "./mockups";
import { renderMockup, renderStaticImage } from "./render";
import { runPipeline } from "./pipeline";
import { driveDownload, driveListImages, driveConfigured } from "./drive";
import { prepDesign } from "./imagePrep";
import type { Orientation } from "../types";

// Bild-Input auflösen -> downscaltes JPEG als Buffer.
async function resolveDesign(input: {
  imageBase64?: string;
  imageUrl?: string;
  driveFileId?: string;
}): Promise<Buffer> {
  let raw: Buffer;
  if (input.driveFileId) {
    if (!driveConfigured()) throw new Error("Google Drive nicht konfiguriert (GOOGLE_SERVICE_ACCOUNT_JSON fehlt)");
    raw = await driveDownload(input.driveFileId);
  } else if (input.imageBase64) {
    const m = /^data:.+?;base64,(.+)$/.exec(input.imageBase64);
    raw = Buffer.from(m ? m[1] : input.imageBase64, "base64");
  } else if (input.imageUrl) {
    const r = await fetch(input.imageUrl);
    if (!r.ok) throw new Error(`Bild-URL ${input.imageUrl} -> ${r.status}`);
    raw = Buffer.from(await r.arrayBuffer());
  } else {
    throw new Error("imageBase64, imageUrl oder driveFileId erforderlich");
  }
  return prepDesign(raw);
}

function batchLimit(): number {
  const v = Number(process.env.MCP_BATCH_LIMIT);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "atelier-faille-upload", version: "1.1.0" });

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
    "list_drive_folder",
    "Listet die Bilddateien in einem Google-Drive-Ordner (id + Name). Für Batch-Uploads: zuerst hier die Anzahl prüfen.",
    {
      driveFolderId: z.string().describe("Google-Drive-Ordner-ID"),
    },
    async ({ driveFolderId }) => {
      if (!driveConfigured()) {
        return { isError: true, content: [{ type: "text", text: "Google Drive nicht konfiguriert (GOOGLE_SERVICE_ACCOUNT_JSON fehlt)" }] };
      }
      const files = await driveListImages(driveFolderId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ count: files.length, files: files.map(f => ({ id: f.id, name: f.name })) }, null, 2),
        }],
      };
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
      driveFileId: z.string().optional().describe("Google-Drive-Datei-ID"),
    },
    async ({ orientation, mockupId, imageBase64, imageUrl, driveFileId }) => {
      const designBuf = await resolveDesign({ imageBase64, imageUrl, driveFileId });
      const resolved = resolveMockupFile(orientation as Orientation, mockupId);
      if (!resolved) {
        return { isError: true, content: [{ type: "text", text: `Mockup ${mockupId} nicht gefunden` }] };
      }
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
    "Lädt EIN Design headless hoch: rendert alle Mockups, legt Printify-Produkte (Leinwand + Gerahmt) an, published zu Shopify und hängt die Mockups an. dryRun=true rendert nur (keine Produkte). ACHTUNG: ohne dryRun werden echte Produkte im Live-Shop erstellt.",
    {
      imageBase64: z.string().optional(),
      imageUrl: z.string().optional(),
      driveFileId: z.string().optional().describe("Google-Drive-Datei-ID"),
      filename: z.string().optional(),
      scope: z.enum(["auto", "vertical", "horizontal", "both"]).optional().describe("welche Mockup-Listen (default auto)"),
      publish: z.boolean().optional().describe("zu Shopify publishen (default true)"),
      dryRun: z.boolean().optional().describe("nur rendern, keine Produkte anlegen (default false)"),
    },
    async ({ imageBase64, imageUrl, driveFileId, filename, scope, publish, dryRun }) => {
      const designBuf = await resolveDesign({ imageBase64, imageUrl, driveFileId });
      const result = await runPipeline({
        imageBase64: designBuf.toString("base64"),
        filename,
        scope,
        publish,
        dryRun,
      });
      const trimmed: Record<string, unknown> = { ...result };
      if (typeof result.sampleMockup === "string") {
        trimmed.sampleMockup = `[${result.sampleMockup.length} bytes dataUrl]`;
      }
      return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
    }
  );

  server.tool(
    "upload_folder",
    "Batch: lädt bis zu `limit` Designs aus einem Google-Drive-Ordner hoch (Reihenfolge nach Dateiname). publish default true = direkt live in Shopify. Verarbeitet sequenziell ab `offset`; bei großen Ordnern mehrfach mit steigendem offset aufrufen (jeder Call bleibt im Server-Timeout). ACHTUNG: erstellt echte Live-Produkte.",
    {
      driveFolderId: z.string().describe("Google-Drive-Ordner-ID"),
      limit: z.number().optional().describe(`max. Designs pro Call (default ${batchLimit()})`),
      offset: z.number().optional().describe("wie viele Designs am Anfang überspringen (default 0)"),
      scope: z.enum(["auto", "vertical", "horizontal", "both"]).optional(),
      publish: z.boolean().optional().describe("zu Shopify publishen (default true)"),
      dryRun: z.boolean().optional().describe("nur rendern, keine Produkte (default false)"),
    },
    async ({ driveFolderId, limit, offset, scope, publish, dryRun }) => {
      if (!driveConfigured()) {
        return { isError: true, content: [{ type: "text", text: "Google Drive nicht konfiguriert (GOOGLE_SERVICE_ACCOUNT_JSON fehlt)" }] };
      }
      const all = await driveListImages(driveFolderId);
      const start = offset && offset > 0 ? offset : 0;
      const lim = limit && limit > 0 ? limit : batchLimit();
      const slice = all.slice(start, start + lim);

      const results: any[] = [];
      for (const f of slice) {
        try {
          const designBuf = await prepDesign(await driveDownload(f.id));
          const r = await runPipeline({
            imageBase64: designBuf.toString("base64"),
            filename: f.name,
            scope,
            publish,
            dryRun,
          });
          results.push({
            file: f.name,
            ok: r.ok,
            title: r.title,
            products: r.products.map(p => ({ type: p.type, shopifyProductId: p.shopifyProductId, error: p.error })),
          });
        } catch (e: any) {
          results.push({ file: f.name, ok: false, error: e?.message || String(e) });
        }
      }

      const processedEnd = start + slice.length;
      const remaining = Math.max(0, all.length - processedEnd);
      const summary = {
        folderTotal: all.length,
        processed: slice.length,
        offset: start,
        succeeded: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        remaining,
        nextOffset: remaining > 0 ? processedEnd : null,
        results,
      };
      return {
        isError: results.length > 0 && results.every(r => !r.ok),
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  return server;
}
