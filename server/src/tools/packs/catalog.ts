import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CONFIDENT_MATCH_SCORE,
  hasStock,
  MAX_SEARCH_RESULTS,
  type SearchHit,
} from "../../shopify/rank.js";
import type { ShopifyProduct, ShopifyVariant } from "../../shopify/types.js";
import { failure, text, type ToolContext, type ToolFactory } from "../factory.js";
import type { CatalogPort } from "../ports.js";

/**
 * The catalog toolpack: everything that reads or writes products, variants and
 * stock. Policy only — which refusals happen before a mutation is sent, and
 * what the model reads back — with every call going through CatalogPort.
 *
 * `shopify/rank.ts` is imported for its scoring CONSTANTS and its two pure
 * predicates. It holds no client and reaches nothing: it is the ranking policy
 * the port's results already carry, and the thresholds a result line is
 * rendered against.
 */

/**
 * Business literals inside the descriptions, with the values this store uses.
 *
 * A definition's `prompt.slots` overrides any of them, which is what lets a
 * second business change the example SKUs and option axes its agent is shown
 * without a deploy. Neither shipped definition sets one, so every description
 * renders to exactly the string it replaced.
 */
const CATALOG_SLOTS = {
  example_variants_json:
    '[{"sku":"CAM-NEG-M","price":80000,"option_values":["M","Negro"],"quantity":10}]',
  example_option_names: '["Talla","Color"]',
  example_product_types: "Camiseta, Zapato",
  example_axis_variants_json:
    '[{"sku":"062AC-LV","price":13800,"option_values":["5 cm","8 cm"],"quantity":10}]',
  example_option_value_typo: '"7,5 cm" is not "7.5 cm"',
} as const;

/**
 * True when this update PUBLISHED the product: it is now active and was not
 * before. Publishing marks the end of a unit of work, so the conversation
 * resets and one product's details cannot bleed into the next.
 */
export function isPublishTransition(previous: string | undefined, next: string): boolean {
  return next === "ACTIVE" && previous !== "ACTIVE";
}

export function describeVariant(variant: ShopifyVariant): string {
  const parts = [
    variant.sku ? `sku=${variant.sku}` : "sku=none",
    `name=${variant.title}`,
    `price=${variant.price}`,
  ];
  if (variant.inventoryTracked) parts.push(`stock=${variant.inventoryQuantity ?? 0}`);
  else parts.push("stock=untracked");
  return parts.join(" ");
}

/** Compact, model-friendly rendering of a product. */
export function describeProduct(product: ShopifyProduct): string {
  const parts: string[] = [
    `handle=${product.handle}`,
    `title=${product.title}`,
    `status=${product.status}`,
  ];
  if (product.productType) parts.push(`type=${product.productType}`);
  if (product.vendor) parts.push(`vendor=${product.vendor}`);
  if (product.totalInventory !== null) parts.push(`total_stock=${product.totalInventory}`);
  if (product.tags.length > 0) parts.push(`tags=[${product.tags.join("; ")}]`);
  parts.push(`photos=${product.mediaCount}`);
  parts.push(`variants=[${product.variants.map(describeVariant).join(" | ")}]`);
  if (product.onlineStoreUrl) parts.push(`url=${product.onlineStoreUrl}`);
  if (product.description) parts.push(`description=${product.description.slice(0, 400)}`);
  return parts.join(" | ");
}

/**
 * Render search results for the model, scores included.
 *
 * The scores are the whole point of showing them: the search answers with
 * approximate matches, so SOMETHING coming back no longer means the request was
 * met. Without the number the agent cannot tell "this is the shirt you asked
 * about" from "this is the only black thing we sell", and the failure mode is
 * confidently offering the wrong product.
 *
 * The caveat rides in the tool result rather than only in the system prompt
 * because a result travels next to the data on every call — including turns
 * where the prompt is far back in a resumed transcript.
 */
