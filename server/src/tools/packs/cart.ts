import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { variantSellable } from "../../shopify/rank.js";
import { failure, text, type ToolFactory } from "../factory.js";
import type { CartLine } from "../ports.js";
import { describeVariant } from "./catalog.js";

/**
 * The cart toolpack: one tool that turns chosen SKUs into a checkout link.
 *
 * The refusals live here and the URL does not — see CatalogPort.cartUrl. What
 * this pack owns is the policy that nothing unbuyable reaches a link: the
 * checkout silently DROPS an unpublished or sold-out line rather than
 * complaining, so the customer would open a cart missing what they asked for
 * and read it as the shop losing their order.
 *
 * `describeVariant` comes from the catalog pack on purpose: a variant is quoted
 * to the customer the same way it is quoted anywhere else, and a second
 * renderer here would drift from it one field at a time.
 */

const CART_SLOTS = {
  example_cart_items_json: '[{"sku":"062AC-MZ","quantity":1}]',
} as const;

export const buildCart: ToolFactory = (ctx, { catalog }) =>
  tool(
    "build_cart",
    ctx.describe(
      "Build a checkout link with specific products already in the cart. Give it the SKUs the customer chose and how many of each; it returns ONE link that opens Shopify's checkout with exactly those items. Use it once the customer has decided what they want — it is the fastest way to hand them a purchase without leaving WhatsApp. Send the link back EXACTLY as returned and never edit or rebuild it. Every SKU must come from a tool result in this conversation. This does NOT create an order, take payment or reserve stock: the customer completes the purchase on Shopify, and the cart reflects prices and availability at the moment they open it. Do not quote a total of your own — the checkout page is the authority on what they will pay.",
    ),
    {
      items_json: z
        .string()
        .describe(
          ctx.describe("JSON array of what they chose: {{example_cart_items_json}}", CART_SLOTS),
        ),
    },
    async ({ items_json }) => {
      let items: { sku?: string; quantity?: number }[];
      try {
        const parsed: unknown = JSON.parse(items_json);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return text("items_json must be a non-empty JSON array of {sku, quantity}.");
        }
        items = parsed as typeof items;
      } catch {
        return text("items_json was not valid JSON. Send it again as a JSON array.");
      }

      try {
        const lines: CartLine[] = [];
        const summary: string[] = [];

        for (const item of items) {
          const sku = (item.sku ?? "").trim();
          if (!sku) return text("Every item needs a sku. Ask the customer which variant they want.");
          const quantity = Math.trunc(item.quantity ?? 1);
          if (!Number.isFinite(quantity) || quantity < 1) {
            return text(`Quantity for ${sku} must be a whole number of 1 or more.`);
          }

          const resolved = await catalog.resolve(sku);
          // A cart link is built from ONE variant, and only a SKU names one.
          if (!resolved?.variant) {
            return text(
              `No variant found for SKU "${sku}". Nothing was built — search again and use a SKU from the result.`,
            );
          }
          const { product, variant } = resolved;

          // An unpublished product's variant produces a checkout that silently
          // drops the line, so the customer opens a link missing what they asked
          // for. Refuse here instead, where the reason can be said out loud.
          if (!product.onlineStoreUrl) {
            return text(
              `"${product.title}" is not published to the store, so it cannot go in a cart. Nothing was built.`,
            );
          }
          if (!variantSellable(variant)) {
            return text(
              `${describeVariant(variant)} of "${product.title}" is SOLD OUT, so it cannot go in a cart. Nothing was built — tell the customer and offer save_lead type 'back_in_stock'.`,
            );
          }

          lines.push({ product, variant, quantity });
          summary.push(`${quantity} x ${product.title} — ${describeVariant(variant)}`);
        }

        const url = catalog.cartUrl(lines);
        // Prices are shown per line, exactly as Shopify returned them, and no
        // total is computed: shipping, taxes and discounts are settled at
        // checkout, and a total quoted here would eventually disagree with it.
        return text(`Cart link ready:\n${summary.join("\n")}\n\nurl=${url}`);
      } catch (err) {
        return failure("Building the cart", err);
      }
    },
  );
