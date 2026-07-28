import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import { linkLineFor, previewLineFor } from "./preview.js";
import * as repo from "../data/repo.js";
import type { Product, ProductAttributeUpdates, ProductStatus, TurnContext } from "../types.js";

export const MCP_SERVER_NAME = "vitrina";

/** True when this upsert PUBLISHED the product: it is now active and was not before. */
export function isPublishTransition(
  previous: ProductStatus | undefined,
  next: ProductStatus,
): boolean {
  return next === "active" && previous !== "active";
}

/**
 * No WhatsApp client on purpose: the tools may read and write data, never push
 * a message into the chat. The turn's single reply is runAgentTurn's to send,
 * and photos are relayed as a storefront link (see linkLineFor), never as
 * images — so the tool server has nothing to send them with.
 */
export interface ToolDeps {
  db: DB;
  config: Config;
  ctx: TurnContext;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Compact, model-friendly rendering of a product. */
function describeProduct(p: Product): string {
  const a = p.attributes;
  const parts: string[] = [
    `code=${p.code}`,
    `title=${p.title}`,
    `status=${p.status}`,
    p.price != null ? `price=${p.price} ${p.currency}` : "price=unknown",
  ];
  if (a.neighborhood) parts.push(`neighborhood=${a.neighborhood}`);
  if (a.city) parts.push(`city=${a.city}`);
  if (a.area_m2 != null) parts.push(`area_m2=${a.area_m2}`);
  if (a.bedrooms != null) parts.push(`bedrooms=${a.bedrooms}`);
  if (a.bathrooms != null) parts.push(`bathrooms=${a.bathrooms}`);
  if (a.admin_fee != null) parts.push(`admin_fee=${a.admin_fee}`);
  if (a.estrato != null) parts.push(`estrato=${a.estrato}`);
  if (a.floor != null) parts.push(`floor=${a.floor}`);
  if (a.elevator != null) parts.push(`elevator=${a.elevator}`);
  if (a.levels != null) parts.push(`levels=${a.levels}`);
  if (a.negotiable != null) parts.push(`negotiable=${a.negotiable}`);
  if (a.features && a.features.length > 0) parts.push(`features=[${a.features.join("; ")}]`);
  if (p.description) parts.push(`description=${p.description}`);
  return parts.join(" | ");
}

/**
 * Render search results for the model, scores included.
 *
 * The scores are the whole point of showing them: the search now answers with
 * approximate matches, so SOMETHING coming back no longer means the request was
 * met. Without the number the agent cannot tell "this is the house you asked
 * about" from "this is the only thing we have in that price range", and the
 * failure mode is confidently offering a customer a property in the wrong
 * sector.
 *
 * The caveat rides in the tool result rather than only in the system prompt
 * because a result travels next to the data on every call — including turns
 * where the prompt is far back in a resumed transcript.
 */
export function renderSearchHits(config: Config, hits: repo.SearchHit[]): string {
  if (hits.length === 0) {
    return "No matching active products. Offer to save the inquiry as a lead.";
  }

  const lines = hits.map(
    (hit) =>
      `match=${Math.round(hit.score * 100)}% | ${describeProduct(hit.product)}` +
      linkLineFor(config, hit.product),
  );

  const bestScore = hits[0]?.score ?? 1;
  if (bestScore < repo.CONFIDENT_MATCH_SCORE) {
    lines.unshift(
      "APPROXIMATE MATCHES ONLY — nothing in the catalog closely matches what was asked. Do NOT present these as if they met the request. Say plainly that there is nothing exact, offer them as alternatives if they are worth mentioning, and offer to save the inquiry as a lead.",
    );
  }
  return lines.join("\n");
}

/**
 * Build the in-process MCP server exposing the tools for this turn. Customer
 * tools are always present; owner tools are added only for the owner role. The
 * acting phone number is taken from context, never from the model.
 */
export function buildToolServer(deps: ToolDeps) {
  const { db, config, ctx } = deps;

  const searchCatalog = tool(
    "search_catalog",
    "Search the ACTIVE product catalog. Returns products ranked by relevance, each with its facts, a 'match' percentage and a 'link' to its page on the storefront. Text is matched loosely — spelling, accents and word breaks do not have to agree — so a result is a CANDIDATE, not proof the request was met: read the match percentage and judge whether it actually answers what was asked. 100% means every word asked for was found; anything under 80% is related, not equivalent. The percentage is for your judgement only, never mention it. An empty result means the catalog genuinely has nothing like it. Use this before answering any question about availability, price, or features. Never answer product facts from memory.",
    {
      query: z.string().optional().describe("Free-text search over title, description, neighborhood, features"),
      min_price: z.number().optional().describe("Minimum price (COP)"),
      max_price: z.number().optional().describe("Maximum price (COP)"),
      bedrooms: z.number().optional().describe("Minimum number of bedrooms"),
      neighborhood: z.string().optional().describe("Neighborhood or city to match"),
    },
    // min_score is deliberately NOT a parameter: the relevance floor is policy,
    // not something to relax until the search finally returns something.
    async (args) => text(renderSearchHits(config, repo.searchCatalog(db, args))),
  );

  const getProduct = tool(
    "get_product",
    "Get a single product by its code, including all facts, how many photos its page has, and a 'link' to that page on the storefront. Use this when the customer references a specific code.",
    { code: z.string().describe("The product code") },
    async ({ code }) => {
      const product = repo.getProductByCode(db, code);
      if (!product) return text(`No product found with code ${code}.`);
      const photos = repo.getProductPhotos(db, product.id);
      return text(
        `${describeProduct(product)} | photos_available=${photos.length}` +
          linkLineFor(config, product),
      );
    },
  );

  const saveLead = tool(
    "save_lead",
    "Save a lead for the current customer. Use type 'visit_request' to record a request to schedule a visit, or 'inquiry' for a general interest to follow up. The phone number is taken from context automatically.",
    {
      type: z.enum(["inquiry", "visit_request"]).describe("Kind of lead"),
      name: z.string().optional().describe("Customer name if provided"),
      note: z.string().optional().describe("Free-text note: budget, preferences, requested time, etc."),
      product_code: z.string().optional().describe("Product code the lead is about, if any"),
    },
    async ({ type, name, note, product_code }) => {
      const lead = repo.insertLead(db, {
        phone: ctx.phone,
        type,
        name,
        note,
        product_code,
      });
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

  const upsertProduct = tool(
    "upsert_product",
    "Create a draft product or update an existing one by code. This is a MERGE, not a rewrite: pass ONLY the fields you are setting or changing — omitted fields keep their stored value, and attributes_json merges key by key into the stored attributes. To change only the status, pass just code and status. attributes_json is a JSON object of attributes (keys: area_m2 (built area m²), lot_m2 (lot size m²), bedrooms, bathrooms, neighborhood, city, features[], admin_fee (monthly COP), property_tax (annual predial COP), estrato, levels, floor, elevator, negotiable); every fact the owner states that has a key here MUST go in attributes_json — the storefront only renders these, so a fact left in the description alone is invisible. Include ONLY attributes the owner explicitly stated — never infer or complete one the owner did not give. To REMOVE an attribute that is stored but wrong or was never stated, pass an explicit null for that key, e.g. {\"bathrooms\":null} — omitting the key leaves the stored value untouched, so null is the only way to clear one. Set status to 'active' to publish it to the storefront. While it is not active, the result includes a preview link to send to the OWNER so they can see the page before publishing.",
    {
      code: z.string().describe("Product code (required, unique identifier)"),
      title: z.string().optional(),
      description: z.string().optional(),
      price: z.number().optional().describe("Price in COP"),
      status: z.enum(["draft", "active", "sold", "inactive"]).optional(),
      attributes_json: z
        .string()
        .optional()
        .describe("JSON object of attributes to merge, e.g. {\"bedrooms\":3,\"neighborhood\":\"Belén\"}"),
    },
    async ({ code, title, description, price, status, attributes_json }) => {
      let attributes: ProductAttributeUpdates | undefined;
      if (attributes_json) {
        try {
          attributes = JSON.parse(attributes_json) as ProductAttributeUpdates;
        } catch {
          return text("attributes_json was not valid JSON. Ask again or send it differently.");
        }
      }
      const previousStatus = repo.getProductByCode(db, code)?.status;
      const { product, created } = repo.upsertProduct(
        db,
        { code, title, description, price, status, attributes },
        ctx.phone,
      );
      // Publishing marks the end of a unit of work: ask runAgentTurn to start
      // the next message on a fresh session, so the history stays lean and one
      // product's details cannot bleed into the next one.
      if (isPublishTransition(previousStatus, product.status)) ctx.sessionAfterTurn = "reset";
      return text(
        `${created ? "Created" : "Updated"} product: ${describeProduct(product)}` +
          previewLineFor(config, product),
      );
    },
  );

  const attachPendingPhotos = tool(
    "attach_pending_photos",
    "Attach the photos this owner recently sent in this chat (not yet attached to any product) to the given product code. Use after the owner sends a listing's photos.",
    { code: z.string().describe("Product code to attach the pending photos to") },
    async ({ code }) => {
      const product = repo.getProductByCode(db, code);
      if (!product) return text(`No product found with code ${code}. Create it first with upsert_product.`);
      const count = repo.attachPendingPhotos(db, ctx.phone, product.id);
      return text(
        count > 0
          ? `Attached ${count} photo(s) to product ${code}.`
          : `No pending photos from this chat to attach.`,
      );
    },
  );

  const listProductsTool = tool(
    "list_products",
    "List products, optionally filtered by status (draft, active, sold, inactive).",
    { status: z.enum(["draft", "active", "sold", "inactive"]).optional() },
    async ({ status }) => {
      const products = repo.listProducts(db, status);
      if (products.length === 0) return text("No products found.");
      return text(products.map(describeProduct).join("\n"));
    },
  );

  const listLeadsTool = tool(
    "list_leads",
    "List captured leads (inquiries and visit requests), optionally limited to the last N days.",
    { since_days: z.number().optional().describe("Only leads from the last N days") },
    async ({ since_days }) => {
      const leads = repo.listLeads(db, since_days);
      if (leads.length === 0) return text("No leads found.");
      return text(
        leads
          .map(
            (l) =>
              `#${l.id} ${l.type} phone=${l.phone} code=${l.product_code ?? "-"} name=${l.name ?? "-"} note=${l.note ?? "-"} at=${l.created_at}`,
          )
          .join("\n"),
      );
    },
  );

  const ownerTools = [
    ...customerTools,
    upsertProduct,
    attachPendingPhotos,
    listProductsTool,
    listLeadsTool,
  ];

  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: ownerTools }),
    toolNames: ownerTools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
  };
}