export function renderSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "No matching products for sale. Offer to save the inquiry as a lead.";
  }

  const lines = hits.map((hit) => {
    const stock = hasStock(hit.product) ? "" : " | SOLD OUT — do not offer it as available";
    return `match=${Math.round(hit.score * 100)}% | ${describeProduct(hit.product)}${stock}`;
  });

  const bestScore = hits[0]?.score ?? 1;
  if (bestScore < CONFIDENT_MATCH_SCORE) {
    lines.unshift(
      "APPROXIMATE MATCHES ONLY — nothing in the catalog closely matches what was asked. Do NOT present these as if they met the request. Say plainly that there is nothing exact, offer them as alternatives if they are worth mentioning, and offer to save the inquiry as a lead.",
    );
  }
  return lines.join("\n");
}

/**
 * Render the owner's inventory report.
 *
 * An empty answer carries the shape of the question that produced it. Without
 * that, an answer meaning "no DRAFTS" is indistinguishable from "no products
 * anywhere", and an agent that called this three times over three statuses adds
 * the three sentences up into a confident, wrong "no tenemos nada de eso".
 *
 * The match percentage appears only when text was actually asked for: against
 * no query at all every row scores 100%, which is noise on an inventory listing.
 */
export function renderProductList(
  hits: SearchHit[],
  filters: { status?: string; query?: string },
  truncated = false,
): string {
  const constraints = [
    filters.status ? `status=${filters.status}` : "",
    filters.query ? `matching "${filters.query}"` : "",
  ].filter(Boolean);

  if (hits.length === 0) {
    if (constraints.length === 0) return "No products at all: the catalog is empty.";
    return (
      `No products with ${constraints.join(" ")}. This answer is scoped to that filter ` +
      `and says nothing about products outside it — it does not mean the catalog has none.`
    );
  }

  const lines = hits.map(
    (hit) => (filters.query ? `match=${Math.round(hit.score * 100)}% | ` : "") + describeProduct(hit.product),
  );
  if (truncated) {
    lines.push(
      "NOTE: the catalog is larger than one fetch and this list is incomplete. Say so rather than presenting it as the whole inventory.",
    );
  }
  return lines.join("\n");
}

/**
 * A variant is ONE combination of the product's option axes, and the three
 * things that can go wrong when adding one are all decidable before any
 * mutation is sent. Exported and pure so they are tested directly.
 */
export interface VariantDraft {
  sku?: string;
  price: number;
  option_values?: string[];
  quantity?: number;
}

/** The combination key a variant occupies, e.g. `Diámetro=5 cm|Altura=8 cm`. */
function combinationKey(axes: string[], values: (string | undefined)[]): string {
  return axes.map((name, i) => `${name}=${values[i] ?? ""}`).join("|");
}

/**
 * Why these variants cannot be added to this product, or null when they can.
 *
 * A wrong option_values count is the dangerous one: Shopify matches them
 * POSITIONALLY, so a variant that sends one value for a two-axis product does
 * not error — it produces a variant whose height landed in the diameter axis.
 */
export function whyVariantsCannotBeAdded(
  product: ShopifyProduct,
  variants: VariantDraft[],
): string | null {
  const axes = product.options.map((o) => o.name);
  if (axes.length === 0) {
    return `${product.handle} has no option axes (no sizes or colours), so a variant cannot be added to it. Adding one means recreating the product with its axes — do that in the Shopify admin.`;
  }
  const wrong = variants.find((v) => (v.option_values ?? []).length !== axes.length);
  if (wrong) {
    return `${product.handle} has ${axes.length} option axes (${axes.join(", ")}), so every variant needs exactly ${axes.length} option_values in that order. One variant sent ${(wrong.option_values ?? []).length}.`;
  }
  const existing = new Set(
    product.variants.map((v) =>
      combinationKey(
        axes,
        axes.map((name) => v.selectedOptions.find((o) => o.name === name)?.value),
      ),
    ),
  );
  const duplicate = variants.find((v) => existing.has(combinationKey(axes, v.option_values ?? [])));
  if (duplicate) {
    return `${product.handle} already has the combination ${(duplicate.option_values ?? []).join(" / ")}. Nothing was added — use update_product to change the one that exists.`;
  }
  return null;
}

/**
 * Option values these variants would introduce that the product has never used.
 *
 * A legitimate new size and a typo are indistinguishable here — "7,5 cm" and
 * "7.5 cm" are simply two different values to Shopify — so this reports the
 * fact and leaves the judgement to the owner, who is the only one who can make
 * it. Silence would let a typo become a permanent axis value.
 */
