import express, { type Request, type Response, type Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { readPsd, initializeCanvas } from "ag-psd";
import { createCanvas } from "@napi-rs/canvas";

// Wire ag-psd up to @napi-rs/canvas so it can decode/composite PSD image data
// server-side. Prebuilt native binaries — no compile step at deploy.
initializeCanvas(createCanvas as any);

const THUMB_DIR = path.join(process.cwd(), "data", "mockup-thumbs");
const THUMB_MAX_EDGE = 512;

const DATA_DIR = path.join(process.cwd(), "data");
const MOCKUP_DIR = path.join(DATA_DIR, "mockups");
const INDEX_FILE = path.join(DATA_DIR, "mockup-lists.json");

type Orientation = "vertical" | "horizontal";
type MockupKind = "psd" | "image";

export interface MockupItem {
  id: string;
  filename: string;
  originalName: string;
  kind: MockupKind;
  mime: string;
  size: number;
  uploadedAt: string;
}

interface Index {
  vertical: MockupItem[];
  horizontal: MockupItem[];
}

function ensureDirs() {
  fs.mkdirSync(path.join(MOCKUP_DIR, "vertical"), { recursive: true });
  fs.mkdirSync(path.join(MOCKUP_DIR, "horizontal"), { recursive: true });
  fs.mkdirSync(path.join(THUMB_DIR, "vertical"), { recursive: true });
  fs.mkdirSync(path.join(THUMB_DIR, "horizontal"), { recursive: true });
}

// Prefer the PSD's embedded JPEG thumbnail (fast, ~256px). If missing, render
// the composite once via ag-psd + @napi-rs/canvas, downscale to THUMB_MAX_EDGE,
// and cache to data/mockup-thumbs/<orientation>/<id>.jpg.
function ensureThumb(orientation: Orientation, id: string, psdPath: string): string | null {
  const thumbPath = path.join(THUMB_DIR, orientation, `${id}.jpg`);
  if (fs.existsSync(thumbPath)) return thumbPath;
  try {
    const buf = fs.readFileSync(psdPath);

    // Try embedded thumbnail first — cheap when present.
    const meta = readPsd(buf, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: false,
    });
    const rawThumb: any = (meta as any).imageResources?.thumbnailRaw;
    if (rawThumb) {
      const data: Uint8Array | undefined = rawThumb.data ?? (rawThumb.length ? rawThumb : undefined);
      if (data && data.length > 0) {
        fs.writeFileSync(thumbPath, Buffer.from(data));
        return thumbPath;
      }
    }

    // Fallback: render the composite ourselves.
    const psd = readPsd(buf, { skipLayerImageData: true });
    const src: any = (psd as any).canvas;
    if (!src) return null;
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const out = createCanvas(w, h);
    const ctx = out.getContext("2d");
    ctx.drawImage(src, 0, 0, w, h);
    const jpeg = out.toBuffer("image/jpeg", 80);
    fs.writeFileSync(thumbPath, jpeg);
    return thumbPath;
  } catch {
    return null;
  }
}

function deleteThumb(orientation: Orientation, id: string) {
  const thumbPath = path.join(THUMB_DIR, orientation, `${id}.jpg`);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
}

function loadIndex(): Index {
  if (!fs.existsSync(INDEX_FILE)) return { vertical: [], horizontal: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    return { vertical: [], horizontal: [] };
  }
}

