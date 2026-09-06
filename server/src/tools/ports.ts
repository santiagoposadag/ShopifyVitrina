import type { SearchHit } from "../shopify/rank.js";
import type {
  InventoryLevel,
  ProductInput,
  ShopifyLocation,
  ShopifyProduct,
  ShopifyProductStatus,
  ShopifyVariant,
  VariantInput,
} from "../shopify/types.js";
import type { Lead, LeadType } from "../types.js";

/**
 * What a toolpack is allowed to talk to.
 *
 * A pack states policy — what the model may ask for, what is refused before a
 * mutation is sent, and what the answer reads like — and a port performs it.
 * Nothing here names a GraphQL client, a cache or a database handle, so a pack
 * can be exercised against a plain object with no network and no casts, and the
 * catalog behind it can be replaced without reopening the privilege boundary.
 *
 * The `Shopify*` shapes below are the catalog TYPES from shopify/types.ts, not
 * Shopify's wire format: connections are already flattened and money is the
 * decimal string the store returned. A second implementation has to produce
 * those shapes, which is a real obligation (it must decide what a variant, an
 * option axis and an inventory level are) but not a Shopify-specific one. What
 * it must NOT be asked to produce is anything from shopify/client.ts — see
 * `ReportableError` below for the one place that boundary still shows.
 */

/** The product a reference points at, and the variant when the reference named one. */
export interface ResolvedProduct {
  product: ShopifyProduct;
  /** Set only when the reference was a SKU, which names one variant exactly. */
  variant?: ShopifyVariant;
}

/**
 * What a search asks for.
 *
 * `status` EXCLUDES and `query` only SCORES — the split shopify/rank.ts makes
 * for price and stock, carried into the port so a second implementation cannot
 * quietly turn a constraint into a preference. Every result carries a score
 * because a hit is a candidate, not proof the request was met.
 */
export interface CatalogSearch {
  /** One status, or every status when omitted — which is what shows drafts. */
  status?: ShopifyProductStatus;
  query?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  limit?: number;
}

export interface CatalogSearchResult {
  hits: SearchHit[];
  /** True when the catalog is larger than one fetch: the answer is incomplete. */
  truncated: boolean;
}

/** One line of a checkout link: which variant, of which product, how many. */
export interface CartLine {
  product: ShopifyProduct;
  variant: ShopifyVariant;
  quantity: number;
}

/**
 * The catalog, as the tools need it.
 *
 * The six §2.3 names — search, resolve, create, update, adjustInventory(key),
 * publish — are the core; the rest exist because a tool calls them today and
 * inventing a narrower surface would mean rewriting call sites this phase is
 * meant to leave alone.
 */
export interface CatalogPort {
  /** Fetch, rank and re-read the winners live, so price and stock are current. */
  search(input: CatalogSearch): Promise<CatalogSearchResult>;

  /**
   * gid, then SKU, then handle, then null. An implementation must NOT fall
   * through to a text search: a fuzzy match that then feeds delete_product is
   * how the wrong product gets deleted.
   */
  resolve(ref: string): Promise<ResolvedProduct | null>;

  /**
   * The variant of an ALREADY FETCHED product with this SKU. Pure and
   * synchronous on purpose — it decides nothing a remote catalog would have to
   * be asked about, and making it async would only add an await to every caller.
   */
  variantBySku(product: ShopifyProduct, sku: string): ShopifyVariant | undefined;

  locations(): Promise<ShopifyLocation[]>;

  /**
   * The location a stock operation applies to. Throws rather than guessing when
   * the store has several and none was named: moving four shirts out of the
   * wrong warehouse is an error nobody notices until a count.
   */
  location(requested?: string): Promise<ShopifyLocation>;

  inventoryLevels(inventoryItemId: string): Promise<InventoryLevel[]>;

  /**
   * A signed movement, de-duplicated on `idempotencyKey`.
   *
   * Delivery is at-least-once, so the key is the only thing standing between a
   * replayed batch and a miscount. It is minted per TURN and per call within
   * that turn (see ToolContext.nextInventoryKey) and must be passed through
   * unmodified — an implementation that drops it turns every retry into a
   * second sale.
   */
  adjustInventory(input: {
    inventoryItemId: string;
    locationId: string;
    delta: number;
    idempotencyKey: string;
    reason?: string;
  }): Promise<number | null>;

