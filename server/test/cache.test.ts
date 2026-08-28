import { describe, expect, it } from "vitest";
import { CatalogCache } from "../src/shopify/cache.js";
import { ShopifyClient, type ShopifyConfig } from "../src/shopify/client.js";

const CONFIG: ShopifyConfig = {
  shopifyStoreDomain: "tienda.myshopify.com",
  shopifyAdminToken: "shpat_secret",
  shopifyClientId: "",
  shopifyClientSecret: "",
  shopifyApiVersion: "2026-01",
};

const page = (handles: string[], hasNextPage = false) => ({
  products: {
    nodes: handles.map((handle, i) => ({
      id: `gid://shopify/Product/${i}`,
      handle,
      title: handle,
      description: "",
      status: "ACTIVE",
      productType: "",
      vendor: "",
      tags: [],
      totalInventory: 1,
      onlineStoreUrl: null,
      updatedAt: "2026-08-01T00:00:00Z",
      mediaCount: { count: 0 },
      variants: { nodes: [] },
    })),
    pageInfo: { hasNextPage, endCursor: "cursor-1" },
  },
});

/** Counts fetches and lets the test control when each one resolves. */
function fakeShopify(pages: unknown[]) {
  const state = { fetches: 0, release: undefined as (() => void) | undefined };
  const queue = [...pages];
  const fetchImpl = (async () => {
    state.fetches += 1;
    if (state.release) {
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    }
    return new Response(JSON.stringify({ data: queue.shift() ?? page([]) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { client: new ShopifyClient(CONFIG, fetchImpl, async () => undefined), state };
}

describe("CatalogCache", () => {
  it("fetches once and serves the second call from memory", async () => {
    const { client, state } = fakeShopify([page(["a", "b"])]);
    const cache = new CatalogCache(client, 60_000, () => 1_000);

    expect((await cache.snapshot("status:ACTIVE")).products).toHaveLength(2);
    await cache.snapshot("status:ACTIVE");

    expect(state.fetches).toBe(1);
  });

  it("re-fetches once the TTL has passed", async () => {
    const { client, state } = fakeShopify([page(["a"]), page(["a", "b"])]);
    let now = 1_000;
    const cache = new CatalogCache(client, 60_000, () => now);

    await cache.snapshot("");
    now += 60_001;
    expect((await cache.snapshot("")).products).toHaveLength(2);
    expect(state.fetches).toBe(2);
  });

  // The customer search and the owner's report ask for different sets. Sharing
  // one entry would show a customer the drafts.
  it("keys entries by the Shopify query", async () => {
    const { client, state } = fakeShopify([page(["a"]), page(["b"])]);
    const cache = new CatalogCache(client, 60_000, () => 1_000);

    await cache.snapshot("status:ACTIVE");
    await cache.snapshot("status:DRAFT");

    expect(state.fetches).toBe(2);
  });

  // The owner's very next message is usually about what they just changed, and
  // answering it from a snapshot taken before the change is the one staleness
  // they WILL notice.
  it("re-fetches after an invalidate, TTL or no TTL", async () => {
    const { client, state } = fakeShopify([page(["a"]), page(["a", "b"])]);
    const cache = new CatalogCache(client, 60_000, () => 1_000);

    await cache.snapshot("");
    cache.invalidate();
    expect((await cache.snapshot("")).products).toHaveLength(2);
    expect(state.fetches).toBe(2);
  });

  // A photo burst wakes several tool calls at once. Without the in-flight map
  // they would each run a full catalog fetch against a rate-limited API and
  // throw all but one of the results away.
  it("collapses concurrent misses into a single fetch", async () => {
    const { client, state } = fakeShopify([page(["a"])]);
    state.release = () => undefined; // hold the first fetch open
    const cache = new CatalogCache(client, 60_000, () => 1_000);

    const first = cache.snapshot("");
    const second = cache.snapshot("");
    await Promise.resolve();
    state.release?.();

    const [a, b] = await Promise.all([first, second]);
    expect(state.fetches).toBe(1);
    expect(a.products).toEqual(b.products);
  });

  // Zero means "never cache" — the right setting for a store whose owner edits
  // in the Shopify admin while chatting.
  it("never caches when the TTL is zero", async () => {
    const { client, state } = fakeShopify([page(["a"]), page(["a"])]);
    const cache = new CatalogCache(client, 0, () => 1_000);

    await cache.snapshot("");
    await cache.snapshot("");

    expect(state.fetches).toBe(2);
  });

  // A truncated catalog presented as the whole one is how an owner is told they
  // have 250 products when they have 900.
  it("reports truncation when the catalog exceeds the fetch ceiling", async () => {
    const many = Array.from({ length: 50 }, (_, i) => `p-${i}`);
    const { client } = fakeShopify(Array.from({ length: 5 }, () => page(many, true)));
    const cache = new CatalogCache(client, 0, () => 1_000);

    const snapshot = await cache.snapshot("");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.products).toHaveLength(250);
  });
});