function saveIndex(idx: Index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

function isOrientation(s: string): s is Orientation {
  return s === "vertical" || s === "horizontal";
}

function kindFor(mime: string, filename: string): MockupKind {
  if (mime === "image/vnd.adobe.photoshop" || mime === "application/x-photoshop" || /\.psd$/i.test(filename)) {
    return "psd";
  }
  return "image";
}

export function createMockupsRouter(): Router {
  ensureDirs();
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const orientation = req.params.orientation;
        if (!isOrientation(orientation)) return cb(new Error("bad orientation"), "");
        cb(null, path.join(MOCKUP_DIR, orientation));
      },
      filename: (_req, file, cb) => {
        const id = crypto.randomBytes(8).toString("hex");
        const ext = path.extname(file.originalname);
        cb(null, `${id}${ext}`);
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
  });

  // GET /api/mockups - both lists
  router.get("/", (_req, res) => {
    res.json(loadIndex());
  });

  // POST /api/mockups/:orientation - upload one or more files
  router.post("/:orientation", upload.array("files", 50), (req: Request, res: Response) => {
    const orientation = req.params.orientation;
    if (!isOrientation(orientation)) return res.status(400).json({ error: "bad orientation" });
    const files = (req.files as Express.Multer.File[]) || [];
    const idx = loadIndex();
    const created: MockupItem[] = [];
    for (const f of files) {
      const item: MockupItem = {
        id: path.parse(f.filename).name,
        filename: f.filename,
        originalName: f.originalname,
        kind: kindFor(f.mimetype, f.originalname),
        mime: f.mimetype,
        size: f.size,
        uploadedAt: new Date().toISOString(),
      };
      idx[orientation].push(item);
      created.push(item);
    }
    saveIndex(idx);
    res.json({ created });
  });

  // PUT /api/mockups/:orientation/order - reorder by item ids
  router.put("/:orientation/order", (req: Request, res: Response) => {
    const orientation = req.params.orientation;
    if (!isOrientation(orientation)) return res.status(400).json({ error: "bad orientation" });
    const order: string[] = Array.isArray(req.body?.order) ? req.body.order : [];
    const idx = loadIndex();
    const byId = new Map(idx[orientation].map(i => [i.id, i]));
    const reordered: MockupItem[] = [];
    for (const id of order) {
      const item = byId.get(id);
      if (item) {
        reordered.push(item);
        byId.delete(id);
      }
    }
    // append any items that were not in the order array (defensive)
    for (const remaining of byId.values()) reordered.push(remaining);
    idx[orientation] = reordered;
    saveIndex(idx);
    res.json({ ok: true });
  });

  // DELETE /api/mockups/:orientation/:id
  router.delete("/:orientation/:id", (req: Request, res: Response) => {
    const orientation = req.params.orientation;
    const id = req.params.id;
    if (!isOrientation(orientation)) return res.status(400).json({ error: "bad orientation" });
    const idx = loadIndex();
    const item = idx[orientation].find(i => i.id === id);
    if (!item) return res.status(404).json({ error: "not found" });
    idx[orientation] = idx[orientation].filter(i => i.id !== id);
    saveIndex(idx);
    const fp = path.join(MOCKUP_DIR, orientation, item.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    deleteThumb(orientation, id);
    res.json({ ok: true });
  });

  // GET /api/mockups/:orientation/:id/thumb - serve the PSD's embedded JPEG preview.
  // 404 if the file isn't a PSD, doesn't exist, or has no embedded thumbnail — the
  // client falls back to the placeholder tile in that case.
  router.get("/:orientation/:id/thumb", (req: Request, res: Response) => {
    const orientation = req.params.orientation;
    const id = req.params.id;
    if (!isOrientation(orientation)) return res.status(400).end();
    const idx = loadIndex();
    const item = idx[orientation].find(i => i.id === id);
    if (!item || item.kind !== "psd") return res.status(404).end();
    const fp = path.join(MOCKUP_DIR, orientation, item.filename);
    if (!fs.existsSync(fp)) return res.status(404).end();
    const thumbPath = ensureThumb(orientation, id, fp);
    if (!thumbPath) return res.status(404).end();
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(thumbPath);
  });

  // GET /api/mockups/:orientation/:id/file - serve raw file (or thumbnail for PSD)
  router.get("/:orientation/:id/file", (req: Request, res: Response) => {
    const orientation = req.params.orientation;
    const id = req.params.id;
    if (!isOrientation(orientation)) return res.status(400).end();
    const idx = loadIndex();
    const item = idx[orientation].find(i => i.id === id);
    if (!item) return res.status(404).end();
    const fp = path.join(MOCKUP_DIR, orientation, item.filename);
    if (!fs.existsSync(fp)) return res.status(404).end();
    res.sendFile(fp);
  });

  return router;
}
