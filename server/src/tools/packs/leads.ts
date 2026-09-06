import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { text, type ToolFactory } from "../factory.js";

/**
 * The leads toolpack: what a conversation captures when the catalog cannot
 * answer it. The phone comes from the TURN, never from the model — a lead filed
 * against a number the model made up reaches nobody.
 */

export const saveLead: ToolFactory = (ctx, { leads }) =>
  tool(
    "save_lead",
    ctx.describe(
      "Save a lead for the current customer. Use 'back_in_stock' when they want to be told when something sold out returns, 'inquiry' for interest in something we do not have, and 'follow_up' when they simply want to be contacted. The phone number is taken from context automatically.",
    ),
    {
      type: z.enum(["inquiry", "back_in_stock", "follow_up"]).describe("Kind of lead"),
      name: z.string().optional().describe("Customer name if provided"),
      note: z.string().optional().describe("Free-text note: what they wanted, size, budget, etc."),
      product_code: z.string().optional().describe("SKU or handle the lead is about, if any"),
    },
    async ({ type, name, note, product_code }) => {
      const lead = await leads.save({
        phone: ctx.turn.phone,
        type,
        name,
        note,
        productCode: product_code,
      });
      return text(`Saved lead #${lead.id} (${type}) for the customer.`);
    },
  );

export const listLeads: ToolFactory = (ctx, { leads }) =>
  tool(
    "list_leads",
    ctx.describe(
      "List captured leads (inquiries, back-in-stock requests and follow-ups), optionally limited to the last N days.",
    ),
    { since_days: z.number().optional().describe("Only leads from the last N days") },
    async ({ since_days }) => {
      const found = await leads.list(since_days);
      if (found.length === 0) return text("No leads found.");
      return text(
        found
          .map(
            (l) =>
              `#${l.id} ${l.type} phone=${l.phone} product=${l.product_code ?? "-"} name=${l.name ?? "-"} note=${l.note ?? "-"} at=${l.created_at}`,
          )
          .join("\n"),
      );
    },
  );