export function newOptionValues(product: ShopifyProduct, variants: VariantDraft[]): string[] {
  const introduced: string[] = [];
  for (const [i, axis] of product.options.entries()) {
    for (const v of variants) {
      const value = v.option_values?.[i];
      const label = `${axis.name}="${value}"`;
      if (value && !axis.values.includes(value) && !introduced.includes(label)) {
        introduced.push(label);
      }
    }
  }
  return introduced;
}

/** Parse a variants_json argument, or the message that says why it could not be. */
function parseVariants(json: string): { variants: VariantDraft[] } | { error: string } {
  let variants: VariantDraft[];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { error: "empty" };
    }
    variants = parsed as VariantDraft[];
  } catch {
    return { error: "invalid" };
  }
  if (variants.some((v) => typeof v.price !== "number")) {
    return { error: "price" };
  }
  return { variants };
}

/** What the publish half of a create or an update reports, given what it managed to do. */
function publishNote(published: boolean): string {
  return published
    ? " Published to the online store."
    : " WARNING: status is ACTIVE but it could not be published to the online store sales channel, so it is NOT visible to customers. Tell the owner to publish it from the Shopify admin.";
}

export const searchCatalog: ToolFactory = (ctx, { catalog }) =>
  tool(
    "search_catalog",
    ctx.describe(
      "Search the products that are FOR SALE. Returns products ranked by relevance, each with its variants, prices, live stock and a 'match' percentage. Text is matched loosely — spelling, accents and word breaks do not have to agree — so a result is a CANDIDATE, not proof the request was met: read the match percentage and judge whether it actually answers what was asked. 100% means every word asked for was found; anything under 80% is related, not equivalent. The percentage is for your judgement only, never mention it. An empty result means the catalog genuinely has nothing like it. Use this before answering any question about availability, price or sizes. Never answer product facts from memory.",
    ),
    {
      query: z.string().optional().describe("Free-text search over title, description, type, tags, sizes and colours"),
      min_price: z.number().optional().describe("Minimum price"),
      max_price: z.number().optional().describe("Maximum price"),
      in_stock_only: z
        .boolean()
        .optional()
        .describe("Only products with stock available right now"),
    },
    // min_score is deliberately NOT a parameter: the relevance floor is policy,
    // not something to relax until the search finally returns something.
    async (args) => {
      try {
        const { hits } = await catalog.search({
          status: "ACTIVE",
          query: args.query,
          minPrice: args.min_price,
          maxPrice: args.max_price,
          inStockOnly: args.in_stock_only,
          limit: MAX_SEARCH_RESULTS,
        });
        return text(renderSearchHits(hits));
      } catch (err) {
        return failure("Searching the catalog", err);
      }
    },
  );

/**
 * `get_product`, in the two forms the registry serves under that one name.
 *
 * A customer must never see a draft: its facts are unreviewed and it is not for
 * sale, and confirming that a hidden product exists is itself a leak — so the
 * customer's form answers a genuine miss and a hidden product identically.
 * Which form an agent gets is decided by the tool its DEFINITION declares.
 * Giving one tool a status parameter instead would move that boundary out of
 * the tool set, where it is structural, and into a value the model fills in.
 */
function getProductTool(ctx: ToolContext, catalog: CatalogPort, options: {
  description: string;
  anyStatus: boolean;
}) {
  return tool(
    "get_product",
    ctx.describe(options.description),
    { ref: z.string().describe(ctx.describe("The product's SKU, handle, or Shopify id")) },
    async ({ ref }) => {
      try {
        const resolved = await catalog.resolve(ref);
        if (!resolved) return text(`No product found for "${ref}".`);
        if (!options.anyStatus && resolved.product.status !== "ACTIVE") {
          return text(`No product found for "${ref}".`);
        }
        return text(describeProduct(resolved.product));
      } catch (err) {
        return failure("Looking up the product", err);
      }
    },
  );
}

export const getProduct: ToolFactory = (ctx, { catalog }) =>
  getProductTool(ctx, catalog, {
    description:
      "Get one product that is for sale, by SKU or handle. Returns its variants, prices and live stock. Use this when the customer names a specific product or code.",
    anyStatus: false,
  });

