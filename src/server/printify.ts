import express, { type Router } from "express";
import fs from "fs";
import path from "path";
import { shopifyGql } from "./shopify";

const API_BASE = "https://api.printify.com/v1";

function token(): string {
  const t = process.env.PRINTIFY_API_TOKEN;
  if (!t) throw new Error("PRINTIFY_API_TOKEN missing");
  return t;
}
function shopId(): string {
  const s = process.env.PRINTIFY_SHOP_ID;
  if (!s) throw new Error("PRINTIFY_SHOP_ID missing");
  return s;
}

async function pf<T = any>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Printify ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "printify-catalog.json"), "utf-8"));
}
function loadPricing() {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "pricing.json"), "utf-8"));
}

type Orientation = "vertical" | "horizontal";
type ProductType = "stretched" | "framed";
type SizeCode = "XS" | "S" | "M" | "L" | "XL" | "XXL";

interface CreateProductInput {
  title: string;
  description: string;
  tags?: string[];
  imageUrl?: string;       // remote URL accessible to Printify
  imageBase64?: string;    // alternative: base64 string
  imageFileName?: string;  // when sending base64
  type: ProductType;       // stretched | framed
  orientation: Orientation;
  sizes?: SizeCode[];      // default: all 6
}

export function createPrintifyRouter(): Router {
  const router = express.Router();

  router.get("/catalog", (_req, res) => {
    try {
      res.json(loadCatalog());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/pricing", (_req, res) => {
    try {
      res.json(loadPricing());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/shop", async (_req, res) => {
    try {
      const data = await pf<any[]>("/shops.json");
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Upload an image to Printify's image library. Accepts JSON { name, url } or { name, contents (base64) }.
  router.post("/uploads", async (req, res) => {
    try {
      const { name, url, contents } = req.body || {};
      if (!name || (!url && !contents)) {
        return res.status(400).json({ error: "name and url|contents required" });
      }
      const data = await pf("/uploads/images.json", {
        method: "POST",
        body: JSON.stringify(url ? { file_name: name, url } : { file_name: name, contents }),
      });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create a product
  router.post("/products", async (req, res) => {
    try {
      const input = req.body as CreateProductInput & { printifyImageId?: string };
      if (!input?.printifyImageId) return res.status(400).json({ error: "printifyImageId required (upload first)" });

      const catalog = loadCatalog();
      const pricing = loadPricing();
      const cfg = catalog[input.type];
      const orientation: Orientation = input.orientation;
      const sizes: SizeCode[] = input.sizes && input.sizes.length ? input.sizes : ["XS", "S", "M", "L", "XL", "XXL"];
      const priceMap = new Map<SizeCode, number>(
        (pricing[input.type] as any[]).map((p: any) => [p.code as SizeCode, Math.round(p.retail * 100)])
      );

      const variants = sizes.map(sizeCode => {
        const v = cfg.variants[orientation][sizeCode];
        if (!v) throw new Error(`No variant for ${input.type}/${orientation}/${sizeCode}`);
        return {
          id: v.id,
          price: priceMap.get(sizeCode) ?? 0, // cents
          is_enabled: true,
        };
      });

      const body = {
        title: input.title,
        description: input.description,
        blueprint_id: cfg.blueprintId,
        print_provider_id: cfg.printProviderId,
        variants,
        print_areas: [
          {
            variant_ids: variants.map(v => v.id),
            placeholders: [
              {
                position: "front",
                images: [
                  {
                    id: input.printifyImageId,
                    x: 0.5,
                    y: 0.5,
                    scale: 1,
                    angle: 0,
                  },
                ],
              },
            ],
          },
        ],
        tags: input.tags || [],
      };

      const data = await pf<any>(`/shops/${shopId()}/products.json`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Publish a product to Shopify, but tell Printify NOT to push its auto-mockups as images.
  // images:false → Shopify keeps whatever images we set ourselves.
  // We poll the product first so Printify finishes generating its mockups before publish.
  router.post("/products/:id/publish", async (req, res) => {
    try {
      const id = req.params.id;
      await waitForProductMockups(id);
      const body = {
        title: true,
        description: true,
        images: false,
        variants: true,
        tags: true,
        keyFeatures: true,
        shipping_template: true,
      };
      const data = await pf(`/shops/${shopId()}/products/${id}/publish.json`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Poll Printify until the product has its mockups generated. Best-effort — don't error out.
  async function waitForProductMockups(productId: string, maxWaitMs = 300_000) {
    const start = Date.now();
    let interval = 4_000;
    while (Date.now() - start < maxWaitMs) {
      try {
        const product = await pf<any>(`/shops/${shopId()}/products/${productId}.json`);
        const imageCount = product.images?.length || 0;
        if (imageCount > 0) return;
      } catch (e) {
        // continue polling
      }
      await new Promise(r => setTimeout(r, interval));
      interval = Math.min(interval + 1_000, 10_000);
    }
    console.warn(`[Printify] waitForProductMockups timed out for ${productId}, continuing anyway.`);
  }

  // Single-check (no long-poll): returns 200 with the Shopify product id once Printify
  // has pushed it, otherwise 202 "not yet". The frontend polls this with short intervals
  // so we don't hold open long-lived HTTP connections that proxies (nginx/Cloudflare) kill.
  router.get("/products/:id/shopify-id", async (req, res) => {
    try {
      const id = req.params.id;
      const product = await pf<any>(`/shops/${shopId()}/products/${id}.json`);
      const ext = product?.external?.id;
      const handle = product?.external?.handle;
      if (ext) {
        const numeric = String(ext);
        const gid = numeric.startsWith("gid://") ? numeric : `gid://shopify/Product/${numeric}`;
        return res.json({ shopifyProductId: gid, externalId: numeric, handle });
      }
      res.status(202).json({
        pending: true,
        is_locked: product?.is_locked ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Confirm publish (Printify expects /publishing_succeeded after webhook normally; here we call it directly
  // because we publish via Shopify Admin API ourselves).
  router.post("/products/:id/publishing_succeeded", async (req, res) => {
    try {
      const id = req.params.id;
      const body = req.body || { external: { id: "", handle: "" } };
      const data = await pf(`/shops/${shopId()}/products/${id}/publishing_succeeded.json`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: alle noch-nicht-published Produkte holen ────────────────────
  // Bricht in 25er-Seiten durch — Printify default limit ist 10.
  async function fetchAllProducts(): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    while (true) {
      const res = await pf<any>(`/shops/${shopId()}/products.json?limit=25&page=${page}`);
      const chunk: any[] = res.data || [];
      all.push(...chunk);
      if (chunk.length < 25) break;
      page++;
      if (page > 200) break; // Sicherheitsgrenze: max 5000 Produkte
    }
    return all;
  }

  // Printify markiert `visible: false` und `external: null` bei unveröffentlichten.
  // Wir prüfen beides zusätzlich zu `is_locked` (locked bedeutet: in publish-Queue).
  function isUnpublished(p: any): boolean {
    return !p?.external?.id && !p?.is_locked;
  }

  // Admin-Endpunkt: löscht alle unveröffentlichten Produkte (optional ab Datum).
  // Query: ?since=YYYY-MM-DD  (optional — sonst alle unpublished).
  //        &dry_run=1         (dry-run, listet nur, löscht nichts).
  router.post("/admin/delete-unpublished", async (req, res) => {
    try {
      const sinceStr = String(req.query.since || "");
      const dryRun = String(req.query.dry_run || "") === "1";
      const sinceTs = sinceStr ? Date.parse(sinceStr) : 0;

      const products = await fetchAllProducts();
      const targets = products.filter(p => {
        if (!isUnpublished(p)) return false;
        if (!sinceTs) return true;
        const created = Date.parse(p.created_at || "");
        return created >= sinceTs;
      });

      if (dryRun) {
        res.json({
          dry_run: true,
          total_scanned: products.length,
          would_delete: targets.length,
          sample: targets.slice(0, 20).map(p => ({ id: p.id, title: p.title, created_at: p.created_at })),
        });
        return;
      }

      const deleted: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      // Parallel mit begrenzter Concurrency — Printify rate-limitet bei ca. 10 req/s,
      // 5 gleichzeitig ist der sichere Sweet Spot für DELETE.
      const CONCURRENCY = 5;
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, targets.length) }).map(async () => {
          while (true) {
            const i = cursor++;
            if (i >= targets.length) return;
            const p = targets[i];
            try {
              await pf(`/shops/${shopId()}/products/${p.id}.json`, { method: "DELETE" });
              deleted.push(p.id);
            } catch (e: any) {
              failed.push({ id: p.id, error: e.message });
            }
          }
        })
      );

      res.json({
        total_scanned: products.length,
        matched: targets.length,
        deleted: deleted.length,
        failed: failed.length,
        failedDetails: failed.slice(0, 20),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Republish aller unveröffentlichten Produkte (feuert Printifys Publish-Call nochmal).
  router.post("/admin/republish-unpublished", async (req, res) => {
    try {
      const dryRun = String(req.query.dry_run || "") === "1";
      const products = await fetchAllProducts();
      const targets = products.filter(isUnpublished);

      if (dryRun) {
        res.json({ dry_run: true, would_republish: targets.length, sample: targets.slice(0, 20).map(p => ({ id: p.id, title: p.title })) });
        return;
      }

      const republished: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      // Parallel mit CONCURRENCY 3 — Publish löst intern Sync-Jobs aus, daher konservativer.
      const CONCURRENCY = 3;
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, targets.length) }).map(async () => {
          while (true) {
            const i = cursor++;
            if (i >= targets.length) return;
            const p = targets[i];
            try {
              await pf(`/shops/${shopId()}/products/${p.id}/publish.json`, {
                method: "POST",
                body: JSON.stringify({
                  title: true, description: true, images: false,
                  variants: true, tags: true, keyFeatures: true, shipping_template: true,
                }),
              });
              republished.push(p.id);
            } catch (e: any) {
              failed.push({ id: p.id, error: e.message });
            }
          }
        })
      );

      res.json({ matched: targets.length, republished: republished.length, failed: failed.length, failedDetails: failed.slice(0, 20) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: löscht Printify-Produkte deren external.id auf ein nicht mehr
  // existierendes Shopify-Produkt zeigt (stale link nach vorherigem Shopify-Cleanup).
  router.post("/admin/delete-stale-shopify-links", async (req, res) => {
    try {
      const dryRun = String(req.query.dry_run || "") === "1";
      const products = await fetchAllProducts();

      // Alle mit external.id
      const linked = products.filter(p => p?.external?.id);
      const gids = linked.map(p => {
        const raw = String(p.external.id);
        return raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
      });

      // Batch-Check via Shopify nodes(ids) — 100 per Request
      const stale: any[] = [];
      const CHUNK = 100;
      for (let i = 0; i < gids.length; i += CHUNK) {
        const chunk = gids.slice(i, i + CHUNK);
        const data = await shopifyGql<any>(
          `query CheckNodes($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id } } }`,
          { ids: chunk }
        );
        const nodes: any[] = data?.nodes || [];
        // nodes[i] is null when the product is gone
        for (let j = 0; j < chunk.length; j++) {
          if (nodes[j] === null) stale.push(linked[i + j]);
        }
      }

      if (dryRun) {
        res.json({
          dry_run: true,
          total_linked: linked.length,
          stale_count: stale.length,
          sample: stale.slice(0, 20).map(p => ({ id: p.id, title: p.title, external_id: p.external?.id })),
        });
        return;
      }

      const deleted: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      const CONCURRENCY = 5;
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, stale.length) }).map(async () => {
          while (true) {
            const i = cursor++;
            if (i >= stale.length) return;
            const p = stale[i];
            try {
              await pf(`/shops/${shopId()}/products/${p.id}.json`, { method: "DELETE" });
              deleted.push(p.id);
            } catch (e: any) {
              failed.push({ id: p.id, error: e.message });
            }
          }
        })
      );

      res.json({
        total_linked: linked.length,
        stale_count: stale.length,
        deleted: deleted.length,
        failed: failed.length,
        failedDetails: failed.slice(0, 20),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
