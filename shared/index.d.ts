/**
 * Types shared by the server and the web storefront, which read the SAME
 * SQLite rows and must agree on their shape.
 *
 * Types ONLY — this package has no runtime and no build step; both workspaces
 * import it type-only (the imports are erased at compile time). That is also
 * why package.json declares no `main`: a runtime import fails loudly instead
 * of silently resolving to nothing.
 */

export type ProductStatus = "draft" | "active" | "sold" | "inactive";

/** Structured attributes stored as JSON in products.attributes. */
export interface ProductAttributes {
  area_m2?: number;
  /** Lot size in m² — for a house this is a primary decision factor. */
  lot_m2?: number;
  bedrooms?: number;
  bathrooms?: number;
  neighborhood?: string;
  city?: string;
  features?: string[];
  admin_fee?: number;
  /** Annual property tax (predial), in COP. */
  property_tax?: number;
  estrato?: number;
  levels?: number;
  floor?: number;
  elevator?: boolean;
  negotiable?: boolean;
  [key: string]: unknown;
}