export const getProductAnyStatus: ToolFactory = (ctx, { catalog }) =>
  getProductTool(ctx, catalog, {
    description:
      "Get one product by SKU, handle, or id — including drafts and archived products. Returns every variant with its price and live stock, the photo count, and the store URL when it is published.",
    anyStatus: true,
  });

export const listProducts: ToolFactory = (ctx, { catalog }) =>
  tool(
    "list_products",
    ctx.describe(
      "The owner's inventory report, across ALL statuses including unpublished drafts and archived products. Filter by status, by text, or both; with no filter it returns the whole catalog. Use this — not search_catalog — whenever the owner asks what they have, because search_catalog only ever sees products that are for sale and a draft is still something they own. Never enumerate statuses to establish absence: an empty result is scoped to the filter you passed and says nothing about anything else.",
    ),
    {
      status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
      query: z.string().optional().describe("Free-text search over title, description, type, tags, sizes and colours"),
    },
    async (args) => {
      try {
        const { hits, truncated } = await catalog.search({
          status: args.status,
          query: args.query,
        });
        return text(renderProductList(hits, args, truncated));
      } catch (err) {
        return failure("Listing products", err);
      }
    },
  );

export const createProduct: ToolFactory = (ctx, { catalog }) =>
  tool(
    "create_product",
    ctx.describe(
      "Create a NEW product in the store. Creates it as a DRAFT unless told otherwise, so the owner can review it before it is for sale. variants_json is a JSON ARRAY of the variants to create, e.g. {{example_variants_json}}. For a product with no sizes or colours, pass a single variant with no option_values and leave option_names empty. option_names lists the option axes in order (e.g. {{example_option_names}}) and EVERY variant must then give exactly that many option_values, in the same order. Only include facts the owner explicitly stated. If the product already exists, use update_product instead — this tool always creates a second one.",
      CATALOG_SLOTS,
    ),
    {
      title: z.string().describe("Product name"),
      description: z.string().optional().describe("Product description"),
      product_type: z
        .string()
        .optional()
        .describe(ctx.describe("e.g. {{example_product_types}}", CATALOG_SLOTS)),
      vendor: z.string().optional().describe("Brand or supplier"),
      tags: z.array(z.string()).optional(),
      status: z.enum(["ACTIVE", "DRAFT"]).optional().describe("Defaults to DRAFT"),
      option_names: z
        .array(z.string())
        .optional()
        .describe(
          ctx.describe(
            "Option axes in order, e.g. {{example_option_names}}. Empty for a single-variant product.",
            CATALOG_SLOTS,
          ),
        ),
      variants_json: z
        .string()
        .describe('JSON array of variants: [{"sku","price","option_values":[],"quantity"}]'),
      location: z.string().optional().describe("Location name or id for the opening stock"),
    },
    async (args) => {
      const parsed = parseVariants(args.variants_json);
      if ("error" in parsed) {
        if (parsed.error === "empty") {
          return text("variants_json must be a non-empty JSON array. Every product needs at least one variant with a price.");
        }
        if (parsed.error === "invalid") {
          return text("variants_json was not valid JSON. Send it again as a JSON array.");
        }
        return text("Every variant needs a numeric price. Ask the owner for the missing one.");
      }
      const variants = parsed.variants;

      try {
        const location = await catalog.location(args.location);
        const product = await catalog.create({
          product: {
            title: args.title,
            description: args.description,
            status: args.status ?? "DRAFT",
            productType: args.product_type,
            vendor: args.vendor,
            tags: args.tags,
          },
          optionNames: args.option_names ?? [],
          variants: variants.map((v) => ({
            sku: v.sku,
            price: v.price,
            optionValues: v.option_values,
            quantity: v.quantity,
          })),
          locationId: location.id,
        });

        let note = "";
        if (product.status === "ACTIVE") {
          note = publishNote(await catalog.publish(product.id));
          ctx.turn.sessionAfterTurn = "reset";
        }
        return text(`Created product: ${describeProduct(product)}${note}`);
      } catch (err) {
        return failure("Creating the product", err);
      }
    },
  );

