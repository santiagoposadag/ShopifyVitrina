import type { SearchHit } from "../../src/shopify/rank.js";
import type { ShopifyProduct } from "../../src/shopify/types.js";

/**
 * The pure renderers, as the golden fixture exercises them.
 *
 * Every string here is what the MODEL reads back from a tool call — the same
 * kind of prompt surface as a description, and just as invisible to a
 * functional test if a word changes. The case list lives here, apart from both
 * the fixture generator and the assertion, so the two cannot drift into
 * agreeing with each other instead of with the code.
 */
export interface RenderHelpers {
  describeProduct(product: ShopifyProduct): string;
  renderSearchHits(hits: SearchHit[]): string;
  renderProductList(hits: SearchHit[], filters: { status?: string; query?: string }, truncated?: boolean): string;
  whyVariantsCannotBeAdded(
    product: ShopifyProduct,
    variants: { sku?: string; price: number; option_values?: string[]; quantity?: number }[],
  ): string | null;
  newOptionValues(
    product: ShopifyProduct,
    variants: { sku?: string; price: number; option_values?: string[]; quantity?: number }[],
  ): string[];
  storefrontHost(products: ShopifyProduct[], fallback: string): string;
  cartPermalink(host: string, lines: { variantId: string; quantity: number }[]): string;
}

function product(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: "gid://shopify/Product/1",
    handle: "camiseta-negra",
    title: "Camiseta negra",
    description: "Algodón peinado",
    status: "ACTIVE",
    productType: "Camiseta",
    vendor: "Luminiere",
    tags: ["verano", "algodón"],
    totalInventory: 5,
    onlineStoreUrl: "https://luminiere.co/products/camiseta-negra",
    mediaCount: 2,
    options: [
      { name: "Diámetro", values: ["5 cm", "7,5 cm"] },
      { name: "Altura", values: ["8 cm"] },
    ],
    updatedAt: "2026-08-01T00:00:00Z",
    variants: [
      {
        id: "gid://shopify/ProductVariant/51237367841067",
        sku: "062AC-MZ",
        title: "5 cm / 8 cm",
        price: "13800.00",
        compareAtPrice: null,
        inventoryQuantity: 4,
        inventoryItemId: "gid://shopify/InventoryItem/1",
        inventoryTracked: true,
        selectedOptions: [
          { name: "Diámetro", value: "5 cm" },
          { name: "Altura", value: "8 cm" },
        ],
      },
      {
        id: "gid://shopify/ProductVariant/2",
        sku: null,
        title: "7,5 cm / 8 cm",
        price: "17900.00",
        compareAtPrice: null,
        inventoryQuantity: 0,
        inventoryItemId: "gid://shopify/InventoryItem/2",
        inventoryTracked: false,
        selectedOptions: [
          { name: "Diámetro", value: "7,5 cm" },
          { name: "Altura", value: "8 cm" },
        ],
      },
    ],
    ...overrides,
  };
}

function soldOut(): ShopifyProduct {
  const p = product({ handle: "vela-citronela", title: "Vela citronela", totalInventory: 0 });
  p.variants = [{ ...p.variants[0]!, inventoryQuantity: 0 }];
  return p;
}

function hit(score: number, p: ShopifyProduct = product()): SearchHit {
  return { product: p, score };
}

/** Run every case against one implementation of the renderers. */
export function runRenderCases(h: RenderHelpers): Record<string, string> {
  const noAxes = product({ handle: "vela-simple", options: [] });
  return {
    describeProduct: h.describeProduct(product()),
    describeProduct_minimal: h.describeProduct(
      product({
        description: "",
        productType: "",
        vendor: "",
        tags: [],
        totalInventory: null,
        onlineStoreUrl: null,
      }),
    ),
    renderSearchHits_empty: h.renderSearchHits([]),
    renderSearchHits_confident: h.renderSearchHits([hit(1), hit(0.75, soldOut())]),
    renderSearchHits_approximate: h.renderSearchHits([hit(0.61)]),
    renderProductList_empty_unfiltered: h.renderProductList([], {}),
    renderProductList_empty_status: h.renderProductList([], { status: "DRAFT" }),
    renderProductList_empty_query: h.renderProductList([], { status: "DRAFT", query: "camiseta roja" }),
    renderProductList_query: h.renderProductList([hit(0.8)], { query: "camiseta" }),
    renderProductList_status: h.renderProductList([hit(1)], { status: "ACTIVE" }),
    renderProductList_truncated: h.renderProductList([hit(1)], {}, true),
    whyVariantsCannotBeAdded_ok: String(
      h.whyVariantsCannotBeAdded(product(), [{ price: 1, option_values: ["5 cm", "10 cm"] }]),
    ),
    whyVariantsCannotBeAdded_noAxes: String(
      h.whyVariantsCannotBeAdded(noAxes, [{ price: 1, option_values: [] }]),
    ),
    whyVariantsCannotBeAdded_wrongCount: String(
      h.whyVariantsCannotBeAdded(product(), [{ price: 1, option_values: ["5 cm"] }]),
    ),
    whyVariantsCannotBeAdded_duplicate: String(
      h.whyVariantsCannotBeAdded(product(), [{ price: 1, option_values: ["5 cm", "8 cm"] }]),
    ),
    newOptionValues: h
      .newOptionValues(product(), [{ price: 1, option_values: ["7.5 cm", "9 cm"] }])
      .join(" | "),
    storefrontHost: h.storefrontHost([product()], "awyk1i-b4.myshopify.com"),
    storefrontHost_fallback: h.storefrontHost(
      [product({ onlineStoreUrl: null })],
      "awyk1i-b4.myshopify.com",
    ),
    cartPermalink: h.cartPermalink("luminiere.co", [
      { variantId: "gid://shopify/ProductVariant/51237367841067", quantity: 2 },
      { variantId: "gid://shopify/ProductVariant/2", quantity: 1 },
    ]),
  };
}
