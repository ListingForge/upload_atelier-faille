import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const TOKEN_FILE = path.join(DATA_DIR, "tokens.json");

export interface ShopToken {
  shop: string;
  accessToken: string;
  scope: string;
  installedAt: string;
}

interface Store {
  shopify: Record<string, ShopToken>;
}

function load(): Store {
  if (!fs.existsSync(TOKEN_FILE)) return { shopify: {} };
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return { shopify: {} };
  }
}

function save(store: Store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2));
}

export function getShopifyToken(shop: string): ShopToken | undefined {
  return load().shopify[shop];
}

export function setShopifyToken(token: ShopToken) {
  const store = load();
  store.shopify[token.shop] = token;
  save(store);
}

export function listShopifyShops(): string[] {
  return Object.keys(load().shopify);
}
