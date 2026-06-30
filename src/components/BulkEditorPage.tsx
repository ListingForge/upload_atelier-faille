import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, RefreshCw, Search, X, Check, AlertCircle, Pencil, Image as ImageIcon,
  Type, FileText, Tag, DollarSign, Power, Trash2, Plus, Upload, ArrowLeft,
} from "lucide-react";

interface Variant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
}
interface ProductImage { id: string; url: string; altText: string | null }
interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  vendor: string;
  productType: string;
  tags: string[];
  descriptionHtml: string;
  seo: { title: string | null; description: string | null };
  totalInventory: number;
  featuredImage: { url: string; altText: string | null } | null;
  images: { edges: { node: ProductImage }[] };
  variants: { edges: { node: Variant }[] };
}

interface ImageChange {
  action: "add" | "delete";
  imageId?: string;        // for delete
  file?: File;             // for add
  previewUrl?: string;     // for add
}

interface PendingEdit {
  title?: string;
  descriptionHtml?: string;
  tags?: string[];
  status?: ProductNode["status"];
  variantPrices?: Record<string, string>;
  imageChanges?: ImageChange[];
}

type Section = "title" | "description" | "tags" | "price" | "status" | "images";

const SECTION_META: Record<Section, { label: string; icon: any }> = {
  title:       { label: "Titel",        icon: Type },
  description: { label: "Beschreibung", icon: FileText },
  tags:        { label: "Tags",         icon: Tag },
  price:       { label: "Preis",        icon: DollarSign },
  status:      { label: "Status",       icon: Power },
  images:      { label: "Bilder",       icon: ImageIcon },
};

const MAX_IMAGE_EDGE = 2000;

