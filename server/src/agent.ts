import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { KapsoClient } from "./kapso.js";
import { getSessionId, setSessionId } from "./repo.js";
import { buildToolServer, MCP_SERVER_NAME } from "./tools.js";
import type { Role, TurnContext } from "./types.js";

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

/**
 * Run one agent turn for an inbound message and send the reply over WhatsApp.
 * Resumes the per-phone session when one exists and persists the new session id.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  ctx: TurnContext,
  incomingText: string,
): Promise<string> {
  const { db, kapso, config } = deps;
  const { server, toolNames } = buildToolServer({ db, kapso, config, ctx });
  const resumeId = getSessionId(db, ctx.phone, config.sessionMaxAgeDays);

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

  if (capturedSessionId) setSessionId(db, ctx.phone, capturedSessionId);

  const reply = (resultText || assistantText.join("\n")).trim();
  if (reply.length > 0) {
    await kapso.sendText(ctx.phone, reply);
  }
  return reply;
}
