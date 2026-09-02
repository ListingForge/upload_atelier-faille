// Server-seitiges Mockup-Rendering ohne Browser/Photopea.
//
// Ersetzt den Smart-Object-Inhalt eines Mockup-PSDs durch ein Design und
// flattened das Ergebnis per @napi-rs/canvas. Das Design wird per Affin-
// Transform auf die 4 Ecken des Smart-Objects gelegt — deckt achsenparallele
// UND rotierte/gescherte Platzierungen exakt ab (der komplette Atelier-Faille-
// Bestand ist affin, skew 0). Multiply-Blend über Hintergrund + Lighting-Overlays.
//
// Für PSDs mit echtem Perspektiv-Warp (nonAffine, gebogene Kanten) reicht die
// Affin-Abbildung nicht — solche Mockups bräuchten eine Homographie/Mesh oder
// den Photopea-Fallback. Aktueller Bestand hat keine echte Perspektive.

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

// Smart-Object-Transform (8 Werte) -> die 4 Eckpunkte in Foto-Reihenfolge
// TL, TR, BR, BL (ag-psd liefert sie so). Trägt Rotation/Scherung, nicht nur
// die Bounding-Box.
interface Quad { tl: [number, number]; tr: [number, number]; br: [number, number]; bl: [number, number]; }
function transformQuad(t: number[]): Quad {
  return { tl: [t[0], t[1]], tr: [t[2], t[3]], br: [t[4], t[5]], bl: [t[6], t[7]] };
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

// Design cover-fit in das (evtl. rotierte) Smart-Object-Quad zeichnen.
// Der Canvas wird in den lokalen Rahmen des Quads transformiert (TL = Ursprung,
// x-Achse entlang TL->TR, y-Achse entlang TL->BL), dann das Design im lokalen
// Rechteck [0,0,qw,qh] cover-skaliert + zentriert + geclippt. So folgt es der
// Rotation/Scherung der Leinwand statt frontal-flach zu sitzen.
function drawDesignInQuad(ctx: any, design: Canvas | any, q: Quad) {
  const ux = q.tr[0] - q.tl[0], uy = q.tr[1] - q.tl[1]; // Oberkante TL->TR
  const vx = q.bl[0] - q.tl[0], vy = q.bl[1] - q.tl[1]; // linke Kante TL->BL
  const qw = Math.hypot(ux, uy), qh = Math.hypot(vx, vy);
  if (qw < 1 || qh < 1) return;
  ctx.save();
  // lokal -> Welt: (px,py) -> TL + px*(u/qw) + py*(v/qh)
  ctx.transform(ux / qw, uy / qw, vx / qh, vy / qh, q.tl[0], q.tl[1]);
  ctx.beginPath();
  ctx.rect(0, 0, qw, qh);
  ctx.clip();
  const dw = design.width, dh = design.height;
  const scale = Math.max(qw / dw, qh / dh);
  const w = dw * scale, h = dh * scale;
  ctx.drawImage(design, (qw - w) / 2, (qh - h) / 2, w, h);
  ctx.restore();
}

// Rekursiv in z-Reihenfolge (ag-psd children: unten -> oben) auf die Ziel-
// Canvas compositen. Der Smart-Object-Layer wird durch das Design ersetzt.
function compositeLayers(
  ctx: any,
  layers: Layer[],
  soLayer: Layer,
  soQuad: Quad,
  design: Canvas | any
) {
  for (const l of layers) {
    if (l.hidden) continue;
    const op = (l as any).opacity ?? 1;
    if (op <= 0) continue;

    if (l === soLayer) {
      // Design ins SO-Quad (affin), mit dem Blend/Opacity des Smart-Objects.
      ctx.save();
      ctx.globalAlpha = op;
      ctx.globalCompositeOperation = blendOp(l.blendMode);
      drawDesignInQuad(ctx, design, soQuad);
      ctx.restore();
      continue;
    }

    if (l.children) {
      // Gruppe (i.d.R. pass-through). Kinder direkt weiter compositen.
      // Nicht-normale Gruppen-Blends und Gruppen-Opacity werden vereinfacht
      // (ausreichend für die aktuellen Mockups).
      compositeLayers(ctx, l.children, soLayer, soQuad, design);
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
  const soQuad = transformQuad((so as any).placedLayer.transform);

  const design = await loadImage(designBuf);

  const full = createCanvas(W, H);
  const fctx = full.getContext("2d");
  compositeLayers(fctx as any, psd.children || [], so, soQuad, design);

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
