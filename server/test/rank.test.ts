import { describe, expect, it } from "vitest";
import { CONFIDENT_MATCH_SCORE, hasStock, rankProducts } from "../src/shopify/rank.js";
import type { ShopifyProduct, ShopifyVariant } from "../src/shopify/types.js";

function variant(overrides: Partial<ShopifyVariant> = {}): ShopifyVariant {
  return {
    id: "gid://shopify/ProductVariant/1",
    sku: "SKU-1",
    title: "Default Title",
    price: "80000.00",
    compareAtPrice: null,
    inventoryQuantity: 5,
    inventoryItemId: "gid://shopify/InventoryItem/1",
    inventoryTracked: true,
    selectedOptions: [],
    ...overrides,
  };
}

let nextId = 0;
function product(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  nextId += 1;
  return {
    id: `gid://shopify/Product/${nextId}`,
    handle: `producto-${nextId}`,
    title: "Producto",
    description: "",
    status: "ACTIVE",
    productType: "",
    vendor: "",
    tags: [],
    totalInventory: 5,
    onlineStoreUrl: null,
    mediaCount: 0,
    updatedAt: "2026-08-01T00:00:00Z",
    variants: [variant()],
    ...overrides,
  };
}

const scoreOf = (products: ShopifyProduct[], query: string): number | undefined =>
  rankProducts(products, { query })[0]?.score;

// The whole reason this scorer exists instead of Shopify's `products(query:)`:
// people do not type the way a catalog is written.
describe("rankProducts text matching", () => {
  it("ignores accents in either direction", () => {
    const p = product({ title: "Camiseta de algodón" });
    expect(scoreOf([p], "algodon")).toBe(1);
    expect(scoreOf([product({ title: "Camiseta de algodon" })], "algodón")).toBe(1);
  });

  // The bug this was built for, in retail clothing: a search for "manga larga"
  // must find "Mangalarga", and a search for "mangalarga" must find "Manga
  // Larga". Word boundaries are not something a shopper gets right.
  it("matches across word breaks in both directions", () => {
    expect(scoreOf([product({ title: "Camisa Mangalarga" })], "manga larga")).toBe(1);
    expect(scoreOf([product({ title: "Camisa Manga Larga" })], "mangalarga")).toBe(1);
  });

  it("tolerates a typo in a long enough word", () => {
    const score = scoreOf([product({ title: "Camiseta negra" })], "camisetta");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  // A mistyped number is a different number, not a misspelling: "talla 38"
  // must not be answered by a price of 380 or a size 39.
  it("never fuzzy-matches a number", () => {
    const p = product({ title: "Zapato", variants: [variant({ selectedOptions: [{ name: "Talla", value: "39" }] })] });
    expect(rankProducts([p], { query: "38", min_score: 0 })[0]?.score).toBe(0);
    expect(scoreOf([p], "39")).toBe(1);
  });

  // Every item is a "producto" and every question is someone "buscando" one, so
  // these words cannot tell two products apart — counting them as misses would
  // punish the natural way of asking and trip the approximate-match warning
  // over an exact answer.
  it("does not let Spanish filler drag a perfect match below the warning line", () => {
    const p = product({ title: "Camiseta negra" });
    const score = scoreOf([p], "¿tienes alguna camiseta negra disponible?");
    expect(score).toBe(1);
    expect(score).toBeGreaterThanOrEqual(CONFIDENT_MATCH_SCORE);
  });

  // Size and colour live in variant options. Without verbalizing them, "negra"
  // and "M" are guaranteed misses that sink the product that answers the
  // question below the floor.
  it("matches on variant option values and SKUs", () => {
    const p = product({
      title: "Camiseta",
      variants: [
        variant({
          sku: "CAM-NEG-M",
          selectedOptions: [
            { name: "Talla", value: "M" },
            { name: "Color", value: "Negro" },
          ],
        }),
      ],
    });
    expect(scoreOf([p], "camiseta negro")).toBe(1);
    expect(scoreOf([p], "CAM-NEG-M")).toBe(1);
  });

  // The option NAME is catalog scaffolding: every clothing product has a
  // "Talla", so matching on it would make the word free and meaningless.
  it("does not match on the option name itself", () => {
    const p = product({
      title: "Camiseta",
      variants: [variant({ sku: null, selectedOptions: [{ name: "Talla", value: "M" }] })],
    });
    expect(rankProducts([p], { query: "talla", min_score: 0 })[0]?.score).toBe(0);
  });

  it("matches on tags, product type and vendor", () => {
    const p = product({ title: "Prenda", productType: "Chaqueta", vendor: "Totto", tags: ["impermeable"] });
    expect(scoreOf([p], "chaqueta")).toBe(1);
    expect(scoreOf([p], "totto")).toBe(1);
    expect(scoreOf([p], "impermeable")).toBe(1);
  });

  it("returns nothing rather than a bad guess when the catalog has no such thing", () => {
    const p = product({ title: "Camiseta negra" });
    expect(rankProducts([p], { query: "bicicleta de montaña" })).toEqual([]);
  });

  it("ranks the better match first", () => {
    const exact = product({ title: "Camiseta negra manga corta" });
    const partial = product({ title: "Camiseta blanca" });
    const hits = rankProducts([partial, exact], { query: "camiseta negra" });
    expect(hits[0]?.product.id).toBe(exact.id);
  });

  it("returns every product when no text was asked for", () => {
    const hits = rankProducts([product(), product()], {});
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.score === 1)).toBe(true);
  });
});

