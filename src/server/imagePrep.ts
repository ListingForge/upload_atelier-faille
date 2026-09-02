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

// libvips zügeln: kein Cross-Request-Cache, ein Worker-Thread. Sonst puffert der
// Thread-Pool je Aufruf zusätzlichen Speicher — auf der 4-GB-Kiste kritisch.
sharp.cache(false);
sharp.concurrency(1);

const DEFAULT_MAX_EDGE = 9000;

// Ein 150-MB-Design spitzt beim Dekodieren auf ~1,1 GB RSS. Der Prod-Server hat
// nur ~2 GB frei — zwei parallele Prep-Vorgänge (UI-Upload während MCP-Batch)
// würden ihn killen. Darum prozessweit serialisieren: immer nur EIN prepDesign
// gleichzeitig, der Rest wartet in der Kette. Batch ist ohnehin sequenziell,
// das hier fängt nur überlappende Requests ab.
let prepChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = prepChain.then(fn, fn);
  prepChain = run.then(() => undefined, () => undefined);
  return run;
}

export function designMaxEdge(): number {
  const v = Number(process.env.MCP_DESIGN_MAX_EDGE);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_EDGE;
}

// Design-Buffer auf maxEdge (längste Kante) runterrechnen und als JPEG kodieren.
// Kleinere Bilder bleiben unangetastet (withoutEnlargement). Gibt IMMER JPEG
// zurück — nachgelagerte Pipeline erwartet ein handliches Master-Bild.
//
// sequentialRead: PNG kann nicht shrink-on-load; ohne dies dekodiert libvips das
// ganze Bild (ein 145-MB-upscayl-PNG = >1 GB Raster) VOR dem Resize und kippt den
// Server. Sequenziell liest libvips scanline-weise und schrumpft im Durchlauf —
// Peak-RAM ~ Zeilenpuffer statt Vollbild. Zielgröße bleibt 9000 px (Printifys
// nutzbares Master-Cap bei ~150 DPI), also kein Print-Qualitätsverlust; die
// weggeworfenen Pixel sind ohnehin upscayl-Interpolation über Printifys Druck-DPI.
// 4:4:4 (kein Chroma-Subsampling) + q95: hält Linienkunst-Kanten scharf.
export function prepDesign(input: Buffer, maxEdge = designMaxEdge()): Promise<Buffer> {
  return serialize(() =>
    sharp(input, { limitInputPixels: false, failOn: "none", sequentialRead: true })
      .rotate() // EXIF-Orientierung anwenden
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer()
  );
}
