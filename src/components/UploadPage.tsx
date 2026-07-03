import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Image as ImageIcon, Loader2, X, Play, CheckCircle2, AlertCircle } from "lucide-react";
import type { MockupItem, MockupLists, Orientation } from "../types";
import { getRenderer } from "../lib/photopea";

type Stage = "pending" | "detecting" | "mockups" | "uploading" | "creating" | "publishing" | "done" | "failed";

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
  orientation?: Orientation;
  width?: number;
  height?: number;
  title: string;
  stage: Stage;
  log: string[];
  generatedMockups: { src: string; itemId: string }[];
  shopifyProductIds?: string[];
  error?: string;
}

function detectOrientation(file: File): Promise<{ orientation: Orientation; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ orientation: img.naturalWidth >= img.naturalHeight ? "horizontal" : "vertical", w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = e => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.blob();
}

async function downscaleImage(file: Blob, maxEdge: number, mime = "image/jpeg", quality = 0.9): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const long = Math.max(img.width, img.height);
    if (long <= maxEdge) return file;
    const scale = maxEdge / long;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob failed"))), mime, quality);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Wie viele Items/Aufgaben gleichzeitig laufen dürfen.
// Photopea selbst serialisiert intern über den Singleton-Iframe — mehr Items
// bringen aber trotzdem viel, weil Printify-Uploads, Shopify-Polling und
// Bild-Uploads parallel zum Rendern anderer Items ablaufen können.
const ITEM_CONCURRENCY = 4;

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export default function UploadPage() {
  const [lists, setLists] = useState<MockupLists>({ vertical: [], horizontal: [] });
  const [items, setItems] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/mockups", { credentials: "include" })
      .then(r => r.json())
      .then((d: MockupLists) => setLists(d));
  }, []);

  const onFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const created: PendingImage[] = [];
    for (const file of arr) {
      const id = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      const det = await detectOrientation(file).catch(() => null);
      created.push({
        id,
        file,
        previewUrl,
        orientation: det?.orientation,
        width: det?.w,
        height: det?.h,
        title: file.name.replace(/\.[^.]+$/, ""),
        stage: "pending",
        log: [],
        generatedMockups: [],
      });
    }
    setItems(prev => [...prev, ...created]);
  }, []);

  const updateItem = (id: string, patch: Partial<PendingImage>) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patch } : it)));
  };
  const log = (id: string, msg: string) =>
    setItems(prev => prev.map(it => (it.id === id ? { ...it, log: [...it.log, msg] } : it)));

  const removeItem = (id: string) => setItems(prev => prev.filter(it => it.id !== id));

  const runOne = async (item: PendingImage) => {
    const id = item.id;
    try {
      // Determine orientation
      const orientation: Orientation = item.orientation ?? (item.file ? (await detectOrientation(item.file)).orientation : "vertical");
      updateItem(id, { orientation });
      const list = lists[orientation];

      // Downscale für Photopea + Gemini (Mockup-Auflösung reicht, spart drastisch Zeit)
      const renderImage = await downscaleImage(item.file, 4500);
      if (renderImage !== item.file) {
        log(id, `Bild für Render auf max 4500 px skaliert (${(renderImage.size / 1024 / 1024).toFixed(1)} MB)`);
      }

      // Gemini parallel zum Rendern starten — Titel ist früh fertig
      const geminiPromise = (async () => {
        try {
          const b64 = await blobToBase64(renderImage);
          const r = await fetch("/api/gemini/title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ imageBase64: b64, mimeType: renderImage.type || "image/jpeg" }),
          });
          if (!r.ok) {
            log(id, `Gemini fehlgeschlagen: ${await r.text()}`);
            return null;
          }
          const g: { title?: string; description?: string } = await r.json();
          if (g.title) {
            updateItem(id, { title: g.title });
            log(id, `Titel: „${g.title}"`);
          }
          return g;
        } catch (e: any) {
          log(id, `Gemini-Fehler: ${e.message}`);
          return null;
        }
      })();

      // 1) Run mockups via Photopea
      updateItem(id, { stage: "mockups" });
      log(id, `Generiere ${list.filter(l => l.kind === "psd").length} dynamische Mockups + ${list.filter(l => l.kind === "image").length} statische`);
      const renderer = getRenderer();
      const out: { src: string; itemId: string }[] = [];
      for (const m of list) {
        if (m.kind === "image") {
          // Statisches Bild sofort zu dataURL — sonst passiert der Netz-Fetch
          // erst in der Upload-Phase und kann dort still fehlschlagen.
          try {
            const blob = await fetchBlob(`/api/mockups/${orientation}/${m.id}/file`);
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result));
              r.onerror = reject;
              r.readAsDataURL(blob);
            });
            out.push({ src: dataUrl, itemId: m.id });
          } catch (e: any) {
            log(id, `Statisches Mockup ${m.originalName} konnte nicht geladen werden: ${e.message}`);
          }
          continue;
        }
        let psdBlob: Blob;
        try {
          psdBlob = await fetchBlob(`/api/mockups/${orientation}/${m.id}/file`);
        } catch (e: any) {
          log(id, `Mockup ${m.originalName} konnte nicht geladen werden: ${e.message}`);
          continue;
        }
        let lastErr: any = null;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            log(id, attempt === 1 ? `Rendere ${m.originalName}…` : `Wiederhole ${m.originalName} (Versuch ${attempt}/${maxAttempts})…`);
            const { blob } = await renderer.render({ psd: psdBlob, image: renderImage });
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result));
              r.onerror = reject;
              r.readAsDataURL(blob);
            });
            out.push({ src: dataUrl, itemId: m.id });
            lastErr = null;
            break;
          } catch (e: any) {
            lastErr = e;
            log(id, `Render-Versuch ${attempt} fehlgeschlagen: ${e.message}`);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000));
          }
        }
        if (lastErr) log(id, `Mockup ${m.originalName} fehlgeschlagen: ${lastErr.message}`);
        await new Promise(r => setTimeout(r, 100));
      }
      updateItem(id, { generatedMockups: out });

      // 2) Upload base image to Printify (downscaled to keep request body manageable;
      // 9000 px gives ~150 DPI on the largest canvas size: 60").
      updateItem(id, { stage: "uploading" });
      const printImage = await downscaleImage(item.file, 9000);
      if (printImage !== item.file) {
        log(id, `Master-Bild für Printify auf max 9000 px skaliert (${(printImage.size / 1024 / 1024).toFixed(1)} MB)`);
      }
      log(id, "Lade Master-Bild zu Printify…");
      const base64 = await blobToBase64(printImage);
      const upR = await fetch("/api/printify/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: item.file.name, contents: base64 }),
      });
      if (!upR.ok) throw new Error(`Printify upload: ${await upR.text()}`);
      const up: any = await upR.json();
      const printifyImageId: string = up.id;
      log(id, `Printify image_id ${printifyImageId}`);

      // 2b) Gemini-Ergebnis abwarten (lief parallel zum Rendern)
      let productTitle = item.title;
      let productDescription = `<p>${item.title}</p>`;
      const gemini = await geminiPromise;
      if (gemini?.title) productTitle = gemini.title;
      if (gemini?.description) productDescription = `<p>${gemini.description}</p>`;

      // 3) stretched + framed parallel erzeugen, publishen, Mockups anhängen
      updateItem(id, { stage: "creating" });
      const runVariant = async (type: "stretched" | "framed"): Promise<string> => {
        log(id, `Erstelle ${type} Produkt…`);
        const prR = await fetch("/api/printify/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            title: `${productTitle} — ${type === "stretched" ? "Leinwand" : "Gerahmt"}`,
            description: productDescription,
            tags: ["canvas", type, orientation],
            type,
            orientation,
            printifyImageId,
          }),
        });
        if (!prR.ok) throw new Error(`Printify create (${type}): ${await prR.text()}`);
        const pr: any = await prR.json();
        log(id, `Printify product ${pr.id} (${type}) erstellt`);

        updateItem(id, { stage: "publishing" });
        const pubR = await fetch(`/api/printify/products/${pr.id}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        if (!pubR.ok) throw new Error(`Printify publish (${type}): ${await pubR.text()}`);
        log(id, `${type}: an Shopify gepublisht (ohne Auto-Mockups)`);

        log(id, `${type}: warte bis Printify das Produkt in Shopify angelegt hat…`);
        // Zwei Poll-Wege parallel:
        //  A) /api/printify/products/:printifyId/shopify-id  — deterministisch via external.id,
        //     funktioniert aber nur wenn Printify's publishing_succeeded-Webhook zurückkommt
        //     (in unserem Setup nicht immer der Fall → kann leer bleiben).
        //  B) /api/sh/find-product?title=…&vendor=Printify — Titel-Fuzzy-Match in Shopify,
        //     funktioniert sobald Printify das Produkt gepusht hat (Sekunden).
        // Wer zuerst antwortet, gewinnt. Bei sequentiellen Uploads (aktueller User-Flow)
        // ist Titel-Kollision extrem unwahrscheinlich.
        const shopifyTitle = `${productTitle} — ${type === "stretched" ? "Leinwand" : "Gerahmt"}`;
        let shopifyProductId: string | null = null;
        const pollStart = Date.now();
        const pollMax = 5 * 60 * 1000;
        while (Date.now() - pollStart < pollMax) {
          const [pfRes, shRes] = await Promise.all([
            fetch(`/api/printify/products/${encodeURIComponent(pr.id)}/shopify-id`, { credentials: "include" }).catch(() => null),
            fetch(`/api/sh/find-product?${new URLSearchParams({ title: shopifyTitle, vendor: "Printify" })}`, { credentials: "include" }).catch(() => null),
          ]);
          if (pfRes?.ok) {
            const j = await pfRes.json();
            shopifyProductId = j.shopifyProductId;
            break;
          }
          if (shRes?.ok) {
            const j = await shRes.json();
            shopifyProductId = j.shopifyProductId;
            break;
          }
          // 5xx auf shopify-search ist hart-fatal (nicht bloss "noch nicht da")
          if (shRes && shRes.status >= 500) {
            const errText = await shRes.text();
            throw new Error(`${type}: Shopify-Suche-Fehler (${shRes.status}): ${errText.slice(0, 200)}`);
          }
          await new Promise(res => setTimeout(res, 5000));
        }
        if (!shopifyProductId) {
          throw new Error(`${type}: Produkt nach 5 min nicht in Shopify gefunden — Mockups nicht angebracht`);
        }
        log(id, `${type}: Produkt gefunden in Shopify (${shopifyProductId})`);
        log(id, `${type}: lade ${out.length} Mockups zu Shopify (${shopifyProductId})…`);

        // Alle Mockups in einer productCreateMedia-Mutation → Reihenfolge im
        // Array = Position im Shopify-Produkt. Staged uploads laufen serverseitig parallel.
        const batchImages = out.map((m, i) => ({
          dataUrl: m.src,
          filename: `${productTitle}-${type}-${i + 1}.png`,
        }));
        const batchR = await fetch(`/api/sh/products/${encodeURIComponent(shopifyProductId)}/images/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ images: batchImages }),
        });
        if (!batchR.ok) {
          throw new Error(`${type}: Shopify-Batch-Upload fehlgeschlagen: ${await batchR.text()}`);
        }
        const batchJson = await batchR.json();
        const mockupsUploaded = batchJson?.count ?? out.length;
        log(id, `${type}: ${mockupsUploaded}/${out.length} Mockups in Shopify abgelegt`);

        try {
          const relR = await fetch(`/api/sh/products/${encodeURIComponent(shopifyProductId)}/relabel-sizes-cm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: "{}",
          });
          if (!relR.ok) {
            log(id, `${type}: cm-Relabel fehlgeschlagen: ${await relR.text()}`);
          } else {
            const { updated } = await relR.json();
            log(id, `${type}: ${updated?.length ?? 0} Varianten-Labels in cm umbenannt`);
          }
        } catch (e: any) {
          log(id, `${type}: cm-Relabel Fehler: ${e.message}`);
        }
        return pr.id as string;
      };

      const variantResults = await Promise.allSettled([runVariant("stretched"), runVariant("framed")]);
      const productIds: string[] = [];
      const variantErrors: string[] = [];
      for (const r of variantResults) {
        if (r.status === "fulfilled") productIds.push(r.value);
        else variantErrors.push(r.reason?.message ?? String(r.reason));
      }
      if (productIds.length === 0) throw new Error(variantErrors.join(" | "));
      if (variantErrors.length > 0) log(id, `Teilweiser Fehler: ${variantErrors.join(" | ")}`);
      updateItem(id, { stage: "done", shopifyProductIds: productIds });
    } catch (e: any) {
      updateItem(id, { stage: "failed", error: e.message });
      log(id, `FEHLER: ${e.message}`);
    }
  };

  const runAll = async () => {
    setBusy(true);
    const todo = items.filter(it => it.stage === "pending" || it.stage === "failed");
    await runWithConcurrency(todo, ITEM_CONCURRENCY, async it => {
      await runOne(it);
    });
    setBusy(false);
  };

  return (
    <div className="max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bulk Upload</h1>
          <p className="text-sm text-slate-500 mt-1">
            Bilder droppen → Orientation wird erkannt → Mockups via Photopea → stretched + framed Produkte → Shopify
          </p>
        </div>
        <button
          onClick={runAll}
          disabled={busy || items.length === 0}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
        >
          <Play className="w-4 h-4" />
          {busy ? "Läuft…" : `Alle ${items.length} starten`}
        </button>
      </div>

      <div
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer bg-white hover:border-slate-400 transition-colors mb-6"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={e => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Upload className="w-8 h-8 mx-auto mb-2 text-slate-400" />
        <p className="text-sm font-semibold text-slate-700">Midjourney-Bilder hier ziehen oder klicken</p>
        <p className="text-xs text-slate-500 mt-1">PNG / JPG / WebP — Format wird automatisch erkannt</p>
      </div>

      <div className="space-y-3">
        {items.map(it => (
          <ItemRow key={it.id} item={it} onRemove={() => removeItem(it.id)} onRun={() => runOne(it)} />
        ))}
      </div>
    </div>
  );
}

function ItemRow({ item, onRun, onRemove }: { item: PendingImage; onRun: () => void; onRemove: () => void }) {
  const stageLabel: Record<Stage, string> = {
    pending: "Bereit",
    detecting: "Erkenne Format…",
    mockups: "Generiere Mockups…",
    uploading: "Lade zu Printify…",
    creating: "Erstelle Produkte…",
    publishing: "Publishe zu Shopify…",
    done: "Fertig",
    failed: "Fehlgeschlagen",
  };
  const stageColor: Record<Stage, string> = {
    pending: "bg-slate-100 text-slate-600",
    detecting: "bg-indigo-100 text-indigo-700",
    mockups: "bg-indigo-100 text-indigo-700",
    uploading: "bg-indigo-100 text-indigo-700",
    creating: "bg-indigo-100 text-indigo-700",
    publishing: "bg-indigo-100 text-indigo-700",
    done: "bg-emerald-100 text-emerald-700",
    failed: "bg-rose-100 text-rose-700",
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="flex gap-4 p-4">
        <img src={item.previewUrl} alt="" className="w-24 h-24 object-cover rounded-lg shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-semibold text-slate-900 truncate">{item.title}</p>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${stageColor[item.stage]}`}>{stageLabel[item.stage]}</span>
            {item.orientation && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 uppercase">
                {item.orientation === "vertical" ? "Hoch" : "Quer"}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 font-mono">
            {item.width && item.height ? `${item.width} × ${item.height}` : "—"} · {(item.file.size / 1024 / 1024).toFixed(1)} MB
          </p>
          {item.log.length > 0 && (
            <div className="mt-2 max-h-24 overflow-y-auto bg-slate-50 rounded p-2 font-mono text-[10px] text-slate-600">
              {item.log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
          {item.error && (
            <p className="text-xs text-rose-600 mt-1 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {item.error}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button onClick={onRun} disabled={item.stage !== "pending" && item.stage !== "failed"} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-600 text-white disabled:bg-slate-300 cursor-pointer">
            {item.stage === "done" ? <CheckCircle2 className="w-4 h-4 inline" /> : item.stage === "pending" || item.stage === "failed" ? "Start" : <Loader2 className="w-4 h-4 inline animate-spin" />}
          </button>
          <button onClick={onRemove} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer">
            <X className="w-4 h-4 inline" />
          </button>
        </div>
      </div>
      {item.generatedMockups.length > 0 && (
        <div className="border-t border-slate-100 p-3 grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 bg-slate-50">
          {item.generatedMockups.map((m, i) => (
            <div key={i} className="aspect-square rounded overflow-hidden bg-slate-100">
              <img src={m.src} alt={`mockup ${i}`} className="w-full h-full object-cover" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
