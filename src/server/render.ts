// Server-seitiges Mockup-Rendering ohne Browser/Photopea.
//
// Ersetzt den Smart-Object-Inhalt eines Mockup-PSDs durch ein Design und
// flattened das Ergebnis per @napi-rs/canvas. Deckt die aktuellen Atelier-
// Faille-Mockups ab: flache (achsenparallele) Smart-Objects mit multiply-Blend
// über einem Hintergrund, plus Lighting-Overlays.
//
// Für PSDs mit echtem Perspektiv-Warp (nonAffine mit gebogenen Kanten) ist der
// Canvas-Weg nicht pixelgenau — solche Mockups können später auf den Photopea-
// Fallback (renderMockupPhotopea) geroutet werden. Aktueller Bestand ist flach.

import fs from "fs";
import { readPsd, initializeCanvas, type Layer } from "ag-psd";
import { createCanvas, type Canvas } from "@napi-rs/canvas";

// ag-psd braucht eine Canvas-Factory zum Dekodieren der Layer-Bitmaps.
// Idempotent — mockups.ts ruft das ebenfalls auf.
initializeCanvas(createCanvas as any);

export interface RenderResult {
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
}

// PSD-Blend-Namen (ag-psd) -> Canvas globalCompositeOperation.
const BLEND_MAP: Record<string, string> = {
  "normal": "source-over",
  "pass through": "source-over",
  "dissolve": "source-over",
  "darken": "darken",
  "multiply": "multiply",
  "color burn": "color-burn",
  "linear burn": "multiply",
  "lighten": "lighten",
  "screen": "screen",
  "color dodge": "color-dodge",
  "linear dodge": "lighter",
  "overlay": "overlay",
  "soft light": "soft-light",
  "hard light": "hard-light",
  "difference": "difference",
  "exclusion": "exclusion",
  "hue": "hue",
  "saturation": "saturation",
  "color": "color",
  "luminosity": "luminosity",
};

function blendOp(mode?: string): string {
  return BLEND_MAP[(mode || "normal").toLowerCase()] || "source-over";
}

// Achsenparalleles Rechteck aus dem Smart-Object-Transform (8 Werte, 4 Ecken).
function transformRect(t: number[]): { x: number; y: number; w: number; h: number } {
  const xs = [t[0], t[2], t[4], t[6]];
  const ys = [t[1], t[3], t[5], t[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function findSmartObject(layers: Layer[] | undefined): Layer | null {
  for (const l of layers || []) {
    if ((l as any).placedLayer) return l;
    if (l.children) {
      const f = findSmartObject(l.children);
      if (f) return f;
    }
  }
  return null;
}

// Design so skalieren, dass es das Rechteck vollständig bedeckt (cover), dann
// zentriert — entspricht Photopeas max(sx,sy)-Resize + Zentrierung.
function drawDesignCover(
  ctx: any,
  design: Canvas | any,
  rect: { x: number; y: number; w: number; h: number }
) {
  const dw = design.width, dh = design.height;
  const scale = Math.max(rect.w / dw, rect.h / dh);
  const w = dw * scale, h = dh * scale;
  const dx = rect.x + (rect.w - w) / 2;
  const dy = rect.y + (rect.h - h) / 2;
  ctx.drawImage(design, dx, dy, w, h);
}

// Rekursiv in z-Reihenfolge (ag-psd children: unten -> oben) auf die Ziel-
// Canvas compositen. Der Smart-Object-Layer wird durch das Design ersetzt.
function compositeLayers(
  ctx: any,
  layers: Layer[],
  soLayer: Layer,
  soRect: { x: number; y: number; w: number; h: number },
  design: Canvas | any
) {
  for (const l of layers) {
    if (l.hidden) continue;
    const op = (l as any).opacity ?? 1;
    if (op <= 0) continue;

    if (l === soLayer) {
      // Design ins SO-Rechteck, mit dem Blend/Opacity des Smart-Objects.
      ctx.save();
      ctx.globalAlpha = op;
      ctx.globalCompositeOperation = blendOp(l.blendMode);
      ctx.beginPath();
      ctx.rect(soRect.x, soRect.y, soRect.w, soRect.h);
      ctx.clip();
      drawDesignCover(ctx, design, soRect);
      ctx.restore();
      continue;
    }

    if (l.children) {
      // Gruppe (i.d.R. pass-through). Kinder direkt weiter compositen.
      // Nicht-normale Gruppen-Blends und Gruppen-Opacity werden vereinfacht
      // (ausreichend für die aktuellen Mockups).
      compositeLayers(ctx, l.children, soLayer, soRect, design);
      continue;
    }

    // Adjustment-Layer (Helligkeit/Sättigung) haben keine eigene Bitmap und
    // werden übersprungen — minimale Tonabweichung ggü. Photopea.
    if (!(l as any).canvas) continue;

    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = blendOp(l.blendMode);
    ctx.drawImage((l as any).canvas, l.left ?? 0, l.top ?? 0);
    ctx.restore();
  }
}

export interface RenderOptions {
  maxEdge?: number;   // längste Kante des Outputs, default 1200
  quality?: number;   // webp Qualität 0..100, default 85
}

// Kern: PSD-Datei + Design-Buffer -> gerendertes, verkleinertes WebP.
export async function renderMockup(
  psdPath: string,
  designBuf: Buffer,
  opts: RenderOptions = {}
): Promise<RenderResult> {
  const maxEdge = opts.maxEdge ?? 1200;
  const quality = opts.quality ?? 85;
  const { loadImage } = await import("@napi-rs/canvas");

  const psd = readPsd(fs.readFileSync(psdPath), {
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const W = psd.width, H = psd.height;

  const so = findSmartObject(psd.children);
  if (!so || !(so as any).placedLayer?.transform) {
    throw new Error("Kein Smart-Object mit Transform im PSD gefunden");
  }
  const soRect = transformRect((so as any).placedLayer.transform);

  const design = await loadImage(designBuf);

  const full = createCanvas(W, H);
  const fctx = full.getContext("2d");
  compositeLayers(fctx as any, psd.children || [], so, soRect, design);

  const long = Math.max(W, H);
  const scale = long > maxEdge ? maxEdge / long : 1;
  const ow = Math.max(1, Math.round(W * scale));
  const oh = Math.max(1, Math.round(H * scale));
  const out = createCanvas(ow, oh);
  out.getContext("2d").drawImage(full, 0, 0, ow, oh);

  const buffer = out.toBuffer("image/webp", quality);
  return { buffer, mime: "image/webp", width: ow, height: oh };
}

// Statisches Bild-Mockup (kind === "image"): nur verkleinern + WebP.
export async function renderStaticImage(
  imagePath: string,
  opts: RenderOptions = {}
): Promise<RenderResult> {
  const maxEdge = opts.maxEdge ?? 1200;
  const quality = opts.quality ?? 85;
  const { loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(fs.readFileSync(imagePath));
  const long = Math.max(img.width, img.height);
  const scale = long > maxEdge ? maxEdge / long : 1;
  const ow = Math.max(1, Math.round(img.width * scale));
  const oh = Math.max(1, Math.round(img.height * scale));
  const out = createCanvas(ow, oh);
  out.getContext("2d").drawImage(img, 0, 0, ow, oh);
  return { buffer: out.toBuffer("image/webp", quality), mime: "image/webp", width: ow, height: oh };
}
