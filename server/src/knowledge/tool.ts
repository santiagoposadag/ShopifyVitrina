import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { text, type ToolFactory } from "../tools/factory.js";
import type { KnowledgeHit } from "../tools/ports.js";

/**
 * `search_knowledge`: the searchable half of the knowledge base.
 *
 * The tool takes a QUERY and nothing else. There is no parameter that could
 * name an agent, a document or a scope, which is what makes per-agent isolation
 * structural rather than a filter someone remembers to apply: the id comes from
 * `ctx.turn.agentId` — set by the router from the transport — and the port has
 * no unscoped read to reach.
 */

/**
 * Said on EVERY result, not once in the system prompt.
 *
 * Same reasoning as search_catalog's approximate-match caveat: a system prompt
 * sits far back in a resumed transcript, and a keyword hit is a candidate, not
 * an answer to the question that was asked.
 */
const CAVEAT = "Keyword matches from this assistant's own knowledge base — read them before using them; a match is not proof it answers the question.";

/**
 * What the model is told when nothing matched.
 *
 * Explicit about what to do next, because the alternative the model reaches for
 * is its own memory — and a knowledge base exists precisely for the questions
 * where memory would be a plausible-sounding invention about someone's business.
 */
const NO_MATCH = "Nothing in this assistant's knowledge base matched. Say that it is not recorded rather than answering from general knowledge.";

export function renderKnowledgeHits(query: string, hits: KnowledgeHit[]): string {
  if (hits.length === 0) return `No knowledge entry matched "${query}". ${NO_MATCH}`;
  const entries = hits.map((hit) => `[${hit.source} · ${hit.heading}]\n${hit.body}`);
  return `${hits.length} knowledge entr${hits.length === 1 ? "y" : "ies"} matched "${query}". ${CAVEAT}\n\n${entries.join("\n\n")}`;
}

export const searchKnowledge: ToolFactory = (ctx, { knowledge }) =>
  tool(
    "search_knowledge",
    ctx.describe(
      "Search this assistant's own knowledge base (business policies, vocabulary, procedures) with the person's own words. Use it before answering a question about how this business works that the system prompt does not already answer, and answer from what it returns. It does NOT contain product data: prices, SKUs, stock and availability still come from the catalog tools.",
    ),
    {
      query: z
        .string()
        .describe("What to look for, in the person's own words. Spanish, keywords or a question."),
      limit: z.number().optional().describe("How many entries to return (default 3, max 10)"),
    },
    async ({ query, limit }) => {
      // The agent id is NOT a parameter: it is the turn's, so no wording of a
      // question can point this at another agent's documents.
      const hits = await knowledge.search({ agentId: ctx.turn.agentId, query, limit });
      return text(renderKnowledgeHits(query, hits));
    },
  );
