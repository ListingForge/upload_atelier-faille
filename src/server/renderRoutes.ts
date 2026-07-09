// Render-Endpoints: Preview eines einzelnen Mockups server-seitig (ohne Browser).
// Dient zum Testen des Canvas-Renders und wird von der UI nicht zwingend genutzt.

import express, { type Router } from "express";
import { resolveMockupFile } from "./mockups";
import { renderMockup, renderStaticImage } from "./render";

function decodeDataUrlOrBase64(input: string): Buffer {
  const m = /^data:.+?;base64,(.+)$/.exec(input);
  return Buffer.from(m ? m[1] : input, "base64");
}

export function createRenderRouter(): Router {
  const router = express.Router();

  // POST /api/render/preview
  // Body: { orientation, id, imageBase64|imageDataUrl, maxEdge?, quality? }
  // Antwort: image/webp Bytes.
  router.post("/preview", async (req, res) => {
    try {
      const { orientation, id, imageBase64, imageDataUrl, maxEdge, quality } = req.body || {};
      if (!orientation || !id) return res.status(400).json({ error: "orientation + id erforderlich" });
      const raw = imageDataUrl || imageBase64;
      if (!raw) return res.status(400).json({ error: "imageBase64 oder imageDataUrl erforderlich" });

      const resolved = resolveMockupFile(orientation, id);
      if (!resolved) return res.status(404).json({ error: "Mockup nicht gefunden" });

      const designBuf = decodeDataUrlOrBase64(String(raw));
      const opts = { maxEdge: maxEdge ? Number(maxEdge) : undefined, quality: quality ? Number(quality) : undefined };

      const result = resolved.kind === "psd"
        ? await renderMockup(resolved.path, designBuf, opts)
        : await renderStaticImage(resolved.path, opts);

      res.setHeader("Content-Type", result.mime);
      res.setHeader("X-Render-Dims", `${result.width}x${result.height}`);
      res.send(result.buffer);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Render fehlgeschlagen" });
    }
  });

  return router;
}
