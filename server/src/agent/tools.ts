import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import * as repo from "../data/repo.js";
import * as catalog from "../shopify/catalog.js";
import type { CatalogCache } from "../shopify/cache.js";
import { ShopifyError, type ShopifyClient } from "../shopify/client.js";
import {
  CONFIDENT_MATCH_SCORE,
  hasStock,
  MAX_SEARCH_RESULTS,
  rankProducts,
  type SearchHit,
} from "../shopify/rank.js";
import { PRODUCT_STATUSES, type ShopifyProduct, type ShopifyVariant } from "../shopify/types.js";
import type { TurnContext } from "../types.js";

export const MCP_SERVER_NAME = "vitrina";

/**
 * True when this update PUBLISHED the product: it is now active and was not
 * before. Publishing marks the end of a unit of work, so the conversation
 * resets and one product's details cannot bleed into the next.
 */
export function isPublishTransition(previous: string | undefined, next: string): boolean {
  return next === "ACTIVE" && previous !== "ACTIVE";
}

/**
 * No WhatsApp client on purpose: the tools may read and write data, never push
 * a message into the chat. The turn's single reply is runAgentTurn's to send.
 */
export interface ToolDeps {
  db: DB;
  config: Config;
  shopify: ShopifyClient;
  cache: CatalogCache;
  ctx: TurnContext;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Render a Shopify error as something the agent can act on, not a stack trace. */
function failure(action: string, err: unknown): { content: { type: "text"; text: string }[] } {
  if (err instanceof ShopifyError) return text(`${action} failed. ${err.message}`);
  throw err;
}

function describeVariant(variant: ShopifyVariant): string {
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
 * Build the in-process MCP server exposing the tools for this turn. Customer
 * tools are always present; owner tools are added only for the owner role. The
 * acting phone number and role are taken from context, never from the model.
 */
export function buildToolServer(deps: ToolDeps) {
  const { db, config, shopify, cache, ctx } = deps;

  /**
   * Per-turn counter for inventory idempotency keys.
   *
   * ctx.turnKey is stable across retries of the same batch, which is what makes
   * a replayed delta safe. But two adjustments in ONE turn ("vendí 3 negras y 2
   * blancas") would then share a key and Shopify would silently discard the
   * second as a duplicate — so each call takes the next slot. The sequence
   * lines up on a retry because the turn re-runs from the same messages.
   */
  let adjustSequence = 0;

  /** Fetch, rank, and re-read the winners live so prices and stock are current. */
  const searchAndRefresh = async (
    shopifyQuery: string,
    filters: Parameters<typeof rankProducts>[1],
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> => {
    const snapshot = await cache.snapshot(shopifyQuery);
    const ranked = rankProducts(snapshot.products, filters);
    if (ranked.length === 0) return { hits: [], truncated: snapshot.truncated };

    // One call for the whole result set: the cache is fine for deciding WHICH
    // products answer the question and not fine for the two facts the answer
    // then quotes.
    const fresh = await catalog.refreshProducts(
      shopify,
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
  };

  const searchCatalog = tool(
    "search_catalog",
    "Search the products that are FOR SALE. Returns products ranked by relevance, each with its variants, prices, live stock and a 'match' percentage. Text is matched loosely — spelling, accents and word breaks do not have to agree — so a result is a CANDIDATE, not proof the request was met: read the match percentage and judge whether it actually answers what was asked. 100% means every word asked for was found; anything under 80% is related, not equivalent. The percentage is for your judgement only, never mention it. An empty result means the catalog genuinely has nothing like it. Use this before answering any question about availability, price or sizes. Never answer product facts from memory.",
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
        const { hits } = await searchAndRefresh("status:ACTIVE", {
          ...args,
          limit: MAX_SEARCH_RESULTS,
        });
        return text(renderSearchHits(hits));
      } catch (err) {
        return failure("Searching the catalog", err);
      }
    },
  );

  /**
   * One name, two behaviours, chosen by the role the SYSTEM assigned — not by
   * an argument the model fills. A customer must never see a draft: its facts
   * are unreviewed and it is not for sale. Giving the customer's tool a status
   * parameter instead would move that boundary from the tool set, where it is
   * structural, into a value the model decides.
   */
  const getProduct = tool(
    "get_product",
    ctx.role === "owner"
      ? "Get one product by SKU, handle, or id — including drafts and archived products. Returns every variant with its price and live stock, the photo count, and the store URL when it is published."
      : "Get one product that is for sale, by SKU or handle. Returns its variants, prices and live stock. Use this when the customer names a specific product or code.",
    { ref: z.string().describe("The product's SKU, handle, or Shopify id") },
    async ({ ref }) => {
      try {
        const resolved = await catalog.resolveProduct(shopify, ref);
        if (!resolved) return text(`No product found for "${ref}".`);
        if (ctx.role !== "owner" && resolved.product.status !== "ACTIVE") {
          // Same answer as a genuine miss: confirming that a hidden product
          // exists is itself a leak.
          return text(`No product found for "${ref}".`);
        }
        return text(describeProduct(resolved.product));
      } catch (err) {
        return failure("Looking up the product", err);
      }
    },
  );

  const saveLead = tool(
    "save_lead",
    "Save a lead for the current customer. Use 'back_in_stock' when they want to be told when something sold out returns, 'inquiry' for interest in something we do not have, and 'follow_up' when they simply want to be contacted. The phone number is taken from context automatically.",
    {
      type: z.enum(["inquiry", "back_in_stock", "follow_up"]).describe("Kind of lead"),
      name: z.string().optional().describe("Customer name if provided"),
      note: z.string().optional().describe("Free-text note: what they wanted, size, budget, etc."),
      product_code: z.string().optional().describe("SKU or handle the lead is about, if any"),
    },
    async ({ type, name, note, product_code }) => {
      const lead = repo.insertLead(db, { phone: ctx.phone, type, name, note, product_code });
      return text(`Saved lead #${lead.id} (${type}) for the customer.`);
    },
  );

  const customerTools = [searchCatalog, getProduct, saveLead];

  if (ctx.role !== "owner") {
    return {
      server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: customerTools }),
      toolNames: customerTools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
    };
  }