export const updateProduct: ToolFactory = (ctx, { catalog }) =>
  tool(
    "update_product",
    ctx.describe(
      "Update an EXISTING product, found by SKU, handle or id. This is a MERGE, not a rewrite: pass ONLY the fields you are actually changing, and everything you omit keeps its stored value. To publish, pass just ref and status ACTIVE. To change one variant's price or SKU, pass variant_sku plus the new price. Never rebuild a payload from what you remember of the conversation — re-sending regenerated fields is how correct data gets overwritten with a guess. To change stock, use adjust_inventory, not this tool.",
    ),
    {
      ref: z.string().describe("The product's SKU, handle, or Shopify id"),
      title: z.string().optional(),
      description: z.string().optional(),
      product_type: z.string().optional(),
      vendor: z.string().optional(),
      tags: z.array(z.string()).optional().describe("REPLACES the whole tag list"),
      status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
      variant_sku: z
        .string()
        .optional()
        .describe("Which variant price/new_sku apply to. Required when the product has more than one."),
      price: z.number().optional().describe("New price for that variant"),
      new_sku: z.string().optional().describe("New SKU for that variant"),
    },
    async (args) => {
      try {
        const resolved = await catalog.resolve(args.ref);
        if (!resolved) {
          return text(`No product found for "${args.ref}". Use list_products to find it, or create_product if it is new.`);
        }
        const previousStatus = resolved.product.status;
        const productFields = {
          title: args.title,
          description: args.description,
          status: args.status,
          productType: args.product_type,
          vendor: args.vendor,
          tags: args.tags,
        };
        const touchesProduct = Object.values(productFields).some((v) => v !== undefined);
        const touchesVariant = args.price !== undefined || args.new_sku !== undefined;
        if (!touchesProduct && !touchesVariant) {
          return text("Nothing to update: no fields were given.");
        }

        let product = resolved.product;
        if (touchesProduct) {
          product = await catalog.update(product.id, productFields);
        }

        if (touchesVariant) {
          const variant = args.variant_sku
            ? catalog.variantBySku(product, args.variant_sku)
            : product.variants.length === 1
              ? product.variants[0]
              : resolved.variant;
          if (!variant) {
            return text(
              `Product ${product.handle} has ${product.variants.length} variants: ${product.variants
                .map((v) => v.sku ?? v.title)
                .join(", ")}. Say which one the price or SKU is for.`,
            );
          }
          product = await catalog.updateVariants(product.id, [
            { id: variant.id, price: args.price, sku: args.new_sku },
          ]);
        }

        let note = "";
        if (isPublishTransition(previousStatus, product.status)) {
          note = publishNote(await catalog.publish(product.id));
          // Publishing ends a unit of work: start the next message fresh so one
          // product's details cannot bleed into the next.
          ctx.turn.sessionAfterTurn = "reset";
        }
        return text(`Updated product: ${describeProduct(product)}${note}`);
      } catch (err) {
        return failure("Updating the product", err);
      }
    },
  );

export const deleteProduct: ToolFactory = (ctx, { catalog }) =>
  tool(
    "delete_product",
    ctx.describe(
      "PERMANENTLY delete a product from the store, with all of its variants and photos. This cannot be undone and it is almost never what the owner wants — archiving (update_product with status ARCHIVED) hides a product while keeping its sales history, and is the right answer for 'ya no lo vendemos'. Only call this when the owner has explicitly confirmed deletion for THIS product after you told them it is permanent. You must pass the product's exact handle in confirm_handle, taken from a tool result in this conversation and never guessed.",
    ),
    {
      ref: z.string().describe("The product's SKU, handle, or Shopify id"),
      confirm_handle: z
        .string()
        .describe("The product's exact handle, as proof the right product was identified"),
    },
    async ({ ref, confirm_handle }) => {
      try {
        const resolved = await catalog.resolve(ref);
        if (!resolved) return text(`No product found for "${ref}". Nothing was deleted.`);
        if (resolved.product.handle !== confirm_handle.trim()) {
          // The guard is the whole point of the parameter: a reference that
          // resolved to something other than what the agent thought it was
          // holding is exactly the case where a delete must not go through.
          return text(
            `Refused: "${ref}" resolves to handle "${resolved.product.handle}", not "${confirm_handle}". Nothing was deleted. Confirm which product the owner means.`,
          );
        }
        await catalog.remove(resolved.product.id);
        return text(`Permanently deleted product ${resolved.product.handle} ("${resolved.product.title}").`);
      } catch (err) {
        return failure("Deleting the product", err);
      }
    },
  );

