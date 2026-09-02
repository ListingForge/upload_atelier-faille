// Pflicht-Downscale direkt nach dem Bild-Fetch (Drive/URL/base64).
//
// Grund: ein 100-MB-PNG dekodiert sind mehrere GB im RAM — mal ~10 Mockups pro
// Design killt das den Server, bevor Printify etwas sieht. sharp (libvips)
// dekodiert speichereffizient und skaliert auf die längste Kante der größten
// Canvas-Variante bei ~150 DPI runter.
//
// Größte Größe: 40"x60" → 60" * 150 DPI = 9000 px längste Kante. Das ist zugleich
// Printifys Master-Cap; höher aufzulösen bringt nichts. Per Env übersteuerbar.

import sharp from "sharp";

const DEFAULT_MAX_EDGE = 9000;

export function designMaxEdge(): number {
  const v = Number(process.env.MCP_DESIGN_MAX_EDGE);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_EDGE;
}

// Design-Buffer auf maxEdge (längste Kante) runterrechnen und als JPEG kodieren.
// Kleinere Bilder bleiben unangetastet (withoutEnlargement). Gibt IMMER JPEG
// zurück — nachgelagerte Pipeline erwartet ein handliches Master-Bild.
export async function prepDesign(input: Buffer, maxEdge = designMaxEdge()): Promise<Buffer> {
  return sharp(input, { limitInputPixels: false, failOn: "none" })
    .rotate() // EXIF-Orientierung anwenden
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
