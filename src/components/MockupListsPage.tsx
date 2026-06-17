import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Upload, FileImage, Layers, GripVertical, Loader2 } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MockupItem, MockupLists, Orientation } from "../types";

export default function MockupListsPage() {
  const [lists, setLists] = useState<MockupLists>({ vertical: [], horizontal: [] });
  const [orientation, setOrientation] = useState<Orientation>("vertical");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/mockups", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: MockupLists = await r.json();
      setLists(data);
      setDirty(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const current: MockupItem[] = lists[orientation];

  const onUpload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of arr) fd.append("files", f);
      const r = await fetch(`/api/mockups/${orientation}`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      alert("Upload fehlgeschlagen: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Wirklich löschen?")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/mockups/${orientation}/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onSaveOrder = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/mockups/${orientation}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: current.map(i => i.id) }),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = current.findIndex(i => i.id === active.id);
    const newIndex = current.findIndex(i => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setLists(prev => ({ ...prev, [orientation]: arrayMove(prev[orientation], oldIndex, newIndex) }));
    setDirty(true);
  };

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Mockup-Listen</h1>
          <p className="text-sm text-slate-500 mt-1">
            PSDs und statische Mockups in der gewünschten Reihenfolge. Smart-Object-Layer in PSDs muss <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs">Smart Object</code> heißen.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onSaveOrder}
            disabled={!dirty || busy}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? "Speichert…" : dirty ? "Reihenfolge speichern" : "Gespeichert"}
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-6 bg-slate-100 p-1 rounded-xl w-fit">
        {(["vertical", "horizontal"] as Orientation[]).map(o => (
          <button
            key={o}
            onClick={() => setOrientation(o)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer ${
              orientation === o ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            {o === "vertical" ? "Vertikal" : "Horizontal"} · {lists[o].length}
          </button>
        ))}
      </div>

      <UploadDropZone busy={busy} orientation={orientation} onFiles={onUpload} />

      {loading ? (
        <div className="text-center py-12 text-slate-400 text-sm">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Lade…
        </div>
      ) : current.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm border-2 border-dashed border-slate-200 rounded-xl mt-6">
          Noch keine Mockups in der {orientation === "vertical" ? "vertikalen" : "horizontalen"} Liste.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={current.map(i => i.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 mt-6">
              {current.map((item, idx) => (
                <Tile
                  key={item.id}
                  item={item}
                  orientation={orientation}
                  position={idx + 1}
                  onDelete={() => onDelete(item.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function UploadDropZone({
  busy,
  orientation,
  onFiles,
}: {
  busy: boolean;
  orientation: Orientation;
  onFiles: (files: FileList | File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={e => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-xl p-6 cursor-pointer text-center transition-colors ${
        over ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-white hover:border-slate-400"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".psd,image/png,image/jpeg,image/webp,image/vnd.adobe.photoshop,application/x-photoshop"
        className="hidden"
        onChange={e => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <Upload className="w-6 h-6 mx-auto mb-2 text-slate-400" />
      <p className="text-sm font-semibold text-slate-700">
        PSD / JPG / PNG hierhin ziehen oder klicken
      </p>
      <p className="text-xs text-slate-500 mt-1">
        Ziel: {orientation === "vertical" ? "vertikale" : "horizontale"} Liste
        {busy && " · läuft…"}
      </p>
    </div>
  );
}

interface TileProps {
  item: MockupItem;
  orientation: Orientation;
  position: number;
  onDelete: () => void;
}

function Tile({ item, orientation, position, onDelete }: TileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isImage = item.kind === "image";
  const src = `/api/mockups/${orientation}/${item.id}/file`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm"
    >
      <div className="aspect-square bg-slate-100 grid place-items-center relative overflow-hidden">
        {isImage ? (
          <img src={src} alt={item.originalName} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="text-center text-slate-500">
            <Layers className="w-10 h-10 mx-auto mb-1" />
            <span className="text-[10px] font-mono uppercase tracking-wider">PSD Template</span>
          </div>
        )}
        <span className="absolute top-2 left-2 bg-slate-900/80 text-white text-[10px] font-mono px-1.5 py-0.5 rounded">
          #{position}
        </span>
        <span
          className={`absolute top-2 right-2 text-[10px] font-mono px-1.5 py-0.5 rounded ${
            item.kind === "psd" ? "bg-indigo-600 text-white" : "bg-emerald-600 text-white"
          }`}
        >
          {item.kind === "psd" ? "PSD" : "STATIC"}
        </span>
      </div>

      <div className="p-2 flex items-center gap-2">
        <button
          {...attributes}
          {...listeners}
          className="p-1 text-slate-400 hover:text-slate-700 cursor-grab active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          <GripVertical className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-800 truncate" title={item.originalName}>
            {item.originalName}
          </p>
          <p className="text-[10px] text-slate-400 font-mono">
            {item.kind === "image" ? <FileImage className="w-3 h-3 inline mr-1" /> : null}
            {(item.size / 1024).toFixed(0)} KB
          </p>
        </div>
        <button
          onClick={onDelete}
          className="p-1 text-slate-300 hover:text-red-600 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
