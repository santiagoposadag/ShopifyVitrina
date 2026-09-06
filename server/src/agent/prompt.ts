import type { AgentDefinition } from "./definition.js";

/**
 * The role-neutral half of every persona this runtime hosts: the store/
 * Spanish framing and the grounding rules. It stays here rather than in a
 * per-agent file because it is a property of THIS RUNTIME — every agent it
 * hosts answers on WhatsApp in Spanish and may only state facts a tool
 * returned in the conversation — not a decision one business gets to make
 * differently from another. `PromptSpec.base: "grounding"` selects it.
 *
 * Byte-identical to the `shared` constant `systemPrompt(role)` used to build
 * both personas from — see test/prompt.test.ts's golden fixtures, captured
 * before that function was deleted.
 */
const GROUNDING_PREAMBLE = `You are the assistant for an online store on WhatsApp. The catalog lives in Shopify and the tools read and write it directly.
Reply in neutral, professional Spanish (NOT Rioplatense, no voseo). Keep replies short and WhatsApp-friendly: a few short lines, no markdown headings, minimal emoji.

GROUNDING RULES (critical):
- You may ONLY state product facts (price, SKU, stock, sizes, colours, availability) that come back from a tool result in THIS conversation. Never invent facts or answer product questions from memory.
- Prices, SKUs and stock counts must be quoted exactly as returned by the tools.
- Stock changes constantly. A count you saw earlier in this conversation may already be wrong — check again before quoting it.
- If you are unsure, use a tool to check before answering.`;

const BASES: Record<AgentDefinition["prompt"]["base"], string> = {
  grounding: GROUNDING_PREAMBLE,
  none: "",
};

/**
 * Render `{{slot}}` placeholders in the persona from `prompt.slots`.
 *
 * No definition sets a slot yet — Phase 4's knowledge layer is the first real
 * consumer — so this is a no-op seam on every definition that ships today,
 * not dead code waiting for a caller.
 */
function renderSlots(text: string, slots: Record<string, string>): string {
  return Object.entries(slots).reduce(
    (rendered, [key, value]) => rendered.replaceAll(`{{${key}}}`, value),
    text,
  );
}

/**
 * Compose one agent's system prompt: base, then persona, joined the same way
 * `systemPrompt(role)` used to join `shared` and its role branch — a blank
 * line, nothing else. Byte-identical for the two agents that exist today; see
 * the golden fixtures in test/prompt.test.ts.
 */
export function composePrompt(definition: AgentDefinition): string {
  const base = BASES[definition.prompt.base];
  const persona = renderSlots(definition.personaText, definition.prompt.slots);
  return base.length > 0 ? `${base}\n\n${persona}` : persona;
}
