import express, { type Router } from "express";
import fs from "fs";
import path from "path";

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
  async function waitForProductMockups(productId: string, maxWaitMs = 120_000) {
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

  return router;
}