export default function BulkEditorPage() {
  const [products, setProducts] = useState<ProductNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, hasMore: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Record<string, PendingEdit>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ current: 0, total: 0 });
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSection, setModalSection] = useState<Section>("title");
  const stopSaveRef = useRef(false);
  const autoLoadedRef = useRef(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadProgress({ loaded: 0, hasMore: false });
    try {
      let cursor: string | null = null;
      const all: ProductNode[] = [];
      do {
        const url = `/api/sh/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        const data: any = await r.json();
        const nodes: ProductNode[] = data.edges.map((e: any) => e.node);
        all.push(...nodes);
        setProducts([...all]);
        setLoadProgress({ loaded: all.length, hasMore: data.pageInfo.hasNextPage });
        cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
      } while (cursor);
    } catch (e: any) {
      alert("Laden fehlgeschlagen: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    loadAll();
  }, [loadAll]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.vendor.toLowerCase().includes(q) ||
      p.productType.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [products, search]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const selectAll = () => setSelected(new Set(filtered.map(p => p.id)));
  const deselectAll = () => setSelected(new Set());

  const selectedProducts = useMemo(
    () => products.filter(p => selected.has(p.id)),
    [products, selected]
  );

  const dirtyIds = useMemo(() => Object.keys(pending).filter(k => {
    const p = pending[k];
    return Object.keys(p).length > 0;
  }), [pending]);

  const setEdit = (ids: string[], patcher: (current: PendingEdit, prod: ProductNode) => PendingEdit) => {
    setPending(prev => {
      const next = { ...prev };
      for (const id of ids) {
        const prod = products.find(p => p.id === id);
        if (!prod) continue;
        next[id] = patcher(prev[id] || {}, prod);
      }
      return next;
    });
  };

  const clearAllEdits = () => {
    setPending({});
    setSaveStatus({});
    setSaveErrors({});
  };

  const saveAll = async () => {
    if (dirtyIds.length === 0) return;
    setIsSaving(true);
    stopSaveRef.current = false;
    setSaveProgress({ current: 0, total: dirtyIds.length });
    for (let i = 0; i < dirtyIds.length; i++) {
      if (stopSaveRef.current) break;
      const id = dirtyIds[i];
      const patch = pending[id];
      setSaveStatus(prev => ({ ...prev, [id]: "saving" }));
      try {
        // Product-level fields
        const productBody: any = {};
        if (patch.title !== undefined) productBody.title = patch.title;
        if (patch.descriptionHtml !== undefined) productBody.descriptionHtml = patch.descriptionHtml;
        if (patch.tags !== undefined) productBody.tags = patch.tags;
        if (patch.status !== undefined) productBody.status = patch.status;
        if (Object.keys(productBody).length > 0) {
          const r = await fetch(`/api/sh/products/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(productBody),
          });
          if (!r.ok) throw new Error(await r.text());
        }
        // Variant prices
        if (patch.variantPrices) {
          for (const [vid, price] of Object.entries(patch.variantPrices)) {
            const r = await fetch(`/api/sh/variants/${encodeURIComponent(vid)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ price }),
            });
            if (!r.ok) throw new Error(`Variante ${vid}: ${await r.text()}`);
          }
        }
        // Image changes: do deletes first, then adds. Track new images so we can mirror.
        const newImages: ProductImage[] = [];
        const deletedImageIds = new Set<string>();
        if (patch.imageChanges) {
          for (const ch of patch.imageChanges) {
            if (ch.action === "delete" && ch.imageId) {
              const r = await fetch(`/api/sh/products/${encodeURIComponent(id)}/images/${encodeURIComponent(ch.imageId)}`, {
                method: "DELETE",
                credentials: "include",
              });
              if (!r.ok) throw new Error(`Bild löschen: ${await r.text()}`);
              deletedImageIds.add(ch.imageId);
            } else if (ch.action === "add" && ch.file) {
              const downscaled = await downscaleImageFile(ch.file, MAX_IMAGE_EDGE);
              const dataUrl = await fileToDataUrl(downscaled);
              const r = await fetch(`/api/sh/products/${encodeURIComponent(id)}/images`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ dataUrl, filename: ch.file.name }),
              });
              if (!r.ok) throw new Error(`Bild hochladen: ${await r.text()}`);
              const created: any = await r.json();
              const first = Array.isArray(created) ? created[0] : created;
              const url = first?.image?.url || ch.previewUrl;
              const newId = first?.id || `tmp-${Date.now()}-${Math.random()}`;
              newImages.push({ id: newId, url, altText: null });
            }
          }
        }
        // Mirror to local product list
        setProducts(prev => prev.map(p => {
          if (p.id !== id) return p;
          const next: ProductNode = { ...p };
          if (patch.title !== undefined) next.title = patch.title;
          if (patch.descriptionHtml !== undefined) next.descriptionHtml = patch.descriptionHtml;
          if (patch.tags !== undefined) next.tags = patch.tags;
          if (patch.status !== undefined) next.status = patch.status;
          if (patch.variantPrices) {
            next.variants = {
              edges: p.variants.edges.map(({ node }) => ({
                node: patch.variantPrices![node.id] !== undefined
                  ? { ...node, price: patch.variantPrices![node.id] }
                  : node,
              })),
            };
          }
          if (deletedImageIds.size > 0 || newImages.length > 0) {
            const kept = p.images.edges.filter(({ node }) => !deletedImageIds.has(node.id));
            next.images = {
              edges: [
                ...kept,
                ...newImages.map(img => ({ node: img })),
              ],
            };
            if (next.featuredImage && deletedImageIds.has(p.featuredImage?.url || "")) {
              next.featuredImage = next.images.edges[0]?.node
                ? { url: next.images.edges[0].node.url, altText: next.images.edges[0].node.altText }
                : null;
            }
          }
          return next;
        }));
        setSaveStatus(prev => ({ ...prev, [id]: "saved" }));
        setPending(prev => {
          const n = { ...prev };
          delete n[id];
          return n;
        });
      } catch (e: any) {
        setSaveStatus(prev => ({ ...prev, [id]: "error" }));
        setSaveErrors(prev => ({ ...prev, [id]: e.message }));
      }
      setSaveProgress({ current: i + 1, total: dirtyIds.length });
    }
    setIsSaving(false);
  };

  return (
    <div className="max-w-7xl pb-32">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shopify Bulk Editor</h1>
          <p className="text-sm text-slate-500 mt-1">
            {products.length} Produkte geladen
            {loadProgress.hasMore && loading ? " (lade weiter…)" : ""}
            {selected.size > 0 ? ` · ${selected.size} ausgewählt` : ""}
          </p>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Neu laden
        </button>
      </div>

      {/* Search + actions */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Suchen (Titel, Vendor, Typ, Tag)…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <button
          onClick={selectAll}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 cursor-pointer"
        >
          {filtered.length === products.length ? "Alle" : `${filtered.length} sichtbar`} auswählen
        </button>
        {selected.size > 0 && (
          <>
            <button
              onClick={deselectAll}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Auswahl löschen
            </button>
            <button
              onClick={() => setModalOpen(true)}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer flex items-center gap-1.5"
            >
              <Pencil className="w-3.5 h-3.5" /> {selected.size} bearbeiten
            </button>
          </>
        )}
      </div>

      {/* Loading state */}
      {loading && products.length === 0 && (
        <div className="text-center py-12 text-slate-400 text-sm">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Lade Shopify…
        </div>
      )}

      {/* Product grid */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2 w-10"></th>
              <th className="px-3 py-2 w-16"></th>
              <th className="px-3 py-2">Titel</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Tags</th>
              <th className="px-3 py-2">Varianten</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const isSel = selected.has(p.id);
              const edit = pending[p.id];
              const dirty = edit && Object.keys(edit).length > 0;
              const status = saveStatus[p.id];
              const newTitle = edit?.title ?? p.title;
              const newTags = edit?.tags ?? p.tags;
              const newStatus = edit?.status ?? p.status;
              return (
                <tr
                  key={p.id}
                  className={`border-t border-slate-100 hover:bg-slate-50 ${isSel ? "bg-indigo-50/50" : ""} ${dirty ? "border-l-2 border-l-yellow-400" : ""}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggleSelect(p.id)}
                      className="w-4 h-4 cursor-pointer accent-indigo-600"
                    />
                  </td>
                  <td className="px-3 py-2">
                    {p.featuredImage?.url ? (
                      <img src={p.featuredImage.url} className="w-10 h-10 object-cover rounded" alt="" />
                    ) : (
                      <div className="w-10 h-10 bg-slate-100 rounded" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900 truncate max-w-[420px]">{newTitle}</div>
                    {dirty && edit.title !== undefined && edit.title !== p.title && (
                      <div className="text-[10px] text-slate-400 line-through truncate max-w-[420px]">{p.title}</div>
                    )}
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={newStatus} /></td>
                  <td className="px-3 py-2 max-w-[200px]">
                    <div className="text-xs text-slate-500 truncate">{newTags.join(", ") || "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {p.variants.edges.length} Var
                    {edit?.variantPrices && <span className="ml-2 text-yellow-700">+ Preise</span>}
                    {edit?.imageChanges?.length ? <span className="ml-2 text-yellow-700">+ Bilder</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {status === "saving" && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                    {status === "saved" && <Check className="w-4 h-4 text-green-600" />}
                    {status === "error" && (
                      <span title={saveErrors[p.id]}><AlertCircle className="w-4 h-4 text-red-600" /></span>
                    )}
                    {!status && dirty && <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && !loading && (
        <div className="text-center py-12 text-slate-400 text-sm">Keine Produkte gefunden.</div>
      )}

      {/* Save bar */}
      {dirtyIds.length > 0 && (
        <div className="fixed bottom-4 left-4 right-4 lg:left-72 z-40">
          <div className="bg-white border border-yellow-300 rounded-xl shadow-2xl p-3 flex items-center gap-4">
            <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></div>
            <div className="flex-1 text-sm font-semibold text-slate-700">
              {isSaving
                ? `Speichere ${saveProgress.current}/${saveProgress.total}…`
                : `${dirtyIds.length} Produkt${dirtyIds.length === 1 ? "" : "e"} geändert`}
            </div>
            {isSaving && (
              <div className="hidden md:block flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${(saveProgress.current / Math.max(1, saveProgress.total)) * 100}%` }} />
              </div>
            )}
            {isSaving ? (
              <button
                onClick={() => { stopSaveRef.current = true; }}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-100 text-red-700 hover:bg-red-200 cursor-pointer"
              >
                Stopp
              </button>
            ) : (
              <>
                <button onClick={clearAllEdits} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer">
                  Verwerfen
                </button>
                <button onClick={saveAll} className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer">
                  Speichern
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Edit modal */}
      {modalOpen && (
        <BulkEditModal
          selectedProducts={selectedProducts}
          pending={pending}
          setEdit={setEdit}
          section={modalSection}
          setSection={setModalSection}
          dirtyIds={dirtyIds}
          isSaving={isSaving}
          saveProgress={saveProgress}
          onSave={saveAll}
          onStop={() => { stopSaveRef.current = true; }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ProductNode["status"] }) {
  const colors = {
    ACTIVE: "bg-green-100 text-green-700",
    DRAFT: "bg-slate-100 text-slate-600",
    ARCHIVED: "bg-amber-100 text-amber-700",
  } as const;
  return <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${colors[status]}`}>{status}</span>;
}

// ---------- Modal ----------

interface ModalProps {
  selectedProducts: ProductNode[];
  pending: Record<string, PendingEdit>;
  setEdit: (ids: string[], patcher: (current: PendingEdit, prod: ProductNode) => PendingEdit) => void;
  section: Section;
  setSection: (s: Section) => void;
  dirtyIds: string[];
  isSaving: boolean;
  saveProgress: { current: number; total: number };
  onSave: () => void;
  onStop: () => void;
  onClose: () => void;
}

function BulkEditModal(p: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [p]);

  const sectionDirtyCounts = useMemo(() => {
    const counts: Record<Section, number> = {
      title: 0, description: 0, tags: 0, price: 0, status: 0, images: 0,
    };
    for (const prod of p.selectedProducts) {
      const e = p.pending[prod.id];
      if (!e) continue;
      if (e.title !== undefined) counts.title++;
      if (e.descriptionHtml !== undefined) counts.description++;
      if (e.tags !== undefined) counts.tags++;
      if (e.variantPrices) counts.price++;
      if (e.status !== undefined) counts.status++;
      if (e.imageChanges?.length) counts.images++;
    }
    return counts;
  }, [p.pending, p.selectedProducts]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50">
      {/* Header */}
      <header className="shrink-0 bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={p.onClose}
            className="text-slate-500 hover:text-slate-900 text-sm font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" /> Zurück
          </button>
          <div className="w-px h-5 bg-slate-200" />
          <h1 className="text-base font-bold text-slate-900 truncate">
            Bulk Editor · {p.selectedProducts.length} Produkt{p.selectedProducts.length === 1 ? "" : "e"}
          </h1>
        </div>
        <button onClick={p.onClose} className="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center cursor-pointer">
          <X className="w-4 h-4 text-slate-600" />
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 bg-white border-r border-slate-200 p-3 overflow-y-auto">
          {(Object.keys(SECTION_META) as Section[]).map(s => {
            const meta = SECTION_META[s];
            const Icon = meta.icon;
            const active = p.section === s;
            const dirty = sectionDirtyCounts[s];
            return (
              <button
                key={s}
                onClick={() => p.setSection(s)}
                className={`w-full px-3 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-3 text-left cursor-pointer mb-1 ${
                  active ? "bg-indigo-600 text-white" : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="flex-1">{meta.label}</span>
                {dirty > 0 && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${active ? "bg-white/20" : "bg-yellow-100 text-yellow-700"}`}>
                    {dirty}
                  </span>
                )}
              </button>
            );
          })}
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-6 pb-32">
            {p.section === "title" && <TitleSection {...p} />}
            {p.section === "description" && <DescriptionSection {...p} />}
            {p.section === "tags" && <TagSection {...p} />}
            {p.section === "price" && <PriceSection {...p} />}
            {p.section === "status" && <StatusSection {...p} />}
            {p.section === "images" && <ImagesSection {...p} />}
          </div>
        </main>
      </div>

      {/* Footer save bar */}
      {p.dirtyIds.length > 0 && (
        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 sm:px-6 py-3 flex items-center gap-4">
          <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
          <div className="text-sm font-semibold text-slate-700">
            {p.isSaving ? `Speichere ${p.saveProgress.current}/${p.saveProgress.total}…` : `${p.dirtyIds.length} Produkt${p.dirtyIds.length === 1 ? "" : "e"} geändert`}
          </div>
          {p.isSaving && (
            <div className="flex-1 max-w-md h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 transition-all" style={{ width: `${(p.saveProgress.current / Math.max(1, p.saveProgress.total)) * 100}%` }} />
            </div>
          )}
          <div className="ml-auto flex gap-2">
            {p.isSaving ? (
              <button onClick={p.onStop} className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-100 text-red-700 hover:bg-red-200 cursor-pointer">
                Stopp
              </button>
            ) : (
              <button onClick={p.onSave} className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer">
                Speichern
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

// ---------- Sections (modal) ----------

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold text-slate-900">{title}</h2>
      {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function PerProductRow({ children }: { children: React.ReactNode }) {
  return <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3">{children}</div>;
}

function TitleSection({ selectedProducts, pending, setEdit }: ModalProps) {
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [findStr, setFindStr] = useState("");
  const [replaceStr, setReplaceStr] = useState("");
  const ids = selectedProducts.map(p => p.id);
  const apply = (fn: (current: string) => string) => setEdit(ids, (cur, prod) => ({ ...cur, title: fn(cur.title ?? prod.title) }));
  return (
    <div className="space-y-6">
      <SectionHeader title="Titel" hint="Bulk-Operationen oben anwenden, dann unten pro Produkt feinjustieren." />
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex gap-2">
          <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="Präfix…" value={prefix} onChange={e => setPrefix(e.target.value)} />
          <button disabled={!prefix} onClick={() => apply(t => prefix + t)} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Voranstellen</button>
        </div>
        <div className="flex gap-2">
          <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="Suffix…" value={suffix} onChange={e => setSuffix(e.target.value)} />
          <button disabled={!suffix} onClick={() => apply(t => t + suffix)} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Anhängen</button>
        </div>
        <div className="flex gap-2">
          <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="Suchen…" value={findStr} onChange={e => setFindStr(e.target.value)} />
          <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="Ersetzen mit…" value={replaceStr} onChange={e => setReplaceStr(e.target.value)} />
          <button disabled={!findStr} onClick={() => apply(t => t.split(findStr).join(replaceStr))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap">Ersetzen</button>
        </div>
      </div>
      <div className="space-y-2">
        {selectedProducts.map(prod => {
          const cur = pending[prod.id]?.title ?? prod.title;
          const dirty = cur !== prod.title;
          return (
            <PerProductRow key={prod.id}>
              {prod.featuredImage?.url ? <img src={prod.featuredImage.url} className="w-10 h-10 object-cover rounded shrink-0" alt="" /> : <div className="w-10 h-10 bg-slate-100 rounded shrink-0" />}
              <input
                value={cur}
                onChange={e => setEdit([prod.id], c => ({ ...c, title: e.target.value }))}
                className={`flex-1 px-3 py-2 border rounded-lg text-sm ${dirty ? "border-yellow-400 bg-yellow-50" : "border-slate-200"}`}
              />
            </PerProductRow>
          );
        })}
      </div>
    </div>
  );
}

function DescriptionSection({ selectedProducts, pending, setEdit }: ModalProps) {
  const [content, setContent] = useState("");
  const ids = selectedProducts.map(p => p.id);
  return (
    <div className="space-y-6">
      <SectionHeader title="Beschreibung (HTML)" />
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <textarea className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono min-h-[140px]" placeholder="HTML/Text…" value={content} onChange={e => setContent(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button disabled={!content} onClick={() => setEdit(ids, c => ({ ...c, descriptionHtml: content }))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Komplett ersetzen</button>
          <button disabled={!content} onClick={() => setEdit(ids, (c, prod) => ({ ...c, descriptionHtml: content + (c.descriptionHtml ?? prod.descriptionHtml ?? "") }))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">Voranstellen</button>
          <button disabled={!content} onClick={() => setEdit(ids, (c, prod) => ({ ...c, descriptionHtml: (c.descriptionHtml ?? prod.descriptionHtml ?? "") + content }))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">Anhängen</button>
          <button onClick={() => setEdit(ids, c => ({ ...c, descriptionHtml: "" }))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100 cursor-pointer ml-auto">Leeren</button>
        </div>
      </div>
      <div className="space-y-3">
        {selectedProducts.map(prod => {
          const cur = pending[prod.id]?.descriptionHtml ?? prod.descriptionHtml ?? "";
          const dirty = cur !== (prod.descriptionHtml ?? "");
          return (
            <div key={prod.id} className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs font-semibold text-slate-600 mb-2 truncate">{prod.title}</div>
              <textarea
                value={cur}
                onChange={e => setEdit([prod.id], c => ({ ...c, descriptionHtml: e.target.value }))}
                className={`w-full px-3 py-2 border rounded-lg text-xs font-mono min-h-[100px] ${dirty ? "border-yellow-400 bg-yellow-50" : "border-slate-200"}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TagSection({ selectedProducts, pending, setEdit }: ModalProps) {
  const [addStr, setAddStr] = useState("");
  const [removeStr, setRemoveStr] = useState("");
  const ids = selectedProducts.map(p => p.id);
  const parse = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
  return (
    <div className="space-y-6">
      <SectionHeader title="Tags" hint="Komma-getrennt." />
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex gap-2">
          <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="Tags hinzufügen…" value={addStr} onChange={e => setAddStr(e.target.value)} />
          <button disabled={!addStr} onClick={() => {
            const t = parse(addStr);
            setEdit(ids, (c, prod) => {
              const s = new Set(c.tags ?? prod.tags);
              t.forEach(x => s.add(x));
              return { ...c, tags: Array.from(s) };
            });
          }} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Hinzufügen</button>
          <button disabled={!addStr} onClick={() => {
            const t = parse(addStr);
            setEdit(ids, c => ({ ...c, tags: t }));
          }} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">Alle ersetzen</button>
        </div>
        <div className="flex gap-2">
          <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="Tags entfernen…" value={removeStr} onChange={e => setRemoveStr(e.target.value)} />
          <button disabled={!removeStr} onClick={() => {
            const t = new Set(parse(removeStr));
            setEdit(ids, (c, prod) => ({ ...c, tags: (c.tags ?? prod.tags).filter(x => !t.has(x)) }));
          }} className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 cursor-pointer">Entfernen</button>
        </div>
      </div>
      <div className="space-y-2">
        {selectedProducts.map(prod => {
          const cur = pending[prod.id]?.tags ?? prod.tags;
          const dirty = pending[prod.id]?.tags !== undefined;
          return (
            <PerProductRow key={prod.id}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-slate-700 truncate mb-1">{prod.title}</div>
                <div className="flex flex-wrap gap-1">
                  {cur.length === 0 && <span className="text-xs text-slate-400 italic">keine</span>}
                  {cur.map(t => (
                    <span key={t} className={`text-[10px] font-semibold px-2 py-0.5 rounded ${dirty ? "bg-yellow-100 text-yellow-800" : "bg-slate-100 text-slate-600"}`}>
                      {t}
                      <button
                        onClick={() => setEdit([prod.id], c => ({ ...c, tags: (c.tags ?? prod.tags).filter(x => x !== t) }))}
                        className="ml-1 text-slate-400 hover:text-red-600 cursor-pointer"
                      >×</button>
                    </span>
                  ))}
                </div>
              </div>
            </PerProductRow>
          );
        })}
      </div>
    </div>
  );
}

function PriceSection({ selectedProducts, pending, setEdit }: ModalProps) {
  const [percent, setPercent] = useState("");
  const [absolute, setAbsolute] = useState("");
  const [setPriceVal, setSetPriceVal] = useState("");
  const ids = selectedProducts.map(p => p.id);
  const applyToVariants = (transform: (current: number) => number) => {
    setEdit(ids, (cur, prod) => {
      const next: Record<string, string> = { ...(cur.variantPrices ?? {}) };
      for (const { node: v } of prod.variants.edges) {
        const base = parseFloat(next[v.id] ?? v.price);
        if (!isFinite(base)) continue;
        next[v.id] = transform(base).toFixed(2);
      }
      return { ...cur, variantPrices: next };
    });
  };
  return (
    <div className="space-y-6">
      <SectionHeader title="Preis" hint="Operationen wirken auf alle Varianten." />
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex gap-2 items-center">
          <input type="number" step="0.01" className="w-28 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="z.B. 10" value={percent} onChange={e => setPercent(e.target.value)} />
          <span className="text-sm text-slate-500">%</span>
          <button disabled={!percent} onClick={() => applyToVariants(p => p * (1 + parseFloat(percent) / 100))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Anheben</button>
          <button disabled={!percent} onClick={() => applyToVariants(p => p * (1 - parseFloat(percent) / 100))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">Senken</button>
        </div>
        <div className="flex gap-2 items-center">
          <input type="number" step="0.01" className="w-28 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="z.B. 5.00" value={absolute} onChange={e => setAbsolute(e.target.value)} />
          <span className="text-sm text-slate-500">absolut</span>
          <button disabled={!absolute} onClick={() => applyToVariants(p => p + parseFloat(absolute))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Hinzufügen</button>
          <button disabled={!absolute} onClick={() => applyToVariants(p => Math.max(0, p - parseFloat(absolute)))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">Abziehen</button>
        </div>
        <div className="flex gap-2 items-center">
          <input type="number" step="0.01" className="w-28 px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="z.B. 49.99" value={setPriceVal} onChange={e => setSetPriceVal(e.target.value)} />
          <span className="text-sm text-slate-500">setze alle auf</span>
          <button disabled={!setPriceVal} onClick={() => applyToVariants(() => parseFloat(setPriceVal))} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">Anwenden</button>
        </div>
      </div>
      <div className="space-y-3">
        {selectedProducts.map(prod => (
          <div key={prod.id} className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-xs font-semibold text-slate-700 truncate mb-2">{prod.title}</div>
            <table className="w-full text-xs">
              <tbody>
                {prod.variants.edges.map(({ node: v }) => {
                  const newP = pending[prod.id]?.variantPrices?.[v.id];
                  const cur = newP ?? v.price;
                  const dirty = newP !== undefined && newP !== v.price;
                  return (
                    <tr key={v.id} className="border-t border-slate-50">
                      <td className="py-2 pr-3 text-slate-700">{v.title}</td>
                      <td className="py-2 pr-3 w-32">
                        <input
                          value={cur}
                          onChange={e => setEdit([prod.id], c => ({ ...c, variantPrices: { ...(c.variantPrices ?? {}), [v.id]: e.target.value } }))}
                          className={`w-full px-2 py-1 border rounded text-xs ${dirty ? "border-yellow-400 bg-yellow-50" : "border-slate-200"}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusSection({ selectedProducts, pending, setEdit }: ModalProps) {
  const ids = selectedProducts.map(p => p.id);
  return (
    <div className="space-y-6">
      <SectionHeader title="Status" />
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex gap-2">
        <button onClick={() => setEdit(ids, c => ({ ...c, status: "ACTIVE" }))} className="px-4 py-2 rounded-lg text-xs font-semibold bg-green-100 text-green-700 hover:bg-green-200 cursor-pointer">Alle auf Aktiv</button>
        <button onClick={() => setEdit(ids, c => ({ ...c, status: "DRAFT" }))} className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer">Alle auf Entwurf</button>
        <button onClick={() => setEdit(ids, c => ({ ...c, status: "ARCHIVED" }))} className="px-4 py-2 rounded-lg text-xs font-semibold bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer">Alle archivieren</button>
      </div>
      <div className="space-y-2">
        {selectedProducts.map(prod => {
          const cur = pending[prod.id]?.status ?? prod.status;
          return (
            <PerProductRow key={prod.id}>
              <div className="flex-1 truncate text-sm font-medium text-slate-700">{prod.title}</div>
              <select
                value={cur}
                onChange={e => setEdit([prod.id], c => ({ ...c, status: e.target.value as ProductNode["status"] }))}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold bg-white"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="DRAFT">DRAFT</option>
                <option value="ARCHIVED">ARCHIVED</option>
              </select>
            </PerProductRow>
          );
        })}
      </div>
    </div>
  );
}

function ImagesSection({ selectedProducts, pending, setEdit }: ModalProps) {
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkPreview, setBulkPreview] = useState<string | null>(null);
  const bulkInputRef = useRef<HTMLInputElement>(null);
  const perProductInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => () => { if (bulkPreview) URL.revokeObjectURL(bulkPreview); }, [bulkPreview]);

  const ids = selectedProducts.map(p => p.id);

  const addToAll = () => {
    if (!bulkFile) return;
    setEdit(ids, cur => ({
      ...cur,
      imageChanges: [...(cur.imageChanges ?? []), { action: "add", file: bulkFile, previewUrl: bulkPreview ?? undefined }],
    }));
  };

  const removeAllFromAll = () => {
    if (!confirm(`Wirklich ALLE Bilder von ${selectedProducts.length} Produkten löschen? (Bleibt nur das letzte falls Shopify-Pflicht)`)) return;
    setEdit(ids, (cur, prod) => ({
      ...cur,
      imageChanges: [
        ...(cur.imageChanges ?? []),
        ...prod.images.edges.map(({ node }) => ({ action: "delete" as const, imageId: node.id })),
      ],
    }));
  };

  const addToProduct = (productId: string, file: File) => {
    const preview = URL.createObjectURL(file);
    setEdit([productId], cur => ({
      ...cur,
      imageChanges: [...(cur.imageChanges ?? []), { action: "add", file, previewUrl: preview }],
    }));
  };

  const removeFromProduct = (productId: string, imageId: string) => {
    setEdit([productId], cur => ({
      ...cur,
      imageChanges: [...(cur.imageChanges ?? []), { action: "delete", imageId }],
    }));
  };

  const undoPendingImageChange = (productId: string, idx: number) => {
    setEdit([productId], cur => {
      const ch = [...(cur.imageChanges ?? [])];
      ch.splice(idx, 1);
      return { ...cur, imageChanges: ch.length ? ch : undefined };
    });
  };

  return (
    <div className="space-y-6">
      <SectionHeader title="Bilder" hint="Bulk-Aktion oben (allen hinzufügen / alle entfernen), oder pro Produkt feinjustieren." />

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-3">Bulk-Aktion</div>
        <div className="flex items-start gap-4">
          <div
            onClick={() => bulkInputRef.current?.click()}
            className="w-32 h-32 border-2 border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-slate-400 hover:bg-slate-50 shrink-0 relative overflow-hidden"
          >
            {bulkPreview ? (
              <img src={bulkPreview} className="w-full h-full object-cover" alt="" />
            ) : (
              <>
                <Upload className="w-6 h-6 text-slate-400 mb-1" />
                <span className="text-[10px] text-slate-500 font-semibold">Bild wählen</span>
              </>
            )}
            <input
              ref={bulkInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) {
                  if (bulkPreview) URL.revokeObjectURL(bulkPreview);
                  setBulkFile(f);
                  setBulkPreview(URL.createObjectURL(f));
                }
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex-1 space-y-2">
            <button
              disabled={!bulkFile}
              onClick={addToAll}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Bei allen Produkten hinzufügen
            </button>
            <button
              onClick={removeAllFromAll}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100 cursor-pointer flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" /> Bei allen alle Bilder entfernen
            </button>
            {bulkFile && (
              <p className="text-xs text-slate-500">
                {bulkFile.name} · {(bulkFile.size / 1024 / 1024).toFixed(1)} MB
                <button onClick={() => { if (bulkPreview) URL.revokeObjectURL(bulkPreview); setBulkFile(null); setBulkPreview(null); }} className="ml-2 text-slate-400 hover:text-red-600 cursor-pointer">×</button>
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {selectedProducts.map(prod => {
          const changes = pending[prod.id]?.imageChanges ?? [];
          const deletedIds = new Set(changes.filter(c => c.action === "delete").map(c => c.imageId));
          const existing = prod.images.edges.map(({ node }) => node).filter(img => !deletedIds.has(img.id));
          const pendingAdds = changes.filter(c => c.action === "add");
          return (
            <div key={prod.id} className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-slate-700 truncate">{prod.title}</div>
                <button
                  onClick={() => perProductInputRefs.current.get(prod.id)?.click()}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-500 cursor-pointer flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" /> Bild
                </button>
                <input
                  ref={el => { if (el) perProductInputRefs.current.set(prod.id, el); }}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) addToProduct(prod.id, f);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                {existing.map(img => (
                  <div key={img.id} className="relative aspect-square group">
                    <img src={img.url} className="w-full h-full object-cover rounded" alt={img.altText ?? ""} />
                    <button
                      onClick={() => removeFromProduct(prod.id, img.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                      title="Entfernen"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {pendingAdds.map((ch, idx) => (
                  <div key={`pending-${idx}`} className="relative aspect-square group border-2 border-yellow-400 rounded">
                    {ch.previewUrl
                      ? <img src={ch.previewUrl} className="w-full h-full object-cover rounded" alt="" />
                      : <div className="w-full h-full bg-yellow-50 rounded" />
                    }
                    <span className="absolute bottom-1 left-1 text-[9px] font-bold bg-yellow-500 text-white px-1 rounded">NEU</span>
                    <button
                      onClick={() => {
                        const allAdds = changes.map((c, i) => ({ c, i })).filter(x => x.c.action === "add");
                        const target = allAdds[idx];
                        if (target) undoPendingImageChange(prod.id, target.i);
                      }}
                      className="absolute top-1 right-1 w-5 h-5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {existing.length === 0 && pendingAdds.length === 0 && (
                  <div className="col-span-full text-xs text-slate-400 italic py-4 text-center">Keine Bilder</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Image helpers ----------

async function downscaleImageFile(file: File, maxEdge: number, quality = 0.9): Promise<File> {
  const bitmap = await createImageBitmap(file);
  if (bitmap.width <= maxEdge && bitmap.height <= maxEdge) {
    bitmap.close?.();
    return file;
  }
  const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as any).getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: "image/jpeg", quality })
    : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob(b => b ? resolve(b) : reject(new Error("toBlob failed")), "image/jpeg", quality));
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
