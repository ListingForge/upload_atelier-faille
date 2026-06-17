import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, RefreshCw, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

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
interface ProductsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  edges: { node: ProductNode }[];
}

export default function EditorPage() {
  const [products, setProducts] = useState<ProductNode[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Partial<ProductNode>>>({});
  const [variantEdits, setVariantEdits] = useState<Record<string, Partial<Variant>>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const load = useCallback(async (afterCursor: string | null) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/sh/products${afterCursor ? `?cursor=${encodeURIComponent(afterCursor)}` : ""}`, {
        credentials: "include",
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t}`);
      }
      const data: ProductsPage = await r.json();
      const nodes = data.edges.map(e => e.node);
      setProducts(prev => (afterCursor ? [...prev, ...nodes] : nodes));
      setCursor(data.pageInfo.endCursor);
      setHasMore(data.pageInfo.hasNextPage);
    } catch (e: any) {
      alert("Laden fehlgeschlagen: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  const setEdit = (id: string, patch: Partial<ProductNode>) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };
  const setVariantEdit = (vid: string, patch: Partial<Variant>) => {
    setVariantEdits(prev => ({ ...prev, [vid]: { ...prev[vid], ...patch } }));
  };

  const saveProduct = async (id: string) => {
    const patch = edits[id];
    if (!patch || Object.keys(patch).length === 0) return;
    setSaving(prev => new Set(prev).add(id));
    try {
      const body: any = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.descriptionHtml !== undefined) body.descriptionHtml = patch.descriptionHtml;
      if (patch.vendor !== undefined) body.vendor = patch.vendor;
      if (patch.productType !== undefined) body.productType = patch.productType;
      if (patch.status !== undefined) body.status = patch.status;
      if (patch.tags !== undefined) body.tags = patch.tags;
      if (patch.seo !== undefined) body.seo = patch.seo;
      const r = await fetch(`/api/sh/products/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      setProducts(prev => prev.map(p => (p.id === id ? { ...p, ...patch } as ProductNode : p)));
      setEdits(prev => {
        const n = { ...prev };
        delete n[id];
        return n;
      });
    } catch (e: any) {
      alert("Speichern fehlgeschlagen: " + e.message);
    } finally {
      setSaving(prev => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  };

  const saveVariant = async (vid: string) => {
    const patch = variantEdits[vid];
    if (!patch) return;
    setSaving(prev => new Set(prev).add(vid));
    try {
      const r = await fetch(`/api/sh/variants/${encodeURIComponent(vid)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...(patch.price !== undefined ? { price: patch.price } : {}),
          ...(patch.compareAtPrice !== undefined ? { compareAtPrice: patch.compareAtPrice } : {}),
          ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setVariantEdits(prev => {
        const n = { ...prev };
        delete n[vid];
        return n;
      });
    } catch (e: any) {
      alert("Variante speichern fehlgeschlagen: " + e.message);
    } finally {
      setSaving(prev => {
        const n = new Set(prev);
        n.delete(vid);
        return n;
      });
    }
  };

  const toggle = (id: string) =>
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shopify Bulk Editor</h1>
          <p className="text-sm text-slate-500 mt-1">{products.length} Produkte geladen{hasMore ? " · mehr verfügbar" : ""}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => load(null)}
            disabled={loading}
            className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Neu laden
          </button>
          {hasMore && (
            <button
              onClick={() => load(cursor)}
              disabled={loading}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white cursor-pointer"
            >
              Mehr laden
            </button>
          )}
        </div>
      </div>

      {loading && products.length === 0 && (
        <div className="text-center py-12 text-slate-400 text-sm">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Lade Shopify…
        </div>
      )}

      <div className="space-y-2">
        {products.map(p => {
          const isOpen = expanded.has(p.id);
          const editedP = edits[p.id] || {};
          const isSaving = saving.has(p.id);
          const dirty = Object.keys(editedP).length > 0;
          return (
            <div key={p.id} className="bg-white border border-slate-200 rounded-xl">
              <div className="flex items-center gap-3 p-3 cursor-pointer hover:bg-slate-50" onClick={() => toggle(p.id)}>
                {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                {p.featuredImage?.url ? (
                  <img src={p.featuredImage.url} className="w-12 h-12 object-cover rounded" alt="" />
                ) : (
                  <div className="w-12 h-12 bg-slate-100 rounded" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-900 truncate">{editedP.title ?? p.title}</p>
                  <p className="text-xs text-slate-500 font-mono">
                    {p.status} · {p.variants.edges.length} Var · {p.totalInventory ?? 0} Inv
                  </p>
                </div>
                {dirty && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      saveProduct(p.id);
                    }}
                    disabled={isSaving}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-600 text-white cursor-pointer flex items-center gap-1"
                  >
                    {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Speichern
                  </button>
                )}
              </div>

              {isOpen && (
                <div className="border-t border-slate-100 p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Field label="Titel">
                      <input
                        className="input"
                        value={editedP.title ?? p.title}
                        onChange={e => setEdit(p.id, { title: e.target.value })}
                      />
                    </Field>
                    <Field label="Status">
                      <select
                        className="input"
                        value={editedP.status ?? p.status}
                        onChange={e => setEdit(p.id, { status: e.target.value as ProductNode["status"] })}
                      >
                        <option value="ACTIVE">Active</option>
                        <option value="DRAFT">Draft</option>
                        <option value="ARCHIVED">Archived</option>
                      </select>
                    </Field>
                    <Field label="Vendor">
                      <input className="input" value={editedP.vendor ?? p.vendor} onChange={e => setEdit(p.id, { vendor: e.target.value })} />
                    </Field>
                    <Field label="Typ">
                      <input
                        className="input"
                        value={editedP.productType ?? p.productType}
                        onChange={e => setEdit(p.id, { productType: e.target.value })}
                      />
                    </Field>
                    <Field label="Tags (Komma-getrennt)" className="md:col-span-2">
                      <input
                        className="input"
                        value={(editedP.tags ?? p.tags).join(", ")}
                        onChange={e =>
                          setEdit(p.id, {
                            tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean),
                          })
                        }
                      />
                    </Field>
                    <Field label="Description (HTML)" className="md:col-span-2">
                      <textarea
                        className="input min-h-[100px] font-mono text-xs"
                        value={editedP.descriptionHtml ?? p.descriptionHtml ?? ""}
                        onChange={e => setEdit(p.id, { descriptionHtml: e.target.value })}
                      />
                    </Field>
                    <Field label="SEO Titel">
                      <input
                        className="input"
                        value={editedP.seo?.title ?? p.seo.title ?? ""}
                        onChange={e =>
                          setEdit(p.id, {
                            seo: { title: e.target.value, description: editedP.seo?.description ?? p.seo.description ?? null },
                          })
                        }
                      />
                    </Field>
                    <Field label="SEO Description">
                      <input
                        className="input"
                        value={editedP.seo?.description ?? p.seo.description ?? ""}
                        onChange={e =>
                          setEdit(p.id, {
                            seo: { title: editedP.seo?.title ?? p.seo.title ?? null, description: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </div>

                  <div>
                    <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Varianten</h3>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="text-left text-slate-500 border-b border-slate-100">
                            <th className="py-2 pr-3">Variante</th>
                            <th className="py-2 pr-3">SKU</th>
                            <th className="py-2 pr-3">Preis</th>
                            <th className="py-2 pr-3">Compare At</th>
                            <th className="py-2 pr-3">Inventar</th>
                            <th className="py-2 pr-3"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.variants.edges.map(({ node: v }) => {
                            const ve = variantEdits[v.id] || {};
                            const vd = Object.keys(ve).length > 0;
                            return (
                              <tr key={v.id} className="border-b border-slate-50">
                                <td className="py-2 pr-3 text-slate-800">{v.title}</td>
                                <td className="py-2 pr-3">
                                  <input
                                    className="input"
                                    value={ve.sku ?? v.sku ?? ""}
                                    onChange={e => setVariantEdit(v.id, { sku: e.target.value })}
                                  />
                                </td>
                                <td className="py-2 pr-3 w-24">
                                  <input
                                    className="input"
                                    value={ve.price ?? v.price}
                                    onChange={e => setVariantEdit(v.id, { price: e.target.value })}
                                  />
                                </td>
                                <td className="py-2 pr-3 w-24">
                                  <input
                                    className="input"
                                    value={ve.compareAtPrice ?? v.compareAtPrice ?? ""}
                                    onChange={e => setVariantEdit(v.id, { compareAtPrice: e.target.value || null })}
                                  />
                                </td>
                                <td className="py-2 pr-3 text-slate-500">{v.inventoryQuantity ?? "—"}</td>
                                <td className="py-2 pr-3">
                                  {vd && (
                                    <button onClick={() => saveVariant(v.id)} className="text-indigo-600 hover:underline cursor-pointer">
                                      Speichern
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {p.images.edges.length > 0 && (
                    <div>
                      <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Bilder</h3>
                      <div className="grid grid-cols-6 gap-2">
                        {p.images.edges.map(({ node: img }) => (
                          <img key={img.id} src={img.url} className="aspect-square object-cover rounded" alt={img.altText ?? ""} />
                        ))}
                      </div>
                    </div>
                  )}

                  <a
                    href={`https://${(import.meta as any).env?.VITE_SHOPIFY_STORE || "admin.shopify.com"}/admin/products/${p.id.replace("gid://shopify/Product/", "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"
                  >
                    Im Shopify Admin öffnen <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
