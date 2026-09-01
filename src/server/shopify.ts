import express, { type Router } from "express";
import { getShopifyToken } from "./tokenStore";
import { fetchWithRetry } from "./retry";

const API_VERSION = "2026-04";

function activeShop(): { shop: string; token: string } {
  const shop = process.env.SHOPIFY_STORE;
  if (!shop) throw new Error("SHOPIFY_STORE not set");
  const envToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (envToken) return { shop, token: envToken };
  const stored = getShopifyToken(shop);
  if (stored?.accessToken) return { shop, token: stored.accessToken };
  throw new Error("No Shopify access token. Install the app first.");
}

export async function shopifyGql<T = any>(query: string, variables?: any): Promise<T> {
  return gql(query, variables);
}
async function gql<T = any>(query: string, variables?: any): Promise<T> {
  const { shop, token } = activeShop();
  const r = await fetchWithRetry(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  }, { label: "shopify-gql", timeoutMs: 45_000, retries: 3 });
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${await r.text()}`);
  const json: any = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data as T;
}

const PRODUCTS_LIST_QUERY = `
  query Products($cursor: String) {
    products(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          vendor
          productType
          tags
          descriptionHtml
          seo { title description }
          totalInventory
          featuredImage { url altText }
          images(first: 10) { edges { node { id url altText } } }
          variants(first: 20) {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

export function createShopifyRouter(): Router {
  const router = express.Router();

  // Find a product by exact title + vendor. Used als Fallback wenn Printify's
  // external.id-Push nachhinkt (Printify setzt external.id nur nach einem
  // publishing_succeeded-Webhook, den wir in diesem Setup nicht empfangen).
  //
  // WICHTIG: `title:'X'` in Shopifys `products(query:)` geht über den Volltext-
  // Search-Index, der bei brandneuen Produkten 5–15 min propagiert. `vendor:X`
  // ist dagegen ein Direkt-Filter und trifft sofort. Deshalb: nur nach Vendor
  // filtern + Titel-Match clientseitig in den letzten 50 Kreationen.
  router.get("/find-product", async (req, res) => {
    try {
      const title = String(req.query.title || "");
      const vendor = String(req.query.vendor || "");
      if (!title) return res.status(400).json({ error: "title required" });
      const q = vendor ? `vendor:'${vendor}'` : "";
      const data = await gql<any>(
        `query FindProduct($q: String!) {
          products(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
            edges { node { id title vendor createdAt } }
          }
        }`,
        { q }
      );
      const match = (data?.products?.edges || [])
        .map((e: any) => e.node)
        .find((n: any) => n.title === title && (!vendor || n.vendor === vendor));
      if (!match) return res.status(404).json({ error: "not found" });
      res.json({ shopifyProductId: match.id, title: match.title, vendor: match.vendor, createdAt: match.createdAt });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/products", async (req, res) => {
    try {
      const cursor = (req.query.cursor as string) || null;
      const data = await gql<any>(PRODUCTS_LIST_QUERY, { cursor });
      res.json(data.products);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update a product's core fields + SEO
  router.put("/products/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const { title, descriptionHtml, vendor, productType, status, tags, seo } = req.body || {};
      const data = await gql<any>(
        `mutation ProductUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id title }
            userErrors { field message }
          }
        }`,
        {
          input: {
            id,
            ...(title !== undefined ? { title } : {}),
            ...(descriptionHtml !== undefined ? { descriptionHtml } : {}),
            ...(vendor !== undefined ? { vendor } : {}),
            ...(productType !== undefined ? { productType } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(tags !== undefined ? { tags } : {}),
            ...(seo !== undefined ? { seo } : {}),
          },
        }
      );
      const userErrors = data?.productUpdate?.userErrors;
      if (userErrors?.length) return res.status(400).json({ error: userErrors });
      res.json(data.productUpdate.product);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update a variant (price, sku)
  router.put("/variants/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const { price, compareAtPrice, sku } = req.body || {};
      const data = await gql<any>(
        `mutation ProductVariantUpdate($input: ProductVariantInput!) {
          productVariantUpdate(input: $input) {
            productVariant { id price sku }
            userErrors { field message }
          }
        }`,
        {
          input: {
            id,
            ...(price !== undefined ? { price: String(price) } : {}),
            ...(compareAtPrice !== undefined ? { compareAtPrice: compareAtPrice ? String(compareAtPrice) : null } : {}),
            ...(sku !== undefined ? { sku } : {}),
          },
        }
      );
      const userErrors = data?.productVariantUpdate?.userErrors;
      if (userErrors?.length) return res.status(400).json({ error: userErrors });
      res.json(data.productVariantUpdate.productVariant);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Add an image to a product. Accepts { src } (publicly reachable URL) or { dataUrl, filename } (base64).
  router.post("/products/:id/images", async (req, res) => {
    try {
      const id = req.params.id;
      const { src, dataUrl, filename } = req.body || {};
      if (!src && !dataUrl) return res.status(400).json({ error: "src URL or dataUrl required" });

      let originalSource = src as string | undefined;

      if (!originalSource && dataUrl) {
        const m = /^data:(.+?);base64,(.+)$/.exec(String(dataUrl));
        if (!m) return res.status(400).json({ error: "invalid dataUrl" });
        const mimeType = m[1];
        const buf = Buffer.from(m[2], "base64");
        const name = String(filename || `mockup-${Date.now()}.${(mimeType.split("/")[1] || "png").split(";")[0]}`);

        const staged = await gql<any>(
          `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets { url resourceUrl parameters { name value } }
              userErrors { field message }
            }
          }`,
          {
            input: [
              {
                resource: "IMAGE",
                filename: name,
                mimeType,
                httpMethod: "POST",
                fileSize: String(buf.length),
              },
            ],
          }
        );
        const target = staged?.stagedUploadsCreate?.stagedTargets?.[0];
        const stagedErrors = staged?.stagedUploadsCreate?.userErrors;
        if (stagedErrors?.length) return res.status(400).json({ error: stagedErrors });
        if (!target) return res.status(500).json({ error: "no staged target" });

        const fd = new FormData();
        for (const p of target.parameters as Array<{ name: string; value: string }>) {
          fd.append(p.name, p.value);
        }
        fd.append("file", new Blob([buf], { type: mimeType }), name);
        const upR = await fetch(target.url, { method: "POST", body: fd as any });
        if (!upR.ok) {
          return res.status(500).json({ error: `staged upload ${upR.status}: ${await upR.text()}` });
        }

        originalSource = target.resourceUrl;
      }

      const data = await gql<any>(
        `mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id image { url } } }
            mediaUserErrors { field message }
          }
        }`,
        {
          productId: id,
          media: [{ originalSource, mediaContentType: "IMAGE" }],
        }
      );
      const userErrors = data?.productCreateMedia?.mediaUserErrors;
      if (userErrors?.length) return res.status(400).json({ error: userErrors });
      res.json(data.productCreateMedia.media);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Batch-add mehrere Bilder in EINER productCreateMedia-Mutation.
  // Reihenfolge im Array = Position im Shopify-Produkt. Alle staged uploads
  // laufen parallel, aber die finale Media-Zuordnung ist atomar und geordnet.
  // Body: { images: [{ dataUrl, filename }, ...] } oder { images: [{ src }, ...] }
  router.post("/products/:id/images/batch", async (req, res) => {
    try {
      const id = req.params.id;
      const images = Array.isArray(req.body?.images) ? req.body.images : null;
      if (!images || images.length === 0) return res.status(400).json({ error: "images[] required" });

      const sources = await Promise.all(
        images.map(async (img: any, idx: number) => {
          if (img?.src) return String(img.src);
          const dataUrl = img?.dataUrl;
          if (!dataUrl) throw new Error(`images[${idx}]: src or dataUrl required`);
          const m = /^data:(.+?);base64,(.+)$/.exec(String(dataUrl));
          if (!m) throw new Error(`images[${idx}]: invalid dataUrl`);
          const mimeType = m[1];
          const buf = Buffer.from(m[2], "base64");
          const name = String(img.filename || `mockup-${Date.now()}-${idx}.${(mimeType.split("/")[1] || "png").split(";")[0]}`);

          const staged = await gql<any>(
            `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
              stagedUploadsCreate(input: $input) {
                stagedTargets { url resourceUrl parameters { name value } }
                userErrors { field message }
              }
            }`,
            {
              input: [
                {
                  resource: "IMAGE",
                  filename: name,
                  mimeType,
                  httpMethod: "POST",
                  fileSize: String(buf.length),
                },
              ],
            }
          );
          const stagedErrors = staged?.stagedUploadsCreate?.userErrors;
          if (stagedErrors?.length) throw new Error(`images[${idx}]: staged ${JSON.stringify(stagedErrors)}`);
          const target = staged?.stagedUploadsCreate?.stagedTargets?.[0];
          if (!target) throw new Error(`images[${idx}]: no staged target`);

          const fd = new FormData();
          for (const p of target.parameters as Array<{ name: string; value: string }>) {
            fd.append(p.name, p.value);
          }
          fd.append("file", new Blob([buf], { type: mimeType }), name);
          const upR = await fetch(target.url, { method: "POST", body: fd as any });
          if (!upR.ok) throw new Error(`images[${idx}]: staged upload ${upR.status}: ${await upR.text()}`);
          return String(target.resourceUrl);
        })
      );

      const data = await gql<any>(
        `mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id image { url } } }
            mediaUserErrors { field message }
          }
        }`,
        {
          productId: id,
          media: sources.map(originalSource => ({ originalSource, mediaContentType: "IMAGE" })),
        }
      );
      const userErrors = data?.productCreateMedia?.mediaUserErrors;
      if (userErrors?.length) return res.status(400).json({ error: userErrors });
      res.json({ media: data.productCreateMedia.media, count: sources.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a product image
  router.delete("/products/:id/images/:imageId", async (req, res) => {
    try {
      const data = await gql<any>(
        `mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
            deletedMediaIds
            mediaUserErrors { field message }
          }
        }`,
        { productId: req.params.id, mediaIds: [req.params.imageId] }
      );
      res.json(data.productDeleteMedia);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Rename inch-based size option values (e.g. '12" x 18" (Vertical)') to cm
  // (e.g. '30 × 45 cm (Hochformat)'). Idempotent. Printify's Shopify push adds
  // variants in async batches after publish, so we retry until no inch labels
  // remain (or a max wait elapses) to catch late-arriving values.
  router.post("/products/:id/relabel-sizes-cm", async (req, res) => {
    try {
      const productId = req.params.id;
      const maxAttempts = 20;
      const delayMs = 3000;
      const updated: Array<{ optionName: string; from: string; to: string }> = [];
      let remainingInch = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const product = await gql<any>(
          `query ProductOptions($id: ID!) {
            product(id: $id) {
              id
              options {
                id
                name
                optionValues { id name }
              }
            }
          }`,
          { id: productId }
        );

        const options = product?.product?.options || [];
        let didWork = false;
        remainingInch = 0;

        for (const opt of options) {
          const renames: Array<{ id: string; name: string }> = [];
          for (const v of opt.optionValues || []) {
            const cm = inchLabelToCm(v.name);
            if (cm && cm !== v.name) {
              renames.push({ id: v.id, name: cm });
              updated.push({ optionName: opt.name, from: v.name, to: cm });
            }
          }
          if (renames.length === 0) continue;
          didWork = true;

          const upd = await gql<any>(
            `mutation OptionRelabel($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!]) {
              productOptionUpdate(
                productId: $productId,
                option: $option,
                optionValuesToUpdate: $optionValuesToUpdate,
                variantStrategy: LEAVE_AS_IS
              ) {
                userErrors { field message code }
              }
            }`,
            {
              productId,
              option: { id: opt.id },
              optionValuesToUpdate: renames,
            }
          );
          const errs = upd?.productOptionUpdate?.userErrors;
          if (errs?.length) return res.status(400).json({ error: errs, partial: updated });
        }

        // Re-query to see if new inch-labelled variants appeared meanwhile.
        const check = await gql<any>(
          `query CheckOptions($id: ID!) {
            product(id: $id) { options { optionValues { name } } }
          }`,
          { id: productId }
        );
        remainingInch = 0;
        for (const opt of check?.product?.options || []) {
          for (const v of opt.optionValues || []) {
            if (inchLabelToCm(v.name)) remainingInch++;
          }
        }
        if (remainingInch === 0) break;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
        else if (!didWork) break; // nothing changed this round and still remaining — give up
      }

      res.json({ updated, remainingInch });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// Maps Printify's inch labels to nearest-cm German labels (passend zum Theme-Größenguide).
// e.g. '12" x 18" (Vertical)' → '30 × 46 cm (Hochformat)'
//      '60" x 40" (Horizontal)' → '152 × 102 cm (Querformat)'
// Returns null if the label doesn't match the expected pattern.
function inchLabelToCm(label: string): string | null {
  // Printify liefert die Zoll-Zeichen uneinheitlich: gerade " , Prime ″ (U+2033),
  // Single-Prime ′ , doppelte '' , smarte Quotes “ ” — alle als „Zoll" behandeln.
  // Separator kann x , × oder X sein. Bereits-cm-Labels ("60 × 90 cm …") matchen NICHT
  // (das " cm" blockiert das optionale Quote-Ende) → idempotent.
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*["'′″“”‘’]{0,2}\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*["'′″“”‘’]{0,2}\s*(?:\((Vertical|Horizontal)\))?\s*$/i.exec(label);
  if (!m) return null;
  const w = Math.round(parseFloat(m[1].replace(",", ".")) * 2.54);
  const h = Math.round(parseFloat(m[2].replace(",", ".")) * 2.54);
  const orient = m[3]?.toLowerCase();
  const suffix = orient === "vertical" ? " (Hochformat)" : orient === "horizontal" ? " (Querformat)" : "";
  return `${w} × ${h} cm${suffix}`;
}