// Price and stock EXCLUDE rather than score: an item at five times the budget
// is not a partial match, and one that is sold out cannot be bought at any
// relevance.
describe("rankProducts filters", () => {
  it("excludes anything outside the stated price range", () => {
    const cheap = product({ variants: [variant({ price: "20000.00" })] });
    const dear = product({ variants: [variant({ price: "500000.00" })] });

    expect(rankProducts([cheap, dear], { max_price: 100000 }).map((h) => h.product.id)).toEqual([
      cheap.id,
    ]);
    expect(rankProducts([cheap, dear], { min_price: 100000 }).map((h) => h.product.id)).toEqual([
      dear.id,
    ]);
  });

  // A product's price is its CHEAPEST variant: someone with a 100k budget can
  // buy the S even if the XL costs more.
  it("filters on the lowest variant price", () => {
    const p = product({
      variants: [variant({ price: "50000.00" }), variant({ id: "v2", price: "300000.00" })],
    });
    expect(rankProducts([p], { max_price: 100000 })).toHaveLength(1);
  });

  it("drops sold-out products only when asked to", () => {
    const soldOut = product({ variants: [variant({ inventoryQuantity: 0 })] });
    expect(rankProducts([soldOut], {})).toHaveLength(1);
    expect(rankProducts([soldOut], { in_stock_only: true })).toHaveLength(0);
  });

  it("caps the result set when a limit is given", () => {
    const many = Array.from({ length: 30 }, () => product());
    expect(rankProducts(many, { limit: 10 })).toHaveLength(10);
    expect(rankProducts(many, {})).toHaveLength(30);
  });
});

// An untracked variant always sells: Shopify is not counting it, so a quantity
// of 0 means "unknown", not "sold out". Reporting it as sold out would tell a
// customer we do not have something sitting on the shelf.
describe("hasStock", () => {
  it("is true when any variant has units", () => {
    expect(
      hasStock(product({ variants: [variant({ inventoryQuantity: 0 }), variant({ id: "v2" })] })),
    ).toBe(true);
  });

  it("is false when every tracked variant is at zero", () => {
    expect(hasStock(product({ variants: [variant({ inventoryQuantity: 0 })] }))).toBe(false);
  });

  it("treats an untracked variant as available", () => {
    expect(
      hasStock(
        product({
          variants: [variant({ inventoryTracked: false, inventoryQuantity: 0 })],
        }),
      ),
    ).toBe(true);
  });
});