  /**
   * An absolute count, compare-and-set. `compareQuantity` is what makes this
   * fail instead of overwriting a sale made at the counter between the read and
   * the write.
   */
  setInventory(input: {
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    compareQuantity?: number;
    reason?: string;
  }): Promise<void>;

  /**
   * Create a product with its options, variants and opening stock. Variants
   * absent from a LATER update must survive it — this is a create, never a
   * declarative overwrite of the whole product.
   */
  create(input: {
    product: ProductInput & { title: string };
    optionNames: string[];
    variants: VariantInput[];
    locationId: string;
  }): Promise<ShopifyProduct>;

  /** A MERGE: only the keys present are sent, and everything else keeps its stored value. */
  update(productId: string, fields: ProductInput): Promise<ShopifyProduct>;

  /** Price and/or SKU on existing variants. Omitted fields are untouched. */
  updateVariants(
    productId: string,
    variants: { id: string; price?: number; sku?: string }[],
  ): Promise<ShopifyProduct>;

  addVariants(input: {
    productId: string;
    optionNames: string[];
    variants: VariantInput[];
    locationId: string;
  }): Promise<ShopifyProduct>;

  /** Permanent, with every variant and photo. The caller must have confirmed the handle. */
  remove(productId: string): Promise<void>;

  /**
   * Put the product on the storefront. A status of ACTIVE does NOT publish, so
   * this is a second operation — and it returns false rather than throwing,
   * because the status change already succeeded and failing the turn over a
   * reporting detail would replay the whole batch.
   */
  publish(productId: string): Promise<boolean>;

  /**
   * Upload photos, STRICTLY one at a time and in the order given: arrival order
   * is the order the owner shot them in and the first becomes the cover. A
   * partial result is reported, never thrown — losing the last two photos is no
   * reason to undo the eight that landed.
   */
  uploadPhotos(
    productId: string,
    files: { path: string; alt?: string | null }[],
  ): Promise<{ uploaded: number; failed: number }>;

  /**
   * A link that opens the store's own checkout with exactly these lines in it.
   *
   * On the port because the URL is the storefront's shape, not ours: today it is
   * a Shopify cart permalink built from numeric variant ids on the host the
   * store actually answers on. Every way it can be wrong is silent — a gid or
   * the wrong host both produce a page that loads and is not the cart the
   * customer was promised — so the one implementation that knows the scheme owns
   * building it. The caller has already refused unpublished and sold-out lines.
   */
  cartUrl(lines: CartLine[]): string;
}

/** What a captured lead is, from the tools' side. */
export interface LeadDraft {
  phone: string;
  type: LeadType;
  name?: string;
  note?: string;
  /** SKU or handle the lead is about, free text. */
  productCode?: string;
}

export interface LeadsPort {
  save(draft: LeadDraft): Promise<Lead>;
  list(sinceDays?: number): Promise<Lead[]>;
}

/**
 * One inbound photo waiting to become a product image.
 *
 * `path` is a file on a volume both containers mount, which is the reason this
 * port is not merely a table wrapper: an implementation that cannot hand the
 * catalog a readable path cannot serve attach_pending_photos at all.
 */
export interface PendingPhoto {
  id: number;
  path: string;
  caption: string | null;
}

export interface MediaPort {
  /**
   * Photos this conversation sent that are not on a product yet, oldest first.
   *
   * Deliberately does NOT claim them: only the ids that actually uploaded are
   * marked, so a partial failure leaves the rest claimable by the next attempt.
   */
  listPending(conversationPhone: string): Promise<PendingPhoto[]>;
  markAttached(ids: number[], productId: string): Promise<void>;
}

/** Everything the packs may reach. One bag, built once at the composition root. */
export interface ToolPorts {
  catalog: CatalogPort;
  leads: LeadsPort;
  media: MediaPort;
}
