import type { PromptKnowledge } from "../knowledge/store.js";
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
 * The framing around an agent's inline knowledge.
 *
 * English, like every other instruction here, while the documents it introduces
 * are Spanish — they are quoted to a Colombian shop owner in their own words.
 *
 * The second line is the one that has to be there. GROUNDING_PREAMBLE says
 * product facts may only come from a tool result in this conversation, and this
 * section hands the model a block of facts with no tool call behind it: without
 * saying which kind of fact these are, the cheapest reading is that the rule
 * just got relaxed, and the next price the model quotes comes from a document
 * that was written months ago.
 */
const KNOWLEDGE_PREAMBLE = `BUSINESS KNOWLEDGE — how this business and this store work, written by its owner.
- You may state what is below without a tool call: it is vocabulary and policy, not product data.
- Price, SKU, stock, availability and URLs still come ONLY from a tool result in THIS conversation, whatever this section says.
- Never present an example in it as a real product.`;

/**
 * Written ONLY for an agent that actually has a searchable tier.
 *
 * A prompt telling an agent to call a tool it was not given is the exact hole
 * the Phase 2 validator closes from the other side; here it would also be
 * unfalsifiable from the outside — the model would report that it looked
 * something up and found nothing.
 */
const SEARCH_KNOWLEDGE_INSTRUCTION = `More of this business's knowledge is indexed and is NOT in this prompt. Before answering a question about its policies, vocabulary or procedures that you cannot already answer from the section above, call search_knowledge with the person's own words and answer from what it returns. If it returns nothing, say it is not recorded rather than answering from general knowledge.`;

/**
 * The knowledge section of a composed prompt, or "" for an agent with none.
 *
 * Exported for tests: this is the only part of the prompt that is not pinned
 * byte-for-byte against the pre-refactor `systemPrompt`, so it needs its own pin.
 */
export function knowledgeSection(knowledge: PromptKnowledge | undefined): string {
  if (!knowledge) return "";
  const parts: string[] = [];
  if (knowledge.inlineText.length > 0) parts.push(KNOWLEDGE_PREAMBLE, knowledge.inlineText);
  if (knowledge.hasSearchable) {
    // The preamble still applies when there is no inline tier: it is what says
    // these facts are not product data.
    if (parts.length === 0) parts.push(KNOWLEDGE_PREAMBLE);
    parts.push(SEARCH_KNOWLEDGE_INSTRUCTION);
  }
  return parts.join("\n\n");
}

/**
 * Compose one agent's system prompt: base, then persona, then knowledge —
 * joined the same way `systemPrompt(role)` used to join `shared` and its role
 * branch: a blank line, nothing else.
 *
 * ADDITIVE, and that is a requirement rather than an implementation detail. The
 * personas are tuned and pinned byte-for-byte against the pre-refactor
 * `systemPrompt` (test/prompt.test.ts's golden fixtures), so knowledge is
 * appended and nothing is moved out of prompt.md. An agent with no knowledge —
 * `knowledge` undefined, which is what the base returns for one that declares
 * none — composes exactly the bytes it composed before this phase existed.
 */
export function composePrompt(
  definition: AgentDefinition,
  knowledge?: PromptKnowledge,
): string {
  const base = BASES[definition.prompt.base];
  const persona = renderSlots(definition.personaText, definition.prompt.slots);
  const head = base.length > 0 ? `${base}\n\n${persona}` : persona;
  const section = knowledgeSection(knowledge);
  return section.length > 0 ? `${head}\n\n${section}` : head;
}
