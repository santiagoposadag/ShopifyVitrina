import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  assertNoUserErrors,
  ShopifyError,
  toMoneyString,
  type ShopifyClient,
  type UserError,
} from "./client.js";
import type {
  InventoryLevel,
  ProductInput,
  ShopifyLocation,
  ShopifyProduct,
  ShopifyProductStatus,
  ShopifyVariant,
  VariantInput,
  VariantInventory,
} from "./types.js";

/**
 * Every field the agent is ever shown about a product, in one fragment so a
 * read from search, from a resolve, and from a mutation's return value all
 * carry the same facts. A tool that reported fewer fields after a write than
 * before one would teach the agent that updating a product loses data.
 */
const PRODUCT_FIELDS = `
fragment ProductFields on Product {
  id
  handle
  title
  description
  status
  productType
  vendor
  tags
  totalInventory
  onlineStoreUrl
  updatedAt
  mediaCount { count }
  options { name position values }
  variants(first: 100) {
    nodes {
      id
      sku
      title
      price
      compareAtPrice
      inventoryQuantity
      selectedOptions { name value }
      inventoryItem { id tracked }
    }
  }
}`;

interface RawVariant {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean };
}

interface RawProduct {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  status: ShopifyProductStatus;
  productType: string | null;
  vendor: string | null;
  tags: string[] | null;
  totalInventory: number | null;
  onlineStoreUrl: string | null;
  updatedAt: string;
  mediaCount: { count: number } | null;
  options: { name: string; position: number; values: string[] }[] | null;
  variants: { nodes: RawVariant[] };
}

function toVariant(raw: RawVariant): ShopifyVariant {
  return {
    id: raw.id,
    sku: raw.sku && raw.sku.trim() !== "" ? raw.sku : null,
    title: raw.title,
    price: raw.price,
    compareAtPrice: raw.compareAtPrice,
    inventoryQuantity: raw.inventoryQuantity,
    inventoryItemId: raw.inventoryItem.id,
    inventoryTracked: raw.inventoryItem.tracked,
    selectedOptions: raw.selectedOptions,
  };
}

function toProduct(raw: RawProduct): ShopifyProduct {
  return {
    id: raw.id,
    handle: raw.handle,
    title: raw.title,
    description: raw.description ?? "",
    status: raw.status,
    productType: raw.productType ?? "",
    vendor: raw.vendor ?? "",
    tags: raw.tags ?? [],
    totalInventory: raw.totalInventory,
    onlineStoreUrl: raw.onlineStoreUrl,
    mediaCount: raw.mediaCount?.count ?? 0,
    // Sorted by position, because addVariants must send optionValues in the
    // product's OWN axis order and Shopify does not promise the query order.
    options: [...(raw.options ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ name: o.name, values: o.values })),
    variants: raw.variants.nodes.map(toVariant),
    updatedAt: raw.updatedAt,
  };
}

/**
 * Escape a value going into a Shopify search query string.
 *
 * The query argument is its own little language, and an unescaped quote in an
 * owner-supplied SKU does not error — it silently changes which products the
 * query selects, which for a delete tool is the difference between removing one
 * product and removing the wrong one.
 */
function quoteQueryValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// --- Reads --------------------------------------------------------------------

const PRODUCTS_PAGE = 50;

/**
 * Fetch products, following pagination up to `limit`.
 *
 * `limit` is a real ceiling, not a page size: a catalog larger than it comes
 * back truncated, and every caller that can be misled by that says so in its
 * own output rather than presenting a partial catalog as the whole one.
 */
