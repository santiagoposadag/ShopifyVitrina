import { fetchProducts } from "./catalog.js";
import type { ShopifyClient } from "./client.js";
import type { ShopifyProduct } from "./types.js";

/**
 * A short-lived, read-only copy of the catalog, used ONLY to rank search results.
 *
 * This is not a mirror and it is not a source of truth. There is no write-back,
 * no reconciliation and no conflict resolution: it is disposable, rebuilt on a
 * TTL, and its whole job is to give shopify/rank.ts a corpus to score without
 * paying a full catalog fetch on every message of a conversation.
 *
 * The facts that must never be stale — price and stock — are re-read live for
 * the handful of products actually shown (see refreshProducts in catalog.ts),
 * so the worst a stale cache can do is take up to the TTL to make a
 * brand-new product findable by text.
 */
export interface CatalogSnapshot {
  products: ShopifyProduct[];
  /** True when the catalog is larger than the fetch ceiling. */
  truncated: boolean;
}

/** Ceiling on how much catalog is held for ranking. */
const MAX_CACHED_PRODUCTS = 250;

export class CatalogCache {
  private entries = new Map<string, { snapshot: CatalogSnapshot; expiresAt: number }>();
  /**
   * In-flight fetches, keyed like the entries. Without this a photo burst that
   * wakes three tool calls at once would run three full catalog fetches against
   * a rate-limited API and throw two of the results away.
   */
  private inflight = new Map<string, Promise<CatalogSnapshot>>();

  constructor(
    private readonly client: ShopifyClient,
    private readonly ttlMs: number,
    /** Injectable so tests do not depend on the wall clock. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The catalog to rank against. `query` is Shopify's own filter (e.g.
   * "status:ACTIVE") and is part of the cache key: the customer search and the
   * owner's report ask for different sets and must not share an entry.
   */
  async snapshot(query: string): Promise<CatalogSnapshot> {
    const key = query || "*";
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.snapshot;

    const existing = this.inflight.get(key);
    if (existing) return await existing;

    const pending = fetchProducts(this.client, {
      query: query || undefined,
      limit: MAX_CACHED_PRODUCTS,
    })
      .then((snapshot) => {
        // A zero TTL means "never cache" — useful in tests and for a store
        // where the owner edits in the Shopify admin while chatting.
        if (this.ttlMs > 0) {
          this.entries.set(key, { snapshot, expiresAt: this.now() + this.ttlMs });
        }
        return snapshot;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return await pending;
  }

  /**
   * Drop everything. Called after any write, because the owner's very next
   * message is usually about what they just changed, and answering it from a
   * snapshot taken before the change is the one staleness they WILL notice.
   */
  invalidate(): void {
    this.entries.clear();
  }
}
