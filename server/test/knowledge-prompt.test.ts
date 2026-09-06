import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { loadDefinition } from "../src/agent/definition.js";
import { composePrompt, knowledgeSection } from "../src/agent/prompt.js";
import { openDb } from "../src/data/db.js";
import { loadKnowledgeBase } from "../src/knowledge/store.js";
import { toolUniverse } from "../src/tools/registry.js";
import { AGENT_IDS } from "../src/router.js";

/**
 * The composed prompt, decomposed.
 *
 * Knowledge is ADDITIVE this phase: nothing left either prompt.md, so the
 * persona half of every composed prompt must still be the bytes captured from
 * `systemPrompt(role)` before it was deleted (test/fixtures/prompts/*.txt, and
 * the byte-identity pins in prompt.test.ts that call composePrompt with no
 * knowledge at all). These pins are the other half: what production actually
 * composes, with the knowledge base the shipped definitions declare.
 */

const AGENTS_DIR = join(REPO_ROOT, "agents");
const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "prompts");

function golden(agentId: string): string {
  return readFileSync(join(FIXTURES_DIR, `${agentId}.txt`), "utf8");
}

/** The base exactly as the composition root builds it, on a throwaway index. */
function shippedBase() {
  const definitions = Object.values(AGENT_IDS).map((id) => loadDefinition(AGENTS_DIR, id));
  return loadKnowledgeBase({
    db: openDb(":memory:"),
    agentsDir: AGENTS_DIR,
    definitions,
    universe: toolUniverse(),
  });
}

describe("the composed prompt is base + persona + knowledge, in that order", () => {
  it("keeps the owner's persona byte-identical and appends knowledge after it", () => {
    const definition = loadDefinition(AGENTS_DIR, AGENT_IDS.owner);
    const knowledge = shippedBase().promptFor(AGENT_IDS.owner);
    const composed = composePrompt(definition, knowledge);
    const expected = golden(AGENT_IDS.owner);

    // The persona half, byte for byte: the prefix IS the golden file, and the
    // only thing after it is the knowledge section.
    expect(composed.slice(0, expected.length)).toBe(expected);
    expect(composed).toBe(`${expected}\n\n${knowledgeSection(knowledge)}`);
    expect(composed.length).toBeGreaterThan(expected.length);
  });

  it("leaves the customer's prompt exactly as it was: it has no knowledge", () => {
    const definition = loadDefinition(AGENTS_DIR, AGENT_IDS.customer);
    const knowledge = shippedBase().promptFor(AGENT_IDS.customer);
    expect(knowledge).toBeUndefined();
    expect(composePrompt(definition, knowledge)).toBe(golden(AGENT_IDS.customer));
  });

  it("adds nothing at all when an agent's knowledge is empty", () => {
    const definition = loadDefinition(AGENTS_DIR, AGENT_IDS.owner);
    expect(composePrompt(definition, { inlineText: "", hasSearchable: false })).toBe(
      golden(AGENT_IDS.owner),
    );
    expect(composePrompt(definition)).toBe(golden(AGENT_IDS.owner));
  });
});

describe("the knowledge section", () => {
  it("is empty for an agent with no knowledge", () => {
    expect(knowledgeSection(undefined)).toBe("");
    expect(knowledgeSection({ inlineText: "", hasSearchable: false })).toBe("");
  });

  // The tool instruction and the tool itself are one decision. A prompt telling
  // an agent to call search_knowledge when the definition never granted it is
  // the hole the boot validator closes from the other side — and here it would
  // be unfalsifiable from outside: the model reports it looked and found nothing.
  it("names search_knowledge ONLY for an agent that has a searchable tier", () => {
    expect(knowledgeSection({ inlineText: "Hechos.", hasSearchable: false })).not.toContain(
      "search_knowledge",
    );
    expect(knowledgeSection({ inlineText: "Hechos.", hasSearchable: true })).toContain(
      "search_knowledge",
    );
  });

  it("still frames the facts when an agent has only a searchable tier", () => {
    const section = knowledgeSection({ inlineText: "", hasSearchable: true });
    expect(section).toContain("BUSINESS KNOWLEDGE");
    expect(section).toContain("search_knowledge");
  });

  it("carries the inline documents verbatim", () => {
    expect(knowledgeSection({ inlineText: "Hecho literal.", hasSearchable: false })).toContain(
      "Hecho literal.",
    );
  });

  /**
   * GROUNDING_PREAMBLE says product facts may only come from a tool result in
   * this conversation, and this section then hands the model a block of facts
   * with no tool call behind them. Without a line saying which kind of fact
   * these are, the cheapest reading is that the rule was relaxed — and the next
   * price quoted comes out of a document written months ago.
   */
  it("says product facts still come only from a tool", () => {
    const section = knowledgeSection({ inlineText: "Hechos.", hasSearchable: false });
    expect(section).toMatch(/Price, SKU, stock, availability and URLs still come ONLY from a tool/);
    expect(section).toMatch(/not product data/i);
  });
});

/**
 * The plan's phase-4 acceptance case, at the prompt layer: the owner asks what
 * "publicar" means and the answer is grounded in knowledge rather than in the
 * persona. The persona still teaches the RULE (it always did); what is new is
 * the vocabulary the assistant can quote, and it survives a resumed transcript
 * because it is in the prompt rather than behind a tool call.
 */
describe("the owner's composed prompt can ground '¿qué significa publicar?'", () => {
  it("carries the glossary entry, and the persona that motivated it, together", () => {
    const composed = composePrompt(
      loadDefinition(AGENTS_DIR, AGENT_IDS.owner),
      shippedBase().promptFor(AGENT_IDS.owner),
    );
    // From knowledge/glosario.md, in the owner's own language.
    expect(composed).toMatch(/ACTIVO y seguir invisible/);
    expect(composed).toMatch(/La única prueba de que quedó publicado/);
    // And from prompt.md, unchanged: nothing was moved out of the persona.
    expect(composed).toContain("PUBLISHING IS TWO OPERATIONS");
  });
});