export const addVariant: ToolFactory = (ctx, { catalog }) =>
  tool(
    "add_variant",
    ctx.describe(
      "Add one or more NEW variants (size, colour, dimension…) to a product that ALREADY exists. This is the only way to extend a product's range: update_product changes a variant that is already there, and create_product would make a second product. variants_json is a JSON ARRAY, e.g. {{example_axis_variants_json}}. A variant is ONE combination of the product's option axes, and every variant must give exactly one value per axis, IN THE PRODUCT'S OWN ORDER — call get_product first to read the axes and the values they already use. Reuse an existing value EXACTLY as written ({{example_option_value_typo}}); a new value is allowed and the result says which ones were new. Only include facts the owner explicitly stated — never invent a price.",
      CATALOG_SLOTS,
    ),
    {
      ref: z.string().describe("The product's SKU, handle, or Shopify id"),
      variants_json: z
        .string()
        .describe('JSON array: [{"sku","price","option_values":[],"quantity"}]'),
      location: z.string().optional().describe("Location name or id for the opening stock"),
    },
    async ({ ref, variants_json, location }) => {
      const parsed = parseVariants(variants_json);
      if ("error" in parsed) {
        if (parsed.error === "empty") return text("variants_json must be a non-empty JSON array.");
        if (parsed.error === "invalid") {
          return text("variants_json was not valid JSON. Send it again as a JSON array.");
        }
        return text("Every variant needs a numeric price. Ask the owner for the missing one.");
      }
      const variants = parsed.variants;

      try {
        const resolved = await catalog.resolve(ref);
        if (!resolved) return text(`No product found for "${ref}". Nothing was added.`);
        const product = resolved.product;

        // A product with no option axes has one anonymous default variant, and
        // Shopify cannot attach a second one to it. Saying so beats a mutation
        // that fails with a message about optionValues nobody asked for.
        const refusal = whyVariantsCannotBeAdded(product, variants);
        if (refusal) return text(refusal);
        const axes = product.options.map((o) => o.name);

        const resolvedLocation = await catalog.location(location);
        const updated = await catalog.addVariants({
          productId: product.id,
          optionNames: axes,
          variants: variants.map((v) => ({
            sku: v.sku,
            price: v.price,
            optionValues: v.option_values,
            quantity: v.quantity,
          })),
          locationId: resolvedLocation.id,
        });

        // A legitimate new size and a typo look identical here, so this states
        // the fact rather than guessing which it was.
        const introduced = newOptionValues(product, variants);
        const note =
          introduced.length > 0
            ? ` NEW option values were created: ${introduced.join(", ")} — tell the owner, in case one is a typo.`
            : "";
        return text(
          `Added ${variants.length} variant(s) to ${updated.handle} ("${updated.title}"). It now has ${updated.variants.length} variants.${note}`,
        );
      } catch (err) {
        return failure("Adding the variant", err);
      }
    },
  );

export const getInventory: ToolFactory = (ctx, { catalog }) =>
  tool(
    "get_inventory",
    ctx.describe(
      "Live stock for one product or one variant, broken down by location. Pass a SKU to ask about a single variant, or a handle to get every variant of a product. Always check here before telling the owner a number.",
    ),
    { ref: z.string().describe("SKU, handle, or Shopify id") },
    async ({ ref }) => {
      try {
        const resolved = await catalog.resolve(ref);
        if (!resolved) return text(`No product found for "${ref}".`);

        const variants = resolved.variant ? [resolved.variant] : resolved.product.variants;
        const lines: string[] = [];
        for (const variant of variants) {
          if (!variant.inventoryTracked) {
            lines.push(`${describeVariant(variant)} | stock is not tracked for this variant`);
            continue;
          }
          const levels = await catalog.inventoryLevels(variant.inventoryItemId);
          const breakdown =
            levels.length > 0
              ? levels.map((l) => `${l.locationName}=${l.available}`).join(", ")
              : "no stock recorded at any location";
          lines.push(`${describeVariant(variant)} | ${breakdown}`);
        }
        return text(`${resolved.product.handle} ("${resolved.product.title}")\n${lines.join("\n")}`);
      } catch (err) {
        return failure("Reading inventory", err);
      }
    },
  );

