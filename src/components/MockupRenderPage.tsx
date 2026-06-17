import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { Upload, Play, Square, Download, Trash2, Loader2, CheckCircle2, AlertCircle, Image as ImageIcon } from "lucide-react";
import type { MockupItem, MockupLists, Orientation } from "../types";
import { getRenderer } from "../lib/photopea";

interface Design {
  id: string;
  file: File;
  previewUrl: string;
  orientation: Orientation;
  width: number;
  height: number;
}

interface Job {
  id: string;
  designId: string;
  designName: string;
  templateId: string;
  templateName: string;
  orientation: Orientation;
  templateKind: "psd" | "image";
  status: "pending" | "rendering" | "done" | "failed";
  blobUrl?: string;
  staticSrc?: string;
  error?: string;
}

type ScopeFilter = "auto" | "vertical" | "horizontal" | "both";

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

export default function MockupRenderPage() {
  const [lists, setLists] = useState<MockupLists>({ vertical: [], horizontal: [] });
  const [designs, setDesigns] = useState<Design[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("auto");
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/mockups", { credentials: "include" })
      .then(r => r.json())
      .then((d: MockupLists) => setLists(d));
  }, []);

  const onFiles = useCallback(async (files: FileList | File[]) => {
    const out: Design[] = [];
    for (const file of Array.from(files)) {
      try {
        const det = await detectOrientation(file);
        out.push({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          orientation: det.orientation,
          width: det.w,
          height: det.h,
        });
      } catch {
        // skip non-image
      }
    }
    setDesigns(prev => [...prev, ...out]);
  }, []);

  const removeDesign = (id: string) => {
    setDesigns(prev => {
      const next = prev.filter(d => d.id !== id);
      const removed = prev.find(d => d.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
    setJobs(prev => prev.filter(j => j.designId !== id));
  };

  const templatesFor = (designOrientation: Orientation): { orientation: Orientation; items: MockupItem[] }[] => {
    if (scope === "auto") return [{ orientation: designOrientation, items: lists[designOrientation] }];
    if (scope === "both") return [
      { orientation: "vertical", items: lists.vertical },
      { orientation: "horizontal", items: lists.horizontal },
    ];
    return [{ orientation: scope, items: lists[scope] }];
  };

  const buildJobs = (): Job[] => {
    const out: Job[] = [];
    for (const d of designs) {
      for (const { orientation, items } of templatesFor(d.orientation)) {
        for (const t of items) {
          out.push({
            id: `${d.id}__${orientation}__${t.id}`,
            designId: d.id,
            designName: d.file.name.replace(/\.[^.]+$/, ""),
            templateId: t.id,
            templateName: t.originalName,
            orientation,
            templateKind: t.kind,
            status: "pending",
          });
        }
      }
    }
    return out;
  };

  const runAll = async () => {
    if (running) return;
    const planned = buildJobs();
    if (planned.length === 0) return;
    setJobs(planned);
    setRunning(true);
    abortRef.current = false;
    const renderer = getRenderer();

    const updateJob = (id: string, patch: Partial<Job>) =>
      setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...patch } : j)));

    for (const job of planned) {
      if (abortRef.current) {
        updateJob(job.id, { status: "failed", error: "Abgebrochen" });
        continue;
      }
      const design = designs.find(d => d.id === job.designId);
      if (!design) continue;

      // Static images don't need Photopea, just reference the file.
      if (job.templateKind === "image") {
        updateJob(job.id, { status: "done", staticSrc: `/api/mockups/${job.orientation}/${job.templateId}/file` });
        continue;
      }

      updateJob(job.id, { status: "rendering" });
      try {
        const psdBlob = await fetchBlob(`/api/mockups/${job.orientation}/${job.templateId}/file`);
        const { blob } = await renderer.render({ psd: psdBlob, image: design.file });
        updateJob(job.id, { status: "done", blobUrl: URL.createObjectURL(blob) });
      } catch (e: any) {
        updateJob(job.id, { status: "failed", error: e?.message || "Render fehlgeschlagen" });
      }
    }
    setRunning(false);
  };

  const stop = () => {
    abortRef.current = true;
  };

  const clearJobs = () => {
    for (const j of jobs) if (j.blobUrl) URL.revokeObjectURL(j.blobUrl);
    setJobs([]);
  };

  const downloadAll = async () => {
    const doneJobs = jobs.filter(j => j.status === "done" && (j.blobUrl || j.staticSrc));
    if (doneJobs.length === 0) return;
    const zip = new JSZip();
    for (const job of doneJobs) {
      try {
        const src = job.blobUrl ?? job.staticSrc!;
        const resp = await fetch(src, { credentials: "include" });
        const blob = await resp.blob();
        const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
        const tplBase = job.templateName.replace(/\.[^.]+$/, "");
        zip.file(`${job.designName}/${job.designName}__${tplBase}.${ext}`, blob);
      } catch (e) {
        console.warn("ZIP skip", job.id, e);
      }
    }
    const out = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(out);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mockups_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const stats = {
    total: jobs.length,
    done: jobs.filter(j => j.status === "done").length,
    failed: jobs.filter(j => j.status === "failed").length,
    rendering: jobs.filter(j => j.status === "rendering").length,
  };

  return (
    <div className="max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Mockup erstellen</h1>
          <p className="text-sm text-slate-500 mt-1">
            Designs hochladen, gegen Deine Mockup-Listen rendern, als ZIP herunterladen. Nichts geht zu Printify oder Shopify.
          </p>
        </div>
        <div className="flex gap-2">
          {running ? (
            <button onClick={stop} className="px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 text-white cursor-pointer flex items-center gap-2">
              <Square className="w-4 h-4" /> Stoppen
            </button>
          ) : (
            <button
              onClick={runAll}
              disabled={designs.length === 0}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:bg-slate-300 cursor-pointer flex items-center gap-2"
            >
              <Play className="w-4 h-4" /> Rendern
            </button>
          )}
          {stats.done > 0 && (
            <button onClick={downloadAll} className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white cursor-pointer flex items-center gap-2">
              <Download className="w-4 h-4" /> ZIP ({stats.done})
            </button>
          )}
          {jobs.length > 0 && !running && (
            <button onClick={clearJobs} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Designs upload */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Designs ({designs.length})</h2>
          <div
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center cursor-pointer bg-white hover:border-slate-400"
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
            <Upload className="w-6 h-6 mx-auto mb-2 text-slate-400" />
            <p className="text-sm font-semibold text-slate-700">Designs hier ziehen oder klicken</p>
            <p className="text-xs text-slate-500 mt-1">PNG / JPG / WebP</p>
          </div>
          {designs.length > 0 && (
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
              {designs.map(d => (
                <div key={d.id} className="relative group">
                  <img src={d.previewUrl} alt="" className="w-full aspect-square object-cover rounded-lg bg-slate-100" />
                  <span className="absolute top-1 left-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-900/80 text-white uppercase">
                    {d.orientation === "vertical" ? "Hoch" : "Quer"}
                  </span>
                  <button
                    onClick={() => removeDesign(d.id)}
                    className="absolute top-1 right-1 p-1 rounded bg-rose-600 text-white opacity-0 group-hover:opacity-100 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Scope settings */}
        <div className="space-y-3">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Mockup-Auswahl</h2>
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Welche Listen rendern?
              </span>
              <select className="input" value={scope} onChange={e => setScope(e.target.value as ScopeFilter)}>
                <option value="auto">Auto (passend zur Bild-Orientation)</option>
                <option value="vertical">Nur Vertikal ({lists.vertical.length})</option>
                <option value="horizontal">Nur Horizontal ({lists.horizontal.length})</option>
                <option value="both">Beide Listen rendern</option>
              </select>
            </label>
            <div className="text-xs text-slate-600 leading-relaxed border-t border-slate-100 pt-3">
              <p className="font-semibold text-slate-800 mb-1">Listen-Größen</p>
              <p>Vertikal: <span className="font-mono">{lists.vertical.length}</span> Items</p>
              <p>Horizontal: <span className="font-mono">{lists.horizontal.length}</span> Items</p>
            </div>
            {jobs.length > 0 && (
              <div className="text-xs text-slate-600 border-t border-slate-100 pt-3 font-mono">
                <p>Gesamt: {stats.total}</p>
                <p className="text-emerald-700">✓ Fertig: {stats.done}</p>
                {stats.rendering > 0 && <p className="text-indigo-700">… Aktiv: {stats.rendering}</p>}
                {stats.failed > 0 && <p className="text-rose-700">✗ Fehler: {stats.failed}</p>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Jobs */}
      {jobs.length > 0 && (
        <div>
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Ergebnisse</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {jobs.map(j => (
              <JobTile key={j.id} job={j} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function JobTile({ job }: { job: Job }) {
  const src = job.blobUrl ?? job.staticSrc;
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="aspect-square bg-slate-100 grid place-items-center relative">
        {src && job.status === "done" ? (
          <img src={src} alt={job.templateName} className="w-full h-full object-cover" />
        ) : job.status === "rendering" ? (
          <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
        ) : job.status === "failed" ? (
          <AlertCircle className="w-6 h-6 text-rose-500" />
        ) : (
          <ImageIcon className="w-6 h-6 text-slate-300" />
        )}
        {job.status === "done" && <CheckCircle2 className="absolute top-1 right-1 w-4 h-4 text-emerald-600 bg-white rounded-full" />}
      </div>
      <div className="p-2">
        <p className="text-[10px] font-mono text-slate-500 truncate">{job.designName}</p>
        <p className="text-xs font-semibold text-slate-800 truncate" title={job.templateName}>
          {job.templateName}
        </p>
        {job.error && <p className="text-[10px] text-rose-600 truncate" title={job.error}>{job.error}</p>}
      </div>
    </div>
  );
}