export async function fetchProducts(
  client: ShopifyClient,
  options: { query?: string; limit?: number } = {},
): Promise<{ products: ShopifyProduct[]; truncated: boolean }> {
  const limit = options.limit ?? 250;
  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;

  while (products.length < limit) {
    const pageSize = Math.min(PRODUCTS_PAGE, limit - products.length);
    const data: {
      products: { nodes: RawProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await client.request(
      `${PRODUCT_FIELDS}
       query CatalogPage($first: Int!, $after: String, $query: String) {
         products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
           nodes { ...ProductFields }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { first: pageSize, after: cursor, query: options.query ?? null },
    );

    products.push(...data.products.nodes.map(toProduct));
    if (!data.products.pageInfo.hasNextPage) return { products, truncated: false };
    cursor = data.products.pageInfo.endCursor;
  }

  return { products, truncated: true };
}

/**
 * Re-read specific products live, in one call.
 *
 * The search corpus comes from a cache (shopify/cache.ts), which is fine for
 * deciding WHICH products answer a question and not fine for the two facts the
 * answer then quotes: price and stock. Every product the agent is about to be
 * shown goes through here first, so a price edited in the Shopify admin two
 * minutes ago is the price the customer is told.
 *
 * Products that have since been deleted simply do not come back.
 */
export async function refreshProducts(
  client: ShopifyClient,
  ids: string[],
): Promise<ShopifyProduct[]> {
  if (ids.length === 0) return [];
  const data: { nodes: (RawProduct | null)[] } = await client.request(
    `${PRODUCT_FIELDS}
     query RefreshProducts($ids: [ID!]!) {
       nodes(ids: $ids) { ... on Product { ...ProductFields } }
     }`,
    { ids },
  );
  return data.nodes.filter((node): node is RawProduct => node !== null).map(toProduct);
}

/** The product a reference points at, and the variant when the reference named one. */
export interface ResolvedProduct {
  product: ShopifyProduct;
  /** Set only when the reference was a SKU, which names one variant exactly. */
  variant?: ShopifyVariant;
}

/**
 * Resolve one of the three things the owner might call a product by.
 *
 * Order matters and is not arbitrary. A SKU is the identifier the owner says
 * out loud, so it is tried first among the human-typed forms; a handle is the
 * storefront slug and is unique per store; a gid is what our own tool results
 * carry back. Nothing here falls through to a text search: a fuzzy match that
 * feeds `delete_product` is how the wrong product gets deleted, so an
 * unresolvable reference returns null and the agent has to search and confirm.
 */
export async function resolveProduct(
  client: ShopifyClient,
  ref: string,
): Promise<ResolvedProduct | null> {
  const trimmed = ref.trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith("gid://shopify/Product/")) {
    const data: { product: RawProduct | null } = await client.request(
      `${PRODUCT_FIELDS}
       query ProductById($id: ID!) { product(id: $id) { ...ProductFields } }`,
      { id: trimmed },
    );
    return data.product ? { product: toProduct(data.product) } : null;
  }

  // SKU first: it identifies a single variant, which is what a stock or price
  // question is actually about.
  const bySku: { productVariants: { nodes: (RawVariant & { product: RawProduct })[] } } =
    await client.request(
      `${PRODUCT_FIELDS}
       query VariantBySku($query: String!) {
         productVariants(first: 2, query: $query) {
           nodes {
             id sku title price compareAtPrice inventoryQuantity
             selectedOptions { name value }
             inventoryItem { id tracked }
             product { ...ProductFields }
           }
         }
       }`,
      { query: `sku:${quoteQueryValue(trimmed)}` },
    );

  const variantNode = bySku.productVariants.nodes[0];
  if (variantNode) {
    return { product: toProduct(variantNode.product), variant: toVariant(variantNode) };
  }

  const byHandle: { products: { nodes: RawProduct[] } } = await client.request(
    `${PRODUCT_FIELDS}
     query ProductByHandle($query: String!) {
       products(first: 1, query: $query) { nodes { ...ProductFields } }
     }`,
    { query: `handle:${quoteQueryValue(trimmed)}` },
  );

  const productNode = byHandle.products.nodes[0];
  return productNode ? { product: toProduct(productNode) } : null;
}

/** Find the variant a SKU names inside an already-fetched product. */
export function findVariantBySku(product: ShopifyProduct, sku: string): ShopifyVariant | undefined {
  const wanted = sku.trim().toLowerCase();
  return product.variants.find((v) => v.sku?.toLowerCase() === wanted);
}

// --- Locations and stock ------------------------------------------------------

export async function listLocations(client: ShopifyClient): Promise<ShopifyLocation[]> {
  const data: { locations: { nodes: { id: string; name: string }[] } } = await client.request(
    `query Locations { locations(first: 20, includeInactive: false) { nodes { id name } } }`,
  );
  return data.locations.nodes;
}

/**
 * Pick the location a stock operation applies to.
 *
 * Configured wins. Otherwise a single-location store resolves silently, and a
 * multi-location store throws rather than guessing: moving four shirts out of
 * the wrong warehouse is a real-world error nobody notices until a count.
 */
export async function resolveLocation(
  client: ShopifyClient,
  configuredLocationId: string,
  requested?: string,
): Promise<ShopifyLocation> {
  const locations = await listLocations(client);
  if (locations.length === 0) throw new ShopifyError("The store has no active locations.");

  const wanted = (requested ?? configuredLocationId).trim();
  if (wanted !== "") {
    const match = locations.find(
      (l) => l.id === wanted || l.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!match) {
      throw new ShopifyError(
        `No location matches "${wanted}". Available: ${locations.map((l) => l.name).join(", ")}`,
      );
    }
    return match;
  }

  if (locations.length === 1) return locations[0]!;
  throw new ShopifyError(
    `The store has more than one location and none was given. Ask which one: ${locations
      .map((l) => l.name)
      .join(", ")}`,
  );
}

export async function getInventoryLevels(
  client: ShopifyClient,
  inventoryItemId: string,
): Promise<InventoryLevel[]> {
  const data: {
    inventoryItem: {
      inventoryLevels: {
        nodes: { location: { id: string; name: string }; quantities: { name: string; quantity: number }[] }[];
      };
    } | null;
  } = await client.request(
    `query Levels($id: ID!) {
       inventoryItem(id: $id) {
         inventoryLevels(first: 20) {
           nodes {
             location { id name }
             quantities(names: ["available"]) { name quantity }
           }
         }
       }
     }`,
    { id: inventoryItemId },
  );

  if (!data.inventoryItem) return [];
  return data.inventoryItem.inventoryLevels.nodes.map((node) => ({
    locationId: node.location.id,
    locationName: node.location.name,
    available: node.quantities.find((q) => q.name === "available")?.quantity ?? 0,
  }));
}

export async function getVariantInventory(
  client: ShopifyClient,
  resolved: ResolvedProduct,
  variant: ShopifyVariant,
): Promise<VariantInventory> {
  return {
    product: resolved.product,
    variant,
    levels: await getInventoryLevels(client, variant.inventoryItemId),
  };
}

/**
 * Move stock by a delta — "vendí 3".
 *
 * `idempotencyKey` is not optional in practice and the caller must derive it
 * from the inbox row that triggered the turn. Delivery through this pipeline is
 * at-least-once by design: a batch that fails after this mutation is retried,
 * and a delta applied twice removes six shirts instead of three with nothing
 * anywhere recording that it happened. Shopify de-duplicates on the key, which
 * is the only thing standing between a retry and a miscount.
 */
export async function adjustInventory(
  client: ShopifyClient,
  input: {
    inventoryItemId: string;
    locationId: string;
    delta: number;
    idempotencyKey: string;
    reason?: string;
  },
): Promise<number | null> {
  const data: {
    inventoryAdjustQuantities: {
      userErrors: UserError[];
      inventoryAdjustmentGroup: { changes: { name: string; delta: number; quantityAfterChange: number | null }[] } | null;
    };
  } = await client.request(
    `mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
       inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
         userErrors { field message }
         inventoryAdjustmentGroup {
           changes { name delta quantityAfterChange }
         }
       }
     }`,
    {
      key: input.idempotencyKey,
      input: {
        name: "available",
        reason: input.reason ?? "correction",
        changes: [
          {
            delta: input.delta,
            inventoryItemId: input.inventoryItemId,
            locationId: input.locationId,
          },
        ],
      },
    },
  );

  assertNoUserErrors("inventoryAdjustQuantities", data.inventoryAdjustQuantities.userErrors);
  const change = data.inventoryAdjustQuantities.inventoryAdjustmentGroup?.changes[0];
  return change?.quantityAfterChange ?? null;
}

/**
 * Set stock to an absolute number — "quedan 11".
 *
 * `compareQuantity` makes this a compare-and-set: if someone sold one at the
 * counter between the read and this write, the mutation fails instead of
 * silently overwriting their sale. That is also why this is preferred over a
 * delta whenever the absolute number is knowable.
 */
export async function setInventory(
  client: ShopifyClient,
  input: {
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    /** Omit only when the current quantity genuinely is not known. */
    compareQuantity?: number;
    reason?: string;
  },
): Promise<void> {
  const data: { inventorySetQuantities: { userErrors: UserError[] } } = await client.request(
    `mutation SetStock($input: InventorySetQuantitiesInput!) {
       inventorySetQuantities(input: $input) { userErrors { field message } }
     }`,
    {
      input: {
        name: "available",
        reason: input.reason ?? "correction",
        ignoreCompareQuantity: input.compareQuantity === undefined,
        quantities: [
          {
            inventoryItemId: input.inventoryItemId,
            locationId: input.locationId,
            quantity: input.quantity,
            ...(input.compareQuantity === undefined
              ? {}
              : { compareQuantity: input.compareQuantity }),
          },
        ],
      },
    },
  );
  assertNoUserErrors("inventorySetQuantities", data.inventorySetQuantities.userErrors);
}

// --- Writes -------------------------------------------------------------------

/**
 * Create a product, its options, its variants and their opening stock.
 *
 * Deliberately NOT productSet. productSet is declarative over the whole
 * product: variants absent from the input are deleted. That is the right shape
 * for a sync job and exactly the wrong one behind a chat agent, where a model
 * re-sending a payload it half remembers would silently drop every variant it
 * forgot to mention.
 */
export async function createProduct(
  client: ShopifyClient,
  input: {
    product: ProductInput & { title: string; handle?: string };
    /** Option names in order, e.g. ["Talla", "Color"]. Empty for a single-variant product. */
    optionNames?: string[];
    variants: VariantInput[];
    locationId: string;
  },
): Promise<ShopifyProduct> {
  const optionNames = input.optionNames ?? [];

  // Shopify derives a product's option values from its variants, so the option
  // definition and the variant list have to agree before either is sent.
  if (optionNames.length > 0) {
    for (const variant of input.variants) {
      if ((variant.optionValues?.length ?? 0) !== optionNames.length) {
        throw new ShopifyError(
          `Variant ${variant.sku ?? "(no sku)"} has ${variant.optionValues?.length ?? 0} option value(s) but the product defines ${optionNames.length} option(s).`,
        );
      }
    }
  }

  const productOptions =
    optionNames.length > 0
      ? optionNames.map((name, index) => ({
          name,
          values: uniqueValues(input.variants.map((v) => v.optionValues?.[index] ?? "")).map(
            (value) => ({ name: value }),
          ),
        }))
      : undefined;

  const created: { productCreate: { product: RawProduct | null; userErrors: UserError[] } } =
    await client.request(
      `${PRODUCT_FIELDS}
       mutation CreateProduct($product: ProductCreateInput!) {
         productCreate(product: $product) {
           product { ...ProductFields }
           userErrors { field message }
         }
       }`,
      {
        product: {
          title: input.product.title,
          ...(input.product.handle ? { handle: input.product.handle } : {}),
          ...(input.product.description === undefined
            ? {}
            : { descriptionHtml: input.product.description }),
          ...(input.product.status ? { status: input.product.status } : { status: "DRAFT" }),
          ...(input.product.productType ? { productType: input.product.productType } : {}),
          ...(input.product.vendor ? { vendor: input.product.vendor } : {}),
          ...(input.product.tags ? { tags: input.product.tags } : {}),
          ...(productOptions ? { productOptions } : {}),
        },
      },
    );

  assertNoUserErrors("productCreate", created.productCreate.userErrors);
  const product = created.productCreate.product;
  if (!product) throw new ShopifyError("productCreate returned no product");

  if (optionNames.length > 0) {
    return await addVariants(client, {
      productId: product.id,
      optionNames,
      variants: input.variants,
      locationId: input.locationId,
      // A product created with options still carries the default variant until
      // the first real one lands; leaving it behind puts a phantom "Default
      // Title" line in the store.
      removeStandalone: true,
    });
  }

  // No options: Shopify already made one default variant. Give it the price and
  // SKU the owner stated, then its opening stock.
  const single = input.variants[0];
  if (!single) return toProduct(product);

  const defaultVariant = product.variants.nodes[0];
  if (!defaultVariant) throw new ShopifyError("productCreate returned no default variant");

  const updated = await updateVariants(client, product.id, [
    { id: defaultVariant.id, price: single.price, sku: single.sku, tracked: true },
  ]);

  if (single.quantity !== undefined) {
    const variant = updated.variants[0];
    if (variant) {
      await setInventory(client, {
        inventoryItemId: variant.inventoryItemId,
        locationId: input.locationId,
        quantity: single.quantity,
        reason: "received",
      });
    }
    return await refetch(client, product.id);
  }

  return updated;
}

/** Add variants to an existing product. */
export async function addVariants(
  client: ShopifyClient,
  input: {
    productId: string;
    optionNames: string[];
    variants: VariantInput[];
    locationId: string;
    removeStandalone?: boolean;
  },
): Promise<ShopifyProduct> {
  const data: {
    productVariantsBulkCreate: { product: RawProduct | null; userErrors: UserError[] };
  } = await client.request(
    `${PRODUCT_FIELDS}
     mutation AddVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
       productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
         product { ...ProductFields }
         userErrors { field message }
       }
     }`,
    {
      productId: input.productId,
      strategy: input.removeStandalone ? "REMOVE_STANDALONE_VARIANT" : "DEFAULT",
      variants: input.variants.map((variant) => ({
        price: toMoneyString(variant.price),
        ...(variant.sku ? { inventoryItem: { sku: variant.sku, tracked: true } } : { inventoryItem: { tracked: true } }),
        optionValues: input.optionNames.map((name, index) => ({
          optionName: name,
          name: variant.optionValues?.[index] ?? "",
        })),
        ...(variant.quantity === undefined
          ? {}
          : {
              inventoryQuantities: [
                { locationId: input.locationId, availableQuantity: variant.quantity },
              ],
            }),
      })),
    },
  );

  assertNoUserErrors("productVariantsBulkCreate", data.productVariantsBulkCreate.userErrors);
  const product = data.productVariantsBulkCreate.product;
  if (!product) throw new ShopifyError("productVariantsBulkCreate returned no product");
  return toProduct(product);
}

/**
 * Update product-level fields.
 *
 * A merge, not a rewrite: only the keys present in `input` are sent, so an
 * omitted title keeps the stored title. This is the same contract the
 * real-estate build enforced, and for the same reason — a model rebuilding a
 * payload from memory must not be able to overwrite correct data with a guess.
 */
export async function updateProduct(
  client: ShopifyClient,
  productId: string,
  input: ProductInput,
): Promise<ShopifyProduct> {
  const data: { productUpdate: { product: RawProduct | null; userErrors: UserError[] } } =
    await client.request(
      `${PRODUCT_FIELDS}
       mutation UpdateProduct($product: ProductUpdateInput!) {
         productUpdate(product: $product) {
           product { ...ProductFields }
           userErrors { field message }
         }
       }`,
      {
        product: {
          id: productId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { descriptionHtml: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.productType === undefined ? {} : { productType: input.productType }),
          ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
        },
      },
    );

  assertNoUserErrors("productUpdate", data.productUpdate.userErrors);
  const product = data.productUpdate.product;
  if (!product) throw new ShopifyError("productUpdate returned no product");
  return toProduct(product);
}

/** Update price and/or SKU on existing variants. Omitted fields are untouched. */
export async function updateVariants(
  client: ShopifyClient,
  productId: string,
  variants: { id: string; price?: number; sku?: string | null; tracked?: boolean }[],
): Promise<ShopifyProduct> {
  const data: {
    productVariantsBulkUpdate: { product: RawProduct | null; userErrors: UserError[] };
  } = await client.request(
    `${PRODUCT_FIELDS}
     mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         product { ...ProductFields }
         userErrors { field message }
       }
     }`,
    {
      productId,
      variants: variants.map((variant) => {
        const inventoryItem: Record<string, unknown> = {};
        if (variant.sku !== undefined) inventoryItem.sku = variant.sku;
        if (variant.tracked !== undefined) inventoryItem.tracked = variant.tracked;
        return {
          id: variant.id,
          ...(variant.price === undefined ? {} : { price: toMoneyString(variant.price) }),
          ...(Object.keys(inventoryItem).length > 0 ? { inventoryItem } : {}),
        };
      }),
    },
  );

  assertNoUserErrors("productVariantsBulkUpdate", data.productVariantsBulkUpdate.userErrors);
  const product = data.productVariantsBulkUpdate.product;
  if (!product) throw new ShopifyError("productVariantsBulkUpdate returned no product");
  return toProduct(product);
}

/** Permanently delete a product. There is no undo — see the tool's confirmation rule. */
export async function deleteProduct(client: ShopifyClient, productId: string): Promise<void> {
  const data: { productDelete: { deletedProductId: string | null; userErrors: UserError[] } } =
    await client.request(
      `mutation DeleteProduct($input: ProductDeleteInput!) {
         productDelete(input: $input) { deletedProductId userErrors { field message } }
       }`,
      { input: { id: productId } },
    );
  assertNoUserErrors("productDelete", data.productDelete.userErrors);
  if (!data.productDelete.deletedProductId) {
    throw new ShopifyError("productDelete reported no deleted product");
  }
}

/**
 * Publish a product to the Online Store sales channel.
 *
 * status ACTIVE alone does NOT make a product visible — publication to a
 * channel is a separate operation. Reporting "publicado" on the strength of the
 * status field is the most plausible wrong-but-plausible bug in this
 * integration, so the publish path calls this and reports what it actually
 * managed to do.
 *
 * Returns false rather than throwing when the channel cannot be resolved: the
 * status change already succeeded, and turning that into a thrown error would
 * retry the whole turn over a reporting detail.
 */
export async function publishToOnlineStore(
  client: ShopifyClient,
  productId: string,
): Promise<boolean> {
  let publicationId: string | undefined;
  try {
    const data: { publications: { nodes: { id: string; name: string }[] } } = await client.request(
      `query Publications { publications(first: 25) { nodes { id name } } }`,
    );
    publicationId = data.publications.nodes.find((p) => /online store/i.test(p.name))?.id;
  } catch {
    return false;
  }
  if (!publicationId) return false;

  try {
    const data: { publishablePublish: { userErrors: UserError[] } } = await client.request(
      `mutation Publish($id: ID!, $input: [PublicationInput!]!) {
         publishablePublish(id: $id, input: $input) { userErrors { field message } }
       }`,
      { id: productId, input: [{ publicationId }] },
    );
    assertNoUserErrors("publishablePublish", data.publishablePublish.userErrors);
    return true;
  } catch {
    return false;
  }
}

// --- Media --------------------------------------------------------------------

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

/**
 * Upload local image files and attach them to a product, in the order given.
 *
 * Order is the point: WhatsApp delivers a photo burst through the bridge's
 * strictly sequential outbox, so arrival order IS the order the owner shot
 * them in, and the first photo becomes the product's cover. Uploads therefore
 * run one at a time — a concurrent map would be faster and would silently
 * shuffle the gallery.
 *
 * Returns how many made it. A partial result is reported rather than thrown:
 * losing the last two photos of a set is not a reason to undo the eight that
 * landed, or to replay the whole turn.
 */
export async function uploadProductPhotos(
  client: ShopifyClient,
  productId: string,
  files: { path: string; alt?: string | null }[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ uploaded: number; failed: number }> {
  let uploaded = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const bytes = await readFile(file.path);
      const filename = basename(file.path);
      const mimeType = mimeTypeFor(filename);

      const staged: {
        stagedUploadsCreate: { stagedTargets: StagedTarget[]; userErrors: UserError[] };
      } = await client.request(
        `mutation Stage($input: [StagedUploadInput!]!) {
           stagedUploadsCreate(input: $input) {
             stagedTargets { url resourceUrl parameters { name value } }
             userErrors { field message }
           }
         }`,
        {
          input: [
            {
              filename,
              mimeType,
              resource: "IMAGE",
              httpMethod: "POST",
              fileSize: String(bytes.byteLength),
            },
          ],
        },
      );

      assertNoUserErrors("stagedUploadsCreate", staged.stagedUploadsCreate.userErrors);
      const target = staged.stagedUploadsCreate.stagedTargets[0];
      if (!target) throw new ShopifyError("stagedUploadsCreate returned no target");

      const form = new FormData();
      // The signed parameters MUST precede the file field; the storage backend
      // reads them in order and rejects the upload if the file comes first.
      for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
      form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

      const upload = await fetchImpl(target.url, { method: "POST", body: form });
      if (!upload.ok) {
        throw new ShopifyError(`Staged upload failed with ${upload.status}`);
      }

      const attached: {
        productCreateMedia: { mediaUserErrors: UserError[] };
      } = await client.request(
        `mutation AttachMedia($productId: ID!, $media: [CreateMediaInput!]!) {
           productCreateMedia(productId: $productId, media: $media) {
             mediaUserErrors { field message }
           }
         }`,
        {
          productId,
          media: [
            {
              originalSource: target.resourceUrl,
              mediaContentType: "IMAGE",
              ...(file.alt ? { alt: file.alt.slice(0, 512) } : {}),
            },
          ],
        },
      );
      assertNoUserErrors("productCreateMedia", attached.productCreateMedia.mediaUserErrors);
      uploaded++;
    } catch {
      failed++;
    }
  }

  return { uploaded, failed };
}

// --- Helpers ------------------------------------------------------------------

async function refetch(client: ShopifyClient, productId: string): Promise<ShopifyProduct> {
  const data: { product: RawProduct | null } = await client.request(
    `${PRODUCT_FIELDS}
     query Refetch($id: ID!) { product(id: $id) { ...ProductFields } }`,
    { id: productId },
  );
  if (!data.product) throw new ShopifyError(`Product ${productId} disappeared after a write`);
  return toProduct(data.product);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ""))];
}

function mimeTypeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}
