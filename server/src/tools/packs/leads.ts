import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { text, type ToolFactory } from "../factory.js";

/**
 * The leads toolpack: what a conversation captures when the catalog cannot
 * answer it. The phone comes from the TURN, never from the model — a lead filed
 * against a number the model made up reaches nobody.
 *
 * Which is also why a turn with NO phone cannot save one: a lead is a promise
 * to contact somebody back, and a caller that has no phone number leaves
 * nothing to contact. Refused in words the model can act on rather than with a
 * placeholder row that a human would later try to call.
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
      const phone = ctx.turn.phone;
      if (!phone) {
        return text(
          "This conversation has no phone number, so a lead saved here could never be answered. Nothing was saved.",
        );
      }
      const { lead, created } = await leads.save({
        phone,
        type,
        name,
        note,
        productCode: product_code,
        // FROM THE TURN, never from the model — the same rule the phone above
        // follows. This is what lets an operator open the exact exchange that
        // produced the lead instead of searching for it by phone number.
        conversationKey: ctx.turn.conversationKey,
        agentId: ctx.turn.agentId,
        turnKey: ctx.turn.turnKey,
      });
      // The model is told WHICH happened, because what it should say next
      // differs: promising a second follow-up to somebody who is asking again
      // is exactly the thing that makes the promise worthless.
      if (!created) {
        return text(
          `This customer already has an open ${type} lead (#${lead.id}, opened ${lead.created_at}) ` +
            "for the same thing, so nothing new was saved. Tell them it is already noted and " +
            "that the team will get back to them — do NOT promise a second, separate follow-up.",
        );
      }
      return text(
        `Saved lead #${lead.id} (${type}) for the customer. The team has been notified.`,
      );
    },
  );

export const listLeads: ToolFactory = (ctx, { leads }) =>
  tool(
    "list_leads",
    ctx.describe(
      "List captured leads (inquiries, back-in-stock requests and follow-ups). By default shows only leads still waiting to be handled; pass include_handled to see closed ones too, and since_days to limit by age.",
    ),
    {
      since_days: z.number().optional().describe("Only leads from the last N days"),
      include_handled: z
        .boolean()
        .optional()
        .describe("Include leads already marked as closed. Defaults to false."),
    },
    async ({ since_days, include_handled }) => {
      // OPEN BY DEFAULT. The owner asking "what leads do I have" means the ones
      // that still owe somebody a contact; answering with every lead ever
      // captured buries those under work already done, which is how the list
      // stops being read. The closed ones stay one parameter away.
      const found = await leads.list({
        ...(since_days !== undefined ? { sinceDays: since_days } : {}),
        openOnly: include_handled !== true,
      });
      if (found.length === 0) {
        return text(
          include_handled === true
            ? "No leads found."
            : "No leads are waiting. (This shows only unhandled ones — pass include_handled to see closed leads too.)",
        );
      }
      return text(
        found
          .map(
            (l) =>
              `#${l.id} [${l.status}] ${l.type} phone=${l.phone} product=${l.product_code ?? "-"} ` +
              `name=${l.name ?? "-"} note=${l.note ?? "-"} at=${l.created_at}` +
              (l.claimed_by ? ` handledBy=${l.claimed_by}` : ""),
          )
          .join("\n"),
      );
    },
  );
