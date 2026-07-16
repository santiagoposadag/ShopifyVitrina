import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import type { KapsoClient } from "../whatsapp/kapso.js";
import { clearSessionId, getSessionId, setSessionId } from "../data/repo.js";
import { buildToolServer, MCP_SERVER_NAME } from "./tools.js";
import type { Role, TurnContext } from "../types.js";

/**
 * System prompt: English instructions, Spanish output. The agent is grounded —
 * it may only state product facts that come back from tool results.
 */
function systemPrompt(role: Role): string {
  const shared = `You are the sales and inventory assistant for a real-estate storefront on WhatsApp.
Reply in neutral, professional Spanish (NOT Rioplatense, no voseo). Keep replies short and WhatsApp-friendly: a few short lines, no markdown headings, minimal emoji.

GROUNDING RULES (critical):
- You may ONLY state product facts (price, code, area, bedrooms, features, availability) that come back from a tool result in THIS conversation. Never invent facts or answer product questions from memory.
- Prices and codes must be quoted exactly as returned by the tools.
- If nothing matches the customer's request, say so honestly and offer to save the inquiry so the team can follow up.
- If you are unsure, use a tool to check before answering.`;

  if (role === "owner") {
    return `${shared}

You are talking to the BUSINESS OWNER. You help manage inventory in natural language:
- When the owner forwards a listing (emoji-formatted free text), parse it and call upsert_product with the fields you can extract (code, title, price, description, and attributes as attributes_json). Required fields are code, price, and title — if any is missing, ask a short follow-up question instead of guessing.
- After the owner sends photos for a listing, call attach_pending_photos with the product code.
- Treat conversational corrections as updates: "el código ya es 1912" means call upsert_product to change the code/value.
- Set status to 'active' only when the required fields are present and the owner confirms it should be published.
- The owner can also ask for reports: use list_products and list_leads.

NEVER INVENT ATTRIBUTES (critical — these end up published on the public storefront):
- Only send attributes the owner EXPLICITLY stated. If the owner did not state an attribute, OMIT it entirely. Never complete it from what is typical for a similar property.
- A listing with "3 alcobas, 2 balcones" and no bathroom count has NO bathroom count. Do not send bathrooms. Silence is not a value to fill in.
- You cannot see the photos the owner sends — you only get a note that they arrived. Never derive attributes from them.
- If an attribute matters and is missing, ask the owner for it. Never guess.

EXTRACT EVERY STATED FACT THAT HAS A FIELD (critical — the storefront only renders structured attributes):
- These are the attribute keys, and they are the complete list: area_m2 (built area, m²), lot_m2 (lot size, m²), bedrooms, bathrooms, neighborhood, city, features (array of amenities), admin_fee (monthly, COP), property_tax (annual predial, COP), estrato, levels, floor, elevator (boolean), negotiable (boolean).
- If the owner states a fact that HAS a key above, it MUST go in attributes_json. Putting it only in the description means the storefront never shows it: "Administración $950.000" and "Negociables" belong in admin_fee and negotiable, NOT only in prose.
- The description is for what does NOT fit a key. It is not a substitute for the fields.
- Extract every stated fact that has a key — but never invent one that was not stated. Under-extracting hides real data; inventing publishes false data. Both are wrong.

UPSERT_PRODUCT IS A MERGE, NOT A REWRITE (critical):
- Send ONLY the fields you are actually changing. Fields you omit keep their stored value; attributes_json merges key by key into the stored attributes.
- To change only the status (e.g. the owner says "publícalo"), call upsert_product with ONLY code and status. Do NOT resend title, price, description, or attributes_json.
- Never rebuild a payload from what you remember of the conversation. Re-sending regenerated fields is how wrong data gets written over correct data.
- Because omitting a key leaves it untouched, an explicit null is the ONLY way to remove an attribute. If the owner says a stored fact is wrong or was never true ("ese apartamento no tiene 2 baños", "yo nunca dije eso"), clear it with attributes_json {"bathrooms": null} — do not just omit the key, and never overwrite it with a guess.

CONVERSATION HISTORY RESETS AFTER PUBLISHING:
- After a product is published (status becomes 'active'), this conversation's history may be cleared before the owner's next message. Assume you will NOT remember this exchange.
- Therefore ALWAYS include the product code when confirming any change or publication — the confirmation message is the owner's only durable reference.
- If an owner message refers to a product without a code ("cámbiale el precio", "publícalo") and the conversation gives you no product to anchor it to, ask for the code (or use list_products) instead of guessing.
Confirm each change briefly in Spanish (e.g. "Listo, actualicé el precio del código 1912").`;
  }

  return `${shared}

You are talking to a CUSTOMER. Help them find a property, answer questions from the catalog, and move them toward a visit:
- Use search_catalog / get_product to answer. Proactively offer to send photos (send_product_photos) and to schedule a visit.
- To schedule a visit, capture it with save_lead using type 'visit_request', including the customer's name and preferred time in the note. There is no calendar; a team member will follow up.
- If the customer just wants to be contacted, use save_lead with type 'inquiry'.
Be warm, concise, and helpful.`;
}

