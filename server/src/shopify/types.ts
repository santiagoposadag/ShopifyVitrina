/**
 * The catalog shapes the agent works with.
 *
 * These are OUR types, not Shopify's wire format: the GraphQL responses are
 * flattened here (edges/nodes unwrapped, money kept as the decimal string
 * Shopify returned) so nothing downstream has to know the shape of a connection
 * — and so no price is ever rebuilt from a float.
 */

/** Shopify's three product states. See ProductStatus below for what they mean here. */
export type ShopifyProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export const PRODUCT_STATUSES: ShopifyProductStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED"];

export interface ShopifyVariant {
  /** gid://shopify/ProductVariant/… */
  id: string;
  /**
   * The variant's own identifier, and the one the owner actually says out loud
   * ("quedan 4 de la CAM-NEG-M"). Nullable because Shopify does not require it —
   * a variant without one can only be addressed through its product.
   */
  sku: string | null;
  /** "M / Negro", or "Default Title" for a product with no options. */
  title: string;
  /** Decimal string exactly as Shopify returned it. Never parsed to a float. */
  price: string;
  compareAtPrice: string | null;
  /** Null when Shopify is not tracking this variant's stock. */
  inventoryQuantity: number | null;
  /** gid://shopify/InventoryItem/… — what every stock mutation addresses. */
  inventoryItemId: string;
  /** False means quantities are meaningless: the variant always sells. */
  inventoryTracked: boolean;
  selectedOptions: { name: string; value: string }[];
}

export interface ShopifyProduct {
  /** gid://shopify/Product/… */
  id: string;
  /** URL slug, unique per store. The product-level identifier. */
  handle: string;
  title: string;
  /** Plain text, not the HTML body. */
  description: string;
  status: ShopifyProductStatus;
  productType: string;
  vendor: string;
  tags: string[];
  /** Sum across tracked variants. Null when nothing is tracked. */
  totalInventory: number | null;
  /** Present only once the product is published to the Online Store. */
  onlineStoreUrl: string | null;
  mediaCount: number;
  /**
   * The product's option axes, in Shopify's own order, with the values that
   * already exist on each.
   *
   * Order is load-bearing: a variant's optionValues are matched positionally
   * against these, so sending them shuffled silently creates a variant whose
   * diameter is its height. The existing values matter too — Shopify does not
   * normalise, so "7,5 cm" and "7.5 cm" become two different options.
   */
  options: { name: string; values: string[] }[];
  variants: ShopifyVariant[];
  updatedAt: string;
}

export interface ShopifyLocation {
  id: string;
  name: string;
}

/** One location's stock for one inventory item. */
export interface InventoryLevel {
  locationId: string;
  locationName: string;
  available: number;
}

/** A variant plus where it is stocked — what get_inventory answers with. */
export interface VariantInventory {
  product: ShopifyProduct;
  variant: ShopifyVariant;
  levels: InventoryLevel[];
}

/** Fields a create or update may set. Everything optional is a merge, not a reset. */
export interface ProductInput {
  title?: string;
  description?: string;
  status?: ShopifyProductStatus;
  productType?: string;
  vendor?: string;
  tags?: string[];
}

/** One variant to create, as the owner described it. */
export interface VariantInput {
  sku?: string;
  price: number;
  /** Option values in the product's option order, e.g. ["M", "Negro"]. */
  optionValues?: string[];
  /** Initial stock at the default location. Omitted means "do not set any". */
  quantity?: number;
}