export const adjustInventory: ToolFactory = (ctx, { catalog }) =>
  tool(
    "adjust_inventory",
    ctx.describe(
      "Change how many units of ONE variant are in stock, at one location. Pass set_to when the owner states the resulting count ('quedan 11') and delta when they state a movement ('vendí 3', 'llegaron 20'). PREFER set_to whenever the owner's words give you the resulting number: it is checked against the current count and fails safely if someone else changed stock in the meantime, whereas a delta cannot tell a repeat from a real second movement. Pass exactly one of the two. sku is required — a product with several sizes has several counts, so never adjust a product as a whole.",
    ),
    {
      sku: z.string().describe("The variant's SKU"),
      delta: z.number().int().optional().describe("Signed movement, e.g. -3 for a sale of 3"),
      set_to: z.number().int().min(0).optional().describe("The resulting absolute count"),
      location: z.string().optional().describe("Location name or id; only needed with several locations"),
      reason: z
        .string()
        .optional()
        .describe("One of: correction, received, damaged, restock, shrinkage. Defaults to correction."),
    },
    async ({ sku, delta, set_to, location, reason }) => {
      if ((delta === undefined) === (set_to === undefined)) {
        return text("Pass exactly one of delta or set_to.");
      }
      try {
        const resolved = await catalog.resolve(sku);
        if (!resolved) return text(`No variant found with SKU "${sku}".`);
        const variant = resolved.variant ?? catalog.variantBySku(resolved.product, sku);
        if (!variant) {
          return text(
            `"${sku}" is a product, not a variant. Its variants are: ${resolved.product.variants
              .map((v) => v.sku ?? v.title)
              .join(", ")}. Say which one.`,
          );
        }
        if (!variant.inventoryTracked) {
          return text(
            `Stock is not tracked for ${sku}, so there is no count to change. Tell the owner to enable inventory tracking for it in Shopify.`,
          );
        }

        const resolvedLocation = await catalog.location(location);

        if (set_to !== undefined) {
          const levels = await catalog.inventoryLevels(variant.inventoryItemId);
          const current = levels.find((l) => l.locationId === resolvedLocation.id)?.available ?? 0;
          await catalog.setInventory({
            inventoryItemId: variant.inventoryItemId,
            locationId: resolvedLocation.id,
            quantity: set_to,
            compareQuantity: current,
            reason,
          });
          return text(`Stock for ${sku} at ${resolvedLocation.name} is now ${set_to} (was ${current}).`);
        }

        // The key is taken HERE, on the call that actually moves stock: a
        // set_to is a compare-and-set and needs none, and spending one on it
        // would shift every later key on a retry that took a different branch.
        const after = await catalog.adjustInventory({
          inventoryItemId: variant.inventoryItemId,
          locationId: resolvedLocation.id,
          delta: delta!,
          idempotencyKey: ctx.nextInventoryKey(),
          reason,
        });
        return text(
          after === null
            ? `Adjusted ${sku} at ${resolvedLocation.name} by ${delta}.`
            : `Adjusted ${sku} at ${resolvedLocation.name} by ${delta}; there are now ${after}.`,
        );
      } catch (err) {
        return failure("Adjusting inventory", err);
      }
    },
  );

export const listLocations: ToolFactory = (ctx, { catalog }) =>
  tool(
    "list_locations",
    ctx.describe(
      "The store's inventory locations. Use it when a stock question is ambiguous because the store has more than one, or when the owner asks where something is stocked.",
    ),
    {},
    async () => {
      try {
        const locations = await catalog.locations();
        if (locations.length === 0) return text("The store has no active locations.");
        return text(locations.map((l) => `${l.name} (${l.id})`).join("\n"));
      } catch (err) {
        return failure("Listing locations", err);
      }
    },
  );
