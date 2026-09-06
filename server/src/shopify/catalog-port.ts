import type { Config } from "../config.js";
import type {
  CartLine,
  CatalogPort,
  CatalogSearch,
  CatalogSearchResult,
  ResolvedProduct,
} from "../tools/ports.js";
import type { CatalogCache } from "./cache.js";
import * as catalog from "./catalog.js";
import { gidSuffix, type ShopifyClient } from "./client.js";
import { rankProducts, type SearchHit } from "./rank.js";
import type { ShopifyProduct } from "./types.js";

/**
 * The one adapter: CatalogPort over the Shopify layer that already works.
 *
 * Nothing in shopify/ changed for it. It composes what was previously composed
 * inside the tools — the cache as a ranking corpus, a live re-read of the
 * products actually shown, and a cache invalidation after every write — so the
 * packs can state policy without knowing that any of it exists.
 */

/**
 * The storefront host a cart link must point at.
 *
 * Taken from a product's own onlineStoreUrl rather than SHOPIFY_STORE_DOMAIN,
 * because those differ: the config holds awyk1i-b4.myshopify.com while the
 * store actually answers on luminiere.co. Both reach the same checkout, but
 * sending a customer the myshopify one looks like a phishing link.
 *
 * Exported for tests.
 */
export function storefrontHost(products: ShopifyProduct[], fallback: string): string {
  for (const product of products) {
    if (!product.onlineStoreUrl) continue;
    try {
      return new URL(product.onlineStoreUrl).host;
    } catch {
      // Keep looking; a malformed url is not worth failing a cart over.
    }
  }
  return fallback;
}

/**
 * A Shopify cart permalink: /cart/<variantId>:<qty>,<variantId>:<qty>
 *
 * The NUMERIC variant id, not the gid — Shopify's cart route does not accept a
 * gid, and it fails by showing an empty cart rather than by erroring.
 *
 * Exported for tests.
 */
export function cartPermalink(
  host: string,
  lines: { variantId: string; quantity: number }[],
): string {
  const path = lines.map((l) => `${gidSuffix(l.variantId)}:${l.quantity}`).join(",");
  return `https://${host}/cart/${path}`;
}

export interface ShopifyCatalogPortDeps {
  client: ShopifyClient;
  /**
   * Shared across turns, as it was when the tools held it: its whole value is
   * that a burst of messages does not pay for a full catalog fetch per turn.
   */
  cache: CatalogCache;
  config: Pick<Config, "shopifyLocationId" | "shopifyStoreDomain">;
}

export function shopifyCatalogPort(deps: ShopifyCatalogPortDeps): CatalogPort {
  const { client, cache, config } = deps;

  return {
    async search(input: CatalogSearch): Promise<CatalogSearchResult> {
      // Shopify's own filter, which decides WHICH products are fetched and is
      // part of the cache key: the customer search and the owner's report ask
      // for different sets and must not share an entry.
      const snapshot = await cache.snapshot(input.status ? `status:${input.status}` : "");
      const ranked = rankProducts(snapshot.products, {
        query: input.query,
        min_price: input.minPrice,
        max_price: input.maxPrice,
        in_stock_only: input.inStockOnly,
        limit: input.limit,
      });
      if (ranked.length === 0) return { hits: [], truncated: snapshot.truncated };

      // One call for the whole result set: the cache is fine for deciding WHICH
      // products answer the question and not fine for the two facts the answer
      // then quotes.
      const fresh = await catalog.refreshProducts(
        client,
        ranked.map((hit) => hit.product.id),
      );
      const byId = new Map(fresh.map((product) => [product.id, product]));
      return {
        hits: ranked
          .map((hit) => {
            const current = byId.get(hit.product.id);
            return current ? { product: current, score: hit.score } : null;
          })
          .filter((hit): hit is SearchHit => hit !== null),
        truncated: snapshot.truncated,
      };
    },

    resolve: (ref: string): Promise<ResolvedProduct | null> => catalog.resolveProduct(client, ref),

    variantBySku: catalog.findVariantBySku,

    locations: () => catalog.listLocations(client),

    location: (requested?: string) =>
      catalog.resolveLocation(client, config.shopifyLocationId, requested),

    inventoryLevels: (inventoryItemId: string) =>
      catalog.getInventoryLevels(client, inventoryItemId),

    async adjustInventory(input): Promise<number | null> {
      const after = await catalog.adjustInventory(client, input);
      cache.invalidate();
      return after;
    },

    async setInventory(input): Promise<void> {
      await catalog.setInventory(client, input);
      cache.invalidate();
    },

    async create(input): Promise<ShopifyProduct> {
      const product = await catalog.createProduct(client, input);
      // Every write invalidates, because the owner's very next message is
      // usually about what they just changed. Done here, once per write, rather
      // than in each tool: a pack that forgot the call would answer the next
      // question from a snapshot taken before its own edit.
      cache.invalidate();
      return product;
    },

    async update(productId, fields): Promise<ShopifyProduct> {
      const product = await catalog.updateProduct(client, productId, fields);
      cache.invalidate();
      return product;
    },

    async updateVariants(productId, variants): Promise<ShopifyProduct> {
      const product = await catalog.updateVariants(client, productId, variants);
      cache.invalidate();
      return product;
    },

    async addVariants(input): Promise<ShopifyProduct> {
      const product = await catalog.addVariants(client, input);
      cache.invalidate();
      return product;
    },

    async remove(productId: string): Promise<void> {
      await catalog.deleteProduct(client, productId);
      cache.invalidate();
    },

    publish: (productId: string) => catalog.publishToOnlineStore(client, productId),

    uploadPhotos: (productId, files) => catalog.uploadProductPhotos(client, productId, files),

    cartUrl: (lines: CartLine[]) =>
      cartPermalink(
        storefrontHost(
          lines.map((line) => line.product),
          config.shopifyStoreDomain,
        ),
        lines.map((line) => ({ variantId: line.variant.id, quantity: line.quantity })),
      ),
  };
}
