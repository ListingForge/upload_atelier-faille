// Headless Upload-Pipeline: der komplette runAll-Ablauf server-seitig, damit
// Claude/ein Skript ein Design ohne Browser hochladen kann.
//
// Rendert Mockups direkt (src/server/render.ts) und ruft für Printify/Shopify/
// Gemini die App-eigenen HTTP-Endpoints per localhost-Self-Call auf — keine
// Duplizierung der bestehenden, getesteten Logik.

import express, { type Router } from "express";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderMockup, renderStaticImage } from "./render";
import { resolveMockupFile, getMockupLists } from "./mockups";

type Orientation = "vertical" | "horizontal";
type Scope = "auto" | "vertical" | "horizontal" | "both";

const PORT = Number(process.env.PORT) || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

function authHeader(): Record<string, string> {
  const u = process.env.BASIC_AUTH_USER, p = process.env.BASIC_AUTH_PASS;
  if (u && p) return { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
  return {};
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init.headers || {}) },
  });
}

function decodeBase64(input: string): Buffer {
  const m = /^data:.+?;base64,(.+)$/.exec(input);
  return Buffer.from(m ? m[1] : input, "base64");
}

// Design auf maxEdge verkleinern, als JPEG kodieren (für Gemini / Printify-Master).
async function scaleToJpeg(buf: Buffer, maxEdge: number, quality = 90): Promise<Buffer> {
  const img = await loadImage(buf);
  const long = Math.max(img.width, img.height);
  const scale = long > maxEdge ? maxEdge / long : 1;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = createCanvas(w, h);
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toBuffer("image/jpeg", quality);
}

export interface PipelineInput {
  imageBase64: string;
  filename?: string;
  title?: string;      // gesetzt = überschreibt Gemini, Gemini-Call entfällt
  scope?: Scope;
  publish?: boolean;   // default true — bei false nur Printify-Produkt anlegen, nicht published
  dryRun?: boolean;    // nur rendern + Gemini, keine Printify/Shopify-Writes
}

export interface PipelineProduct {
  type: "stretched" | "framed";
  printifyId?: string;
  shopifyProductId?: string;
  mockupsAttached?: number;
  error?: string;
}

export interface PipelineResult {
  ok: boolean;
  orientation: Orientation;
  title: string;
  mockupsRendered: number;
  dryRun: boolean;
  sampleMockup?: string;      // dataUrl des ersten Mockups (nur dryRun)
  products: PipelineProduct[];
  log: string[];
}