export interface AgentDeps {
  db: DB;
  kapso: KapsoClient;
  config: Config;
  /** Only the level this module uses — a session fallback is worth seeing. */
  log: Pick<FastifyBaseLogger, "warn">;
}

interface AssistantBlock {
  type?: string;
  text?: string;
}
interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: { content?: AssistantBlock[] };
}

function isRecord(v: unknown): v is StreamMessage {
  return typeof v === "object" && v !== null;
}

interface TurnResult {
  reply: string;
  sessionId?: string;
}

/**
 * One pass through the Agent SDK. Collects the reply and the session id but
 * writes nothing: the caller decides what to persist, because a failed attempt
 * must leave the stored session untouched for the fallback to reason about.
 */
async function runQuery(
  deps: AgentDeps,
  ctx: TurnContext,
  incomingText: string,
  resumeId: string | undefined,
): Promise<TurnResult> {
  const { db, kapso, config } = deps;
  const { server, toolNames } = buildToolServer({ db, kapso, config, ctx });

  let capturedSessionId: string | undefined;
  let resultText = "";
  const assistantText: string[] = [];

  const response = query({
    prompt: incomingText,
    options: {
      model: config.model,
      systemPrompt: systemPrompt(ctx.role),
      mcpServers: { [MCP_SERVER_NAME]: server },
      allowedTools: toolNames,
      // Deny every built-in tool: this agent must act ONLY through our tools.
      canUseTool: async (toolName, input) => {
        if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) {
          return { behavior: "allow", updatedInput: input };
        }
        return { behavior: "deny", message: "This tool is not available to this assistant." };
      },
      maxTurns: 12,
      ...(resumeId ? { resume: resumeId } : {}),
    },
  });

  for await (const raw of response) {
    if (!isRecord(raw)) continue;
    if (typeof raw.session_id === "string") capturedSessionId = raw.session_id;
    if (raw.type === "assistant" && raw.message?.content) {
      for (const block of raw.message.content) {
        if (block.type === "text" && typeof block.text === "string") assistantText.push(block.text);
      }
    }
    if (raw.type === "result" && raw.subtype === "success" && typeof raw.result === "string") {
      resultText = raw.result;
    }
  }

  return { reply: (resultText || assistantText.join("\n")).trim(), sessionId: capturedSessionId };
}

/**
 * Run one agent turn for an inbound message and send the reply over WhatsApp.
 * Resumes the per-phone session when one exists and persists the new session id.
 *
 * FALLBACK: the session id lives in SQLite (on a volume, survives a redeploy)
 * but the SDK's transcript lives under its home directory, so a container whose
 * home is ephemeral resumes an id whose transcript no longer exists — the
 * subprocess exits 1 and every conversation breaks after a deploy. When a
 * resume was in play we retry ONCE with a fresh session, so the customer still
 * gets an answer (losing the conversation history, not the reply).
 *
 * The retry is deliberately gated on resumeId rather than on the error text:
 * the SDK reports every failure as a generic "exited with code 1", so matching
 * the message buys no precision but would silently stop working if the wording
 * changed. Without a resume there is nothing stale to recover from — the
 * failure is real (API down, bad key) and must surface rather than cost a
 * second turn on every request of an outage.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  ctx: TurnContext,
  incomingText: string,
): Promise<string> {
  const { db, kapso, config, log } = deps;
  const resumeId = getSessionId(db, ctx.phone, config.sessionMaxAgeDays);

  let result: TurnResult;
  try {
    result = await runQuery(deps, ctx, incomingText, resumeId);
  } catch (err) {
    if (!resumeId) throw err;
    // Drop the id BEFORE retrying: if the retry also fails, a replayed inbox
    // row must not resume the same dead session all over again.
    clearSessionId(db, ctx.phone);
    log.warn(
      { err, phone: ctx.phone, sessionId: resumeId },
      "agent session could not be resumed; starting a fresh session",
    );
    result = await runQuery(deps, ctx, incomingText, undefined);
  }

  // A publish ends the unit of work: drop the session instead of persisting
  // the new id, so the next owner message starts clean — history stays lean
  // and one product's details cannot bleed into the next one. The flag is not
  // reset between the resume-failure attempts above: if attempt 1 published
  // and then died, the publish still happened and the reset must stick.
  if (ctx.sessionAfterTurn === "reset") {
    clearSessionId(db, ctx.phone);
  } else if (result.sessionId) {
    setSessionId(db, ctx.phone, result.sessionId);
  }
  if (result.reply.length > 0) {
    await kapso.sendText(ctx.phone, result.reply);
  }
  return result.reply;
}