  // --- Owner-only tools -----------------------------------------------------

  const listProducts = tool(
    "list_products",
    "The owner's inventory report, across ALL statuses including unpublished drafts and archived products. Filter by status, by text, or both; with no filter it returns the whole catalog. Use this — not search_catalog — whenever the owner asks what they have, because search_catalog only ever sees products that are for sale and a draft is still something they own. Never enumerate statuses to establish absence: an empty result is scoped to the filter you passed and says nothing about anything else.",
    {
      status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
      query: z.string().optional().describe("Free-text search over title, description, type, tags, sizes and colours"),
    },
    async (args) => {
      try {
        const { hits, truncated } = await searchAndRefresh(
          args.status ? `status:${args.status}` : "",
          { query: args.query },
        );
        return text(renderProductList(hits, args, truncated));
      } catch (err) {
        return failure("Listing products", err);
      }
    },
  );

  const createProduct = tool(
    "create_product",
    "Create a NEW product in the store. Creates it as a DRAFT unless told otherwise, so the owner can review it before it is for sale. variants_json is a JSON ARRAY of the variants to create, e.g. [{\"sku\":\"CAM-NEG-M\",\"price\":80000,\"option_values\":[\"M\",\"Negro\"],\"quantity\":10}]. For a product with no sizes or colours, pass a single variant with no option_values and leave option_names empty. option_names lists the option axes in order (e.g. [\"Talla\",\"Color\"]) and EVERY variant must then give exactly that many option_values, in the same order. Only include facts the owner explicitly stated. If the product already exists, use update_product instead — this tool always creates a second one.",
    {
      title: z.string().describe("Product name"),
      description: z.string().optional().describe("Product description"),
      product_type: z.string().optional().describe("e.g. Camiseta, Zapato"),
      vendor: z.string().optional().describe("Brand or supplier"),
      tags: z.array(z.string()).optional(),
      status: z.enum(["ACTIVE", "DRAFT"]).optional().describe("Defaults to DRAFT"),
      option_names: z
        .array(z.string())
        .optional()
        .describe('Option axes in order, e.g. ["Talla","Color"]. Empty for a single-variant product.'),
      variants_json: z
        .string()
        .describe('JSON array of variants: [{"sku","price","option_values":[],"quantity"}]'),
      location: z.string().optional().describe("Location name or id for the opening stock"),
    },
    async (args) => {
      let variants: { sku?: string; price: number; option_values?: string[]; quantity?: number }[];
      try {
        const parsed: unknown = JSON.parse(args.variants_json);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return text("variants_json must be a non-empty JSON array. Every product needs at least one variant with a price.");
        }
        variants = parsed as typeof variants;
      } catch {
        return text("variants_json was not valid JSON. Send it again as a JSON array.");
      }
      if (variants.some((v) => typeof v.price !== "number")) {
        return text("Every variant needs a numeric price. Ask the owner for the missing one.");
      }

      try {
        const location = await catalog.resolveLocation(
          shopify,
          config.shopifyLocationId,
          args.location,
        );
        const product = await catalog.createProduct(shopify, {
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
        cache.invalidate();

        let note = "";
        if (product.status === "ACTIVE") {
          const published = await catalog.publishToOnlineStore(shopify, product.id);
          note = published
            ? " Published to the online store."
            : " WARNING: status is ACTIVE but it could not be published to the online store sales channel, so it is NOT visible to customers. Tell the owner to publish it from the Shopify admin.";
          ctx.sessionAfterTurn = "reset";
        }
        return text(`Created product: ${describeProduct(product)}${note}`);
      } catch (err) {
        return failure("Creating the product", err);
      }
    },
  );

  const updateProduct = tool(
    "update_product",
    "Update an EXISTING product, found by SKU, handle or id. This is a MERGE, not a rewrite: pass ONLY the fields you are actually changing, and everything you omit keeps its stored value. To publish, pass just ref and status ACTIVE. To change one variant's price or SKU, pass variant_sku plus the new price. Never rebuild a payload from what you remember of the conversation — re-sending regenerated fields is how correct data gets overwritten with a guess. To change stock, use adjust_inventory, not this tool.",
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
        const resolved = await catalog.resolveProduct(shopify, args.ref);
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
          product = await catalog.updateProduct(shopify, product.id, productFields);
        }

        if (touchesVariant) {
          const variant = args.variant_sku
            ? catalog.findVariantBySku(product, args.variant_sku)
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
          product = await catalog.updateVariants(shopify, product.id, [
            { id: variant.id, price: args.price, sku: args.new_sku },
          ]);
        }

        cache.invalidate();

        let note = "";
        if (isPublishTransition(previousStatus, product.status)) {
          const published = await catalog.publishToOnlineStore(shopify, product.id);
          note = published
            ? " Published to the online store."
            : " WARNING: status is ACTIVE but it could not be published to the online store sales channel, so it is NOT visible to customers. Tell the owner to publish it from the Shopify admin.";
          // Publishing ends a unit of work: start the next message fresh so one
          // product's details cannot bleed into the next.
          ctx.sessionAfterTurn = "reset";
        }
        return text(`Updated product: ${describeProduct(product)}${note}`);
      } catch (err) {
        return failure("Updating the product", err);
      }
    },
  );

  const deleteProductTool = tool(
    "delete_product",
    "PERMANENTLY delete a product from the store, with all of its variants and photos. This cannot be undone and it is almost never what the owner wants — archiving (update_product with status ARCHIVED) hides a product while keeping its sales history, and is the right answer for 'ya no lo vendemos'. Only call this when the owner has explicitly confirmed deletion for THIS product after you told them it is permanent. You must pass the product's exact handle in confirm_handle, taken from a tool result in this conversation and never guessed.",
    {
      ref: z.string().describe("The product's SKU, handle, or Shopify id"),
      confirm_handle: z
        .string()
        .describe("The product's exact handle, as proof the right product was identified"),
    },
    async ({ ref, confirm_handle }) => {
      try {
        const resolved = await catalog.resolveProduct(shopify, ref);
        if (!resolved) return text(`No product found for "${ref}". Nothing was deleted.`);
        if (resolved.product.handle !== confirm_handle.trim()) {
          // The guard is the whole point of the parameter: a reference that
          // resolved to something other than what the agent thought it was
          // holding is exactly the case where a delete must not go through.
          return text(
            `Refused: "${ref}" resolves to handle "${resolved.product.handle}", not "${confirm_handle}". Nothing was deleted. Confirm which product the owner means.`,
          );
        }
        await catalog.deleteProduct(shopify, resolved.product.id);
        cache.invalidate();
        return text(`Permanently deleted product ${resolved.product.handle} ("${resolved.product.title}").`);
      } catch (err) {
        return failure("Deleting the product", err);
      }
    },
  );

  const getInventory = tool(
    "get_inventory",
    "Live stock for one product or one variant, broken down by location. Pass a SKU to ask about a single variant, or a handle to get every variant of a product. Always check here before telling the owner a number.",
    { ref: z.string().describe("SKU, handle, or Shopify id") },
    async ({ ref }) => {
      try {
        const resolved = await catalog.resolveProduct(shopify, ref);
        if (!resolved) return text(`No product found for "${ref}".`);

        const variants = resolved.variant ? [resolved.variant] : resolved.product.variants;
        const lines: string[] = [];
        for (const variant of variants) {
          if (!variant.inventoryTracked) {
            lines.push(`${describeVariant(variant)} | stock is not tracked for this variant`);
            continue;
          }
          const levels = await catalog.getInventoryLevels(shopify, variant.inventoryItemId);
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

  const adjustInventory = tool(
    "adjust_inventory",
    "Change how many units of ONE variant are in stock, at one location. Pass set_to when the owner states the resulting count ('quedan 11') and delta when they state a movement ('vendí 3', 'llegaron 20'). PREFER set_to whenever the owner's words give you the resulting number: it is checked against the current count and fails safely if someone else changed stock in the meantime, whereas a delta cannot tell a repeat from a real second movement. Pass exactly one of the two. sku is required — a product with several sizes has several counts, so never adjust a product as a whole.",
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
        const resolved = await catalog.resolveProduct(shopify, sku);
        if (!resolved) return text(`No variant found with SKU "${sku}".`);
        const variant = resolved.variant ?? catalog.findVariantBySku(resolved.product, sku);
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

        const resolvedLocation = await catalog.resolveLocation(
          shopify,
          config.shopifyLocationId,
          location,
        );

        if (set_to !== undefined) {
          const levels = await catalog.getInventoryLevels(shopify, variant.inventoryItemId);
          const current = levels.find((l) => l.locationId === resolvedLocation.id)?.available ?? 0;
          await catalog.setInventory(shopify, {
            inventoryItemId: variant.inventoryItemId,
            locationId: resolvedLocation.id,
            quantity: set_to,
            compareQuantity: current,
            reason,
          });
          cache.invalidate();
          return text(`Stock for ${sku} at ${resolvedLocation.name} is now ${set_to} (was ${current}).`);
        }

        adjustSequence += 1;
        const after = await catalog.adjustInventory(shopify, {
          inventoryItemId: variant.inventoryItemId,
          locationId: resolvedLocation.id,
          delta: delta!,
          idempotencyKey: `${ctx.turnKey}:${adjustSequence}`,
          reason,
        });
        cache.invalidate();
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

  const attachPendingPhotos = tool(
    "attach_pending_photos",
    "Upload the photos this owner recently sent in this chat (not yet uploaded to any product) to the given product. Use after the owner sends a product's photos. They are uploaded in the order they arrived, so the first photo the owner sent becomes the product's main image.",
    { ref: z.string().describe("SKU, handle, or Shopify id of the product to upload them to") },
    async ({ ref }) => {
      try {
        const resolved = await catalog.resolveProduct(shopify, ref);
        if (!resolved) {
          return text(`No product found for "${ref}". Create it first with create_product.`);
        }
        const pending = repo.listPendingMedia(db, ctx.phone);
        if (pending.length === 0) return text("No pending photos from this chat to upload.");

        const result = await catalog.uploadProductPhotos(
          shopify,
          resolved.product.id,
          pending.map((media) => ({ path: media.file_path, alt: media.caption })),
        );

        // Only the ones that actually landed are marked, so a partial failure
        // leaves the rest claimable by a second attempt instead of silently
        // dropping them.
        repo.markPendingMediaAttached(
          db,
          pending.slice(0, result.uploaded).map((media) => media.id),
          resolved.product.id,
        );

        if (result.failed > 0) {
          return text(
            `Uploaded ${result.uploaded} photo(s) to ${resolved.product.handle}; ${result.failed} failed and are still pending. Tell the owner some photos did not go through.`,
          );
        }
        return text(`Uploaded ${result.uploaded} photo(s) to ${resolved.product.handle}.`);
      } catch (err) {
        return failure("Uploading photos", err);
      }
    },
  );

  const listLocationsTool = tool(
    "list_locations",
    "The store's inventory locations. Use it when a stock question is ambiguous because the store has more than one, or when the owner asks where something is stocked.",
    {},
    async () => {
      try {
        const locations = await catalog.listLocations(shopify);
        if (locations.length === 0) return text("The store has no active locations.");
        return text(locations.map((l) => `${l.name} (${l.id})`).join("\n"));
      } catch (err) {
        return failure("Listing locations", err);
      }
    },
  );

  const listLeadsTool = tool(
    "list_leads",
    "List captured leads (inquiries, back-in-stock requests and follow-ups), optionally limited to the last N days.",
    { since_days: z.number().optional().describe("Only leads from the last N days") },
    async ({ since_days }) => {
      const leads = repo.listLeads(db, since_days);
      if (leads.length === 0) return text("No leads found.");
      return text(
        leads
          .map(
            (l) =>
              `#${l.id} ${l.type} phone=${l.phone} product=${l.product_code ?? "-"} name=${l.name ?? "-"} note=${l.note ?? "-"} at=${l.created_at}`,
          )
          .join("\n"),
      );
    },
  );

  const ownerTools = [
    ...customerTools,
    listProducts,
    createProduct,
    updateProduct,
    deleteProductTool,
    getInventory,
    adjustInventory,
    attachPendingPhotos,
    listLocationsTool,
    listLeadsTool,
  ];

  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: ownerTools }),
    toolNames: ownerTools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
  };
}

/** Re-exported so tests and the prompt can agree on the legal status values. */
export { PRODUCT_STATUSES };