function listsForScope(scope: Scope, designOrientation: Orientation): Orientation[] {
  if (scope === "both") return ["vertical", "horizontal"];
  if (scope === "vertical" || scope === "horizontal") return [scope];
  return [designOrientation]; // auto
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const log: string[] = [];
  const push = (m: string) => { log.push(m); };
  const scope: Scope = input.scope || "auto";
  const publish = input.publish !== false;
  const dryRun = !!input.dryRun;

  const designBuf = decodeBase64(input.imageBase64);
  const filename = input.filename || `design-${Date.now()}.jpg`;

  // 1) Orientation
  const dim = await loadImage(designBuf);
  const orientation: Orientation = dim.width >= dim.height ? "horizontal" : "vertical";
  push(`Orientation: ${orientation} (${dim.width}x${dim.height})`);

  // 2) Titel: gesetzter title überschreibt Gemini (deterministisch, kein API-Call)
  let title = filename.replace(/\.[^.]+$/, "");
  let description = `<p>${title}</p>`;
  let seoTitle = "", seoDescription = "";
  const manualTitle = input.title?.trim();
  if (manualTitle) {
    title = manualTitle;
    description = `<p>${title}</p>`;
    push(`Titel gesetzt: „${title}" (Gemini übersprungen)`);
  } else {
    try {
      const gjpg = await scaleToJpeg(designBuf, 1600);
      const gr = await api("/api/gemini/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: gjpg.toString("base64"), mimeType: "image/jpeg" }),
      });
      if (gr.ok) {
        const g: any = await gr.json();
        if (g.title) { title = g.title; description = `<p>${g.description || g.title}</p>`; }
        seoTitle = g.seoTitle || ""; seoDescription = g.seoDescription || "";
        push(`Gemini-Titel: „${title}"`);
      } else {
        push(`Gemini fehlgeschlagen: ${await gr.text()}`);
      }
    } catch (e: any) {
      push(`Gemini-Fehler: ${e.message}`);
    }
  }

  // 3) Mockups rendern (direkt, kein Browser)
  const lists = getMockupLists();
  const targetOrientations = listsForScope(scope, orientation);
  const out: { dataUrl: string; filename: string }[] = [];
  for (const ori of targetOrientations) {
    for (const item of lists[ori]) {
      try {
        const resolved = resolveMockupFile(ori, item.id);
        if (!resolved) { push(`Mockup ${item.originalName} nicht auffindbar`); continue; }
        const r = resolved.kind === "psd"
          ? await renderMockup(resolved.path, designBuf)
          : await renderStaticImage(resolved.path);
        out.push({
          dataUrl: `data:${r.mime};base64,${r.buffer.toString("base64")}`,
          filename: `${title}-${out.length + 1}.webp`,
        });
      } catch (e: any) {
        push(`Render ${item.originalName} fehlgeschlagen: ${e.message}`);
      }
    }
  }
  push(`${out.length} Mockups gerendert`);

  if (dryRun) {
    return {
      ok: true, orientation, title, mockupsRendered: out.length, dryRun: true,
      sampleMockup: out[0]?.dataUrl, products: [], log,
    };
  }

  // 4) Master-Bild zu Printify (max 9000 px)
  const master = await scaleToJpeg(designBuf, 9000, 92);
  const upR = await api("/api/printify/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: filename, contents: master.toString("base64") }),
  });
  if (!upR.ok) throw new Error(`Printify upload: ${await upR.text()}`);
  const printifyImageId: string = (await upR.json()).id;
  push(`Printify image_id ${printifyImageId}`);

  // 5) stretched + framed
  const runVariant = async (type: "stretched" | "framed"): Promise<PipelineProduct> => {
    const suffix = type === "stretched" ? "Leinwand" : "Gerahmt";
    try {
      const prR = await api("/api/printify/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${title} — ${suffix}`, description,
          tags: ["canvas", type, orientation], type, orientation, printifyImageId,
        }),
      });
      if (!prR.ok) throw new Error(`Printify create: ${await prR.text()}`);
      const printifyId: string = (await prR.json()).id;
      push(`${type}: Printify-Produkt ${printifyId} erstellt`);

      if (!publish) return { type, printifyId, mockupsAttached: 0 };

      const pubR = await api(`/api/printify/products/${printifyId}/publish`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!pubR.ok) throw new Error(`Printify publish: ${await pubR.text()}`);
      push(`${type}: an Shopify gepublisht`);

      // Poll bis Produkt in Shopify auftaucht
      const shopifyTitle = `${title} — ${suffix}`;
      let shopifyProductId: string | null = null;
      const pollStart = Date.now();
      const pollMax = 10 * 60 * 1000;
      while (Date.now() - pollStart < pollMax) {
        const [pfRes, shRes] = await Promise.all([
          api(`/api/printify/products/${encodeURIComponent(printifyId)}/shopify-id`).catch(() => null),
          api(`/api/sh/find-product?${new URLSearchParams({ title: shopifyTitle, vendor: "Printify" })}`).catch(() => null),
        ]);
        if (pfRes?.status === 200) {
          const j: any = await pfRes.json();
          if (j?.shopifyProductId) { shopifyProductId = j.shopifyProductId; break; }
        }
        if (shRes?.ok) {
          const j: any = await shRes.json();
          if (j?.shopifyProductId) { shopifyProductId = j.shopifyProductId; break; }
        }
        if (shRes && shRes.status >= 500) throw new Error(`Shopify-Suche-Fehler ${shRes.status}`);
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!shopifyProductId) throw new Error("Produkt nach 10 min nicht in Shopify gefunden");
      push(`${type}: in Shopify gefunden (${shopifyProductId})`);

      // Mockups anhängen
      const batchR = await api(`/api/sh/products/${encodeURIComponent(shopifyProductId)}/images/batch`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: out.map(m => ({ dataUrl: m.dataUrl, filename: m.filename })) }),
      });
      if (!batchR.ok) throw new Error(`Shopify-Batch: ${await batchR.text()}`);
      const attached = (await batchR.json())?.count ?? out.length;
      push(`${type}: ${attached}/${out.length} Mockups angehängt`);

      // cm-Relabel (best effort)
      try {
        await api(`/api/sh/products/${encodeURIComponent(shopifyProductId)}/relabel-sizes-cm`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
      } catch { /* ignore */ }

      // SEO (best effort)
      try {
        const st = `${(seoTitle || title).trim()} – ${suffix}`.slice(0, 65);
        const sd = (seoDescription?.trim() ||
          `${title} Premium-Canvas, kuratierte Wandkunst — versandkostenfrei aus Deutschland (DE·AT·CH).`).slice(0, 160);
        await api(`/api/sh/products/${encodeURIComponent(shopifyProductId)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seo: { title: st, description: sd } }),
        });
      } catch { /* ignore */ }

      return { type, printifyId, shopifyProductId, mockupsAttached: attached };
    } catch (e: any) {
      push(`${type}: FEHLER ${e.message}`);
      return { type, error: e.message };
    }
  };

  const products = await Promise.all([runVariant("stretched"), runVariant("framed")]);
  const ok = products.some(p => !p.error);
  return { ok, orientation, title, mockupsRendered: out.length, dryRun: false, products, log };
}

export function createPipelineRouter(): Router {
  const router = express.Router();

  // POST /api/pipeline/upload
  // Body: { imageBase64|imageDataUrl, filename?, title?, scope?, publish?, dryRun? }
  router.post("/upload", async (req, res) => {
    try {
      const body = req.body || {};
      const imageBase64 = body.imageDataUrl || body.imageBase64;
      if (!imageBase64) return res.status(400).json({ error: "imageBase64 oder imageDataUrl erforderlich" });
      const result = await runPipeline({
        imageBase64: String(imageBase64),
        filename: body.filename,
        title: body.title,
        scope: body.scope,
        publish: body.publish,
        dryRun: body.dryRun,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Pipeline fehlgeschlagen" });
    }
  });

  return router;
}
