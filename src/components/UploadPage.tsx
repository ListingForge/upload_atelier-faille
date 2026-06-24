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

      // 1) Run mockups via Photopea
      updateItem(id, { stage: "mockups" });
      log(id, `Generiere ${list.filter(l => l.kind === "psd").length} dynamische Mockups + ${list.filter(l => l.kind === "image").length} statische`);
      const renderer = getRenderer();
      const out: { src: string; itemId: string }[] = [];
      for (const m of list) {
        if (m.kind === "image") {
          out.push({ src: `/api/mockups/${orientation}/${m.id}/file`, itemId: m.id });
          continue;
        }
        try {
          const psdBlob = await fetchBlob(`/api/mockups/${orientation}/${m.id}/file`);
          log(id, `Rendere ${m.originalName}…`);
          const { blob } = await renderer.render({ psd: psdBlob, image: item.file });
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = reject;
            r.readAsDataURL(blob);
          });
          out.push({ src: dataUrl, itemId: m.id });
        } catch (e: any) {
          log(id, `Mockup ${m.originalName} fehlgeschlagen: ${e.message}`);
        }
      }
      updateItem(id, { generatedMockups: out });

      // 2) Upload base image to Printify
      updateItem(id, { stage: "uploading" });
      log(id, "Lade Master-Bild zu Printify…");
      const base64 = await blobToBase64(item.file);
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

      // 3) Create stretched + framed products
      updateItem(id, { stage: "creating" });
      const productIds: string[] = [];
      for (const type of ["stretched", "framed"] as const) {
        log(id, `Erstelle ${type} Produkt…`);
        const prR = await fetch("/api/printify/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            title: `${item.title} — ${type === "stretched" ? "Stretched Canvas" : "Framed Canvas"}`,
            description: "<p>" + item.title + "</p>",
            tags: ["canvas", type, orientation],
            type,
            orientation,
            printifyImageId,
          }),
        });
        if (!prR.ok) throw new Error(`Printify create (${type}): ${await prR.text()}`);
        const pr: any = await prR.json();
        productIds.push(pr.id);
        log(id, `Printify product ${pr.id} (${type}) erstellt`);

        // 4) Publish to Shopify (without auto-mockups)
        updateItem(id, { stage: "publishing" });
        const pubR = await fetch(`/api/printify/products/${pr.id}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        if (!pubR.ok) throw new Error(`Printify publish (${type}): ${await pubR.text()}`);
        log(id, `${type}: an Shopify gepublisht (ohne Auto-Mockups)`);

        // 5) Hänge die generierten Mockups als Shopify-Produktbilder an
        try {
          const idR = await fetch(`/api/printify/products/${pr.id}/shopify-id`, { credentials: "include" });
          if (!idR.ok) {
            log(id, `${type}: Shopify-Produkt-ID nicht ermittelbar — Mockups übersprungen`);
          } else {
            const { shopifyProductId } = await idR.json();
            log(id, `${type}: lade ${out.length} Mockups zu Shopify (${shopifyProductId})…`);
            for (let i = 0; i < out.length; i++) {
              const m = out[i];
              let dataUrl = m.src;
              if (!dataUrl.startsWith("data:")) {
                const blob = await fetchBlob(dataUrl);
                dataUrl = await new Promise<string>((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result));
                  r.onerror = reject;
                  r.readAsDataURL(blob);
                });
              }
              const imgR = await fetch(`/api/sh/products/${encodeURIComponent(shopifyProductId)}/images`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ dataUrl, filename: `${item.title}-${type}-${i + 1}.png` }),
              });
              if (!imgR.ok) log(id, `Mockup ${i + 1} (${type}) Shopify-Upload fehlgeschlagen: ${await imgR.text()}`);
            }
            log(id, `${type}: Mockups in Shopify abgelegt`);
          }
        } catch (e: any) {
          log(id, `${type}: Shopify-Mockup-Upload Fehler: ${e.message}`);
        }
      }
      updateItem(id, { stage: "done", shopifyProductIds: productIds });
    } catch (e: any) {
      updateItem(id, { stage: "failed", error: e.message });
      log(id, `FEHLER: ${e.message}`);
    }
  };

  const runAll = async () => {
    setBusy(true);
    for (const it of items) {
      if (it.stage === "pending" || it.stage === "failed") {
        // re-fetch the live item to include updates
        const live = items.find(x => x.id === it.id);
        if (live) await runOne(live);
      }
    }
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
