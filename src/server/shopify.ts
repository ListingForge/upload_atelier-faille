import express, { type Router } from "express";
import { getShopifyToken } from "./tokenStore";

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

async function gql<T = any>(query: string, variables?: any): Promise<T> {
  const { shop, token } = activeShop();
  const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
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

  return router;
}
