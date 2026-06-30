import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Search, X, Check, AlertCircle, ExternalLink } from "lucide-react";

interface Variant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
}
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
  images: { edges: { node: { id: string; url: string; altText: string | null } }[] };
  variants: { edges: { node: Variant }[] };
}

// Pending edits per product. When non-empty → product is "dirty".
interface PendingEdit {
  title?: string;
  descriptionHtml?: string;
  tags?: string[];
  status?: ProductNode["status"];
  // Variant price edits, keyed by variant id, value = new price as string.
  variantPrices?: Record<string, string>;
}

type Section = "title" | "description" | "tags" | "price" | "status";

export default function BulkEditorPage() {
  const [products, setProducts] = useState<ProductNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, hasMore: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Record<string, PendingEdit>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<Section>("title");
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ current: 0, total: 0 });
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

      {/* Search + select-all */}
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
          <button
            onClick={deselectAll}
            className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Auswahl löschen
          </button>
        )}
      </div>

      {/* Bulk operations panel */}
      {selected.size > 0 && (
        <div className="bg-white border border-indigo-200 rounded-xl p-4 mb-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            {(["title", "description", "tags", "price", "status"] as Section[]).map(s => (
              <button
                key={s}
                onClick={() => setSection(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                  section === s ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {SECTION_LABEL[s]}
              </button>
            ))}
            <div className="ml-auto text-xs text-slate-500">{selected.size} Produkte ausgewählt</div>
          </div>

          {section === "title" && <TitleOps selectedProducts={selectedProducts} pending={pending} setEdit={setEdit} />}
          {section === "description" && <DescriptionOps selectedProducts={selectedProducts} pending={pending} setEdit={setEdit} />}
          {section === "tags" && <TagOps selectedProducts={selectedProducts} pending={pending} setEdit={setEdit} />}
          {section === "price" && <PriceOps selectedProducts={selectedProducts} pending={pending} setEdit={setEdit} />}
          {section === "status" && <StatusOps selectedProducts={selectedProducts} pending={pending} setEdit={setEdit} />}
        </div>
      )}

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
                  <td className="px-3 py-2">
                    <StatusBadge status={newStatus} />
                  </td>
                  <td className="px-3 py-2 max-w-[200px]">
                    <div className="text-xs text-slate-500 truncate">{newTags.join(", ") || "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {p.variants.edges.length} Var
                    {edit?.variantPrices && (
                      <span className="ml-2 text-yellow-700">+ Preise</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {status === "saving" && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                    {status === "saved" && <Check className="w-4 h-4 text-green-600" />}
                    {status === "error" && (
                      <span title={saveErrors[p.id]}>
                        <AlertCircle className="w-4 h-4 text-red-600" />
                      </span>
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

      {/* Fixed save bar */}
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
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${(saveProgress.current / Math.max(1, saveProgress.total)) * 100}%` }}
                />
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
                <button
                  onClick={clearAllEdits}
                  className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer"
                >
                  Verwerfen
                </button>
                <button
                  onClick={saveAll}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer"
                >
                  Speichern
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SECTION_LABEL: Record<Section, string> = {
  title: "Titel",
  description: "Beschreibung",
  tags: "Tags",
  price: "Preis",
  status: "Status",
};

function StatusBadge({ status }: { status: ProductNode["status"] }) {
  const colors = {
    ACTIVE: "bg-green-100 text-green-700",
    DRAFT: "bg-slate-100 text-slate-600",
    ARCHIVED: "bg-amber-100 text-amber-700",
  } as const;
  return <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${colors[status]}`}>{status}</span>;
}

// ---------- Section components ----------

type OpsProps = {
  selectedProducts: ProductNode[];
  pending: Record<string, PendingEdit>;
  setEdit: (ids: string[], patcher: (current: PendingEdit, prod: ProductNode) => PendingEdit) => void;
};

function TitleOps({ selectedProducts, pending, setEdit }: OpsProps) {
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [findStr, setFindStr] = useState("");
  const [replaceStr, setReplaceStr] = useState("");
  const ids = selectedProducts.map(p => p.id);
  const apply = (fn: (current: string) => string) => {
    setEdit(ids, (cur, prod) => ({ ...cur, title: fn(cur.title ?? prod.title) }));
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="Präfix…"
          value={prefix}
          onChange={e => setPrefix(e.target.value)}
        />
        <button
          disabled={!prefix}
          onClick={() => apply(t => prefix + t)}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer"
        >
          Voranstellen
        </button>
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="Suffix…"
          value={suffix}
          onChange={e => setSuffix(e.target.value)}
        />
        <button
          disabled={!suffix}
          onClick={() => apply(t => t + suffix)}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer"
        >
          Anhängen
        </button>
      </div>
      <div className="flex gap-2 md:col-span-2">
        <input
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="Suchen…"
          value={findStr}
          onChange={e => setFindStr(e.target.value)}
        />
        <input
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="Ersetzen mit…"
          value={replaceStr}
          onChange={e => setReplaceStr(e.target.value)}
        />
        <button
          disabled={!findStr}
          onClick={() => apply(t => t.split(findStr).join(replaceStr))}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          Ersetzen
        </button>
      </div>
      {selectedProducts.length <= 5 && (
        <div className="md:col-span-2 text-xs text-slate-500 space-y-0.5">
          {selectedProducts.map(p => (
            <div key={p.id} className="truncate">
              <span className="text-slate-400">→</span> {pending[p.id]?.title ?? p.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DescriptionOps({ selectedProducts, pending, setEdit }: OpsProps) {
  const [content, setContent] = useState("");
  const ids = selectedProducts.map(p => p.id);
  const setAll = () => setEdit(ids, cur => ({ ...cur, descriptionHtml: content }));
  const prepend = () => setEdit(ids, (cur, prod) => ({ ...cur, descriptionHtml: content + (cur.descriptionHtml ?? prod.descriptionHtml ?? "") }));
  const append = () => setEdit(ids, (cur, prod) => ({ ...cur, descriptionHtml: (cur.descriptionHtml ?? prod.descriptionHtml ?? "") + content }));
  const clear = () => setEdit(ids, cur => ({ ...cur, descriptionHtml: "" }));
  return (
    <div className="space-y-3">
      <textarea
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono min-h-[140px]"
        placeholder="HTML-Beschreibung — kann auch reines Markdown/Text sein…"
        value={content}
        onChange={e => setContent(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button disabled={!content} onClick={setAll} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">
          Komplett ersetzen
        </button>
        <button disabled={!content} onClick={prepend} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">
          Voranstellen
        </button>
        <button disabled={!content} onClick={append} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">
          Anhängen
        </button>
        <button onClick={clear} className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100 cursor-pointer ml-auto">
          Beschreibung leeren
        </button>
      </div>
    </div>
  );
}

function TagOps({ selectedProducts, pending, setEdit }: OpsProps) {
  const [addStr, setAddStr] = useState("");
  const [removeStr, setRemoveStr] = useState("");
  const ids = selectedProducts.map(p => p.id);
  const parse = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
  const add = () => {
    const tags = parse(addStr);
    if (tags.length === 0) return;
    setEdit(ids, (cur, prod) => {
      const existing = new Set(cur.tags ?? prod.tags);
      tags.forEach(t => existing.add(t));
      return { ...cur, tags: Array.from(existing) };
    });
  };
  const remove = () => {
    const tags = new Set(parse(removeStr));
    if (tags.size === 0) return;
    setEdit(ids, (cur, prod) => ({
      ...cur,
      tags: (cur.tags ?? prod.tags).filter(t => !tags.has(t)),
    }));
  };
  const replace = () => {
    const tags = parse(addStr);
    setEdit(ids, cur => ({ ...cur, tags }));
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="Tags hinzufügen (Komma-getrennt)"
          value={addStr}
          onChange={e => setAddStr(e.target.value)}
        />
        <button disabled={!addStr} onClick={add} className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer">
          Hinzufügen
        </button>
        <button disabled={!addStr} onClick={replace} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer">
          Alle ersetzen
        </button>
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="Tags entfernen (Komma-getrennt)"
          value={removeStr}
          onChange={e => setRemoveStr(e.target.value)}
        />
        <button disabled={!removeStr} onClick={remove} className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 cursor-pointer">
          Entfernen
        </button>
      </div>
    </div>
  );
}

function PriceOps({ selectedProducts, setEdit }: OpsProps) {
  const [percent, setPercent] = useState("");
  const [absolute, setAbsolute] = useState("");
  const [setPrice, setSetPrice] = useState("");
  const ids = selectedProducts.map(p => p.id);

  const applyToVariants = (transform: (current: number) => number) => {
    setEdit(ids, (cur, prod) => {
      const next: Record<string, string> = { ...(cur.variantPrices ?? {}) };
      for (const { node: v } of prod.variants.edges) {
        const base = parseFloat(next[v.id] ?? v.price);
        if (!isFinite(base)) continue;
        const newPrice = transform(base);
        next[v.id] = newPrice.toFixed(2);
      }
      return { ...cur, variantPrices: next };
    });
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <input
          type="number"
          step="0.01"
          className="w-28 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="z.B. 10"
          value={percent}
          onChange={e => setPercent(e.target.value)}
        />
        <span className="text-sm text-slate-500">%</span>
        <button
          disabled={!percent}
          onClick={() => applyToVariants(p => p * (1 + parseFloat(percent) / 100))}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer"
        >
          Anheben
        </button>
        <button
          disabled={!percent}
          onClick={() => applyToVariants(p => p * (1 - parseFloat(percent) / 100))}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer"
        >
          Senken
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <input
          type="number"
          step="0.01"
          className="w-28 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="z.B. 5.00"
          value={absolute}
          onChange={e => setAbsolute(e.target.value)}
        />
        <span className="text-sm text-slate-500">absolut</span>
        <button
          disabled={!absolute}
          onClick={() => applyToVariants(p => p + parseFloat(absolute))}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer"
        >
          Hinzufügen
        </button>
        <button
          disabled={!absolute}
          onClick={() => applyToVariants(p => Math.max(0, p - parseFloat(absolute)))}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 cursor-pointer"
        >
          Abziehen
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <input
          type="number"
          step="0.01"
          className="w-28 px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="z.B. 49.99"
          value={setPrice}
          onChange={e => setSetPrice(e.target.value)}
        />
        <span className="text-sm text-slate-500">setze alle auf</span>
        <button
          disabled={!setPrice}
          onClick={() => applyToVariants(() => parseFloat(setPrice))}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white disabled:opacity-50 cursor-pointer"
        >
          Anwenden
        </button>
      </div>
      <p className="text-xs text-slate-500">Operationen wirken auf <strong>alle</strong> Varianten der ausgewählten Produkte.</p>
    </div>
  );
}

function StatusOps({ selectedProducts, setEdit }: OpsProps) {
  const ids = selectedProducts.map(p => p.id);
  const set = (s: ProductNode["status"]) => setEdit(ids, cur => ({ ...cur, status: s }));
  return (
    <div className="flex gap-2">
      <button onClick={() => set("ACTIVE")} className="px-4 py-2 rounded-lg text-xs font-semibold bg-green-100 text-green-700 hover:bg-green-200 cursor-pointer">
        Auf Aktiv
      </button>
      <button onClick={() => set("DRAFT")} className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer">
        Auf Entwurf
      </button>
      <button onClick={() => set("ARCHIVED")} className="px-4 py-2 rounded-lg text-xs font-semibold bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer">
        Archivieren
      </button>
    </div>
  );
}
