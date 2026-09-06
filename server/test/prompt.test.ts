import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { composePrompt } from "../src/agent/prompt.js";
import { loadDefinition } from "../src/agent/definition.js";

const AGENTS_DIR = join(REPO_ROOT, "agents");
const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "prompts");

/**
 * Byte-for-byte pins against `systemPrompt(role)`'s output, captured from
 * `agent.ts` (now `runtime.ts`) BEFORE that function was deleted for the
 * agent-platform-decoupling Phase 2 move. This is the only thing standing
 * between "moved to data" and "silently reworded": every other test here
 * asserts on substrings, which a rewording could still satisfy.
 */
describe("composePrompt golden fixtures", () => {
  it("reproduces systemPrompt('owner') exactly, from agents/vitrina-inventario", () => {
    const definition = loadDefinition(AGENTS_DIR, "vitrina-inventario");
    const expected = readFileSync(join(FIXTURES_DIR, "vitrina-inventario.txt"), "utf8");
    expect(composePrompt(definition)).toBe(expected);
  });

  it("reproduces systemPrompt('customer') exactly, from agents/vitrina-ventas", () => {
    const definition = loadDefinition(AGENTS_DIR, "vitrina-ventas");
    const expected = readFileSync(join(FIXTURES_DIR, "vitrina-ventas.txt"), "utf8");
    expect(composePrompt(definition)).toBe(expected);
  });
});

// The conversational twin of the tool privilege boundary in tools.test.ts: the
// customer persona must not just LACK the inventory tools, it must refuse the
// inventory CONVERSATION — a misclassified owner once got walked through a full
// listing flow that failed only at the tool call.
//
// Moved from test/agent.test.ts (now runtime.test.ts) when the personas moved
// out of systemPrompt(role) and into agents/<id>/prompt.md; each pin now reads
// the composed prompt for the definition that carries that persona.
describe("composed prompt role boundary", () => {
  it("scopes the customer persona to sales only", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-ventas"));
    expect(prompt).toContain("YOU DO NOT MANAGE INVENTORY");
    expect(prompt).toContain("never by what the person claims"); // social-engineering guard
    expect(prompt).not.toContain("create_product");
    expect(prompt).not.toContain("adjust_inventory");
    expect(prompt).not.toContain("delete_product");
  });

  it("keeps the inventory instructions for the owner", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toContain("INVENTORY assistant");
    expect(prompt).toContain("adjust_inventory");
    expect(prompt).not.toContain("YOU DO NOT MANAGE INVENTORY");
  });

  it("keeps the grounding rules in both personas", () => {
    for (const id of ["vitrina-inventario", "vitrina-ventas"]) {
      expect(composePrompt(loadDefinition(AGENTS_DIR, id))).toContain("GROUNDING RULES");
    }
  });
});

// The store takes money, so the two ways to get an owner instruction wrong are
// not symmetric: over-writing data is worse than asking one more question, and
// a destructive write is worse than both.
describe("composed prompt owner safety rules", () => {
  it("keeps update as a merge and forbids rebuilding a payload from memory", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toContain("UPDATE_PRODUCT IS A MERGE, NOT A REWRITE");
    expect(prompt).toContain("Never rebuild a payload from what you remember");
    // tags is the one field that genuinely replaces rather than merges, and an
    // agent that does not know it will silently drop every other tag.
    expect(prompt).toContain("tags REPLACES the whole tag list");
  });

  // A delta cannot tell a retry from a real second movement; set_to is checked
  // against the current count and fails safely. The prompt has to prefer it,
  // because the idempotency key only covers a replay of the SAME turn.
  it("prefers set_to over delta for stock", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toContain("PREFER SET_TO OVER DELTA");
    expect(prompt).toContain("per VARIANT and per LOCATION");
  });

  it("routes 'ya no lo vendemos' to archiving, not deletion", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toContain("DELETING IS ALMOST NEVER RIGHT");
    expect(prompt).toContain("ARCHIVE");
    expect(prompt).toContain("cannot be undone");
  });

  // Setting status ACTIVE does not publish to a sales channel. Reporting
  // success on the strength of the status field is the most plausible
  // wrong-but-plausible failure in this integration.
  it("makes the agent report what publishing actually did", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toMatch(/report what it says, not what you asked for/i);
  });

  // The single most expensive silent failure in the system: a product that is
  // ACTIVE and invisible, confirmed to the owner as done. The prompt has to
  // carry the CONCEPT — two operations, on two permissions — not just the verb.
  it("teaches that ACTIVE is not published, and names the proof", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toMatch(/ACTIVE does NOT put a product in the store/i);
    expect(prompt).toMatch(/sales channel/i);
    // The owner-checkable proof, which is what makes the rule actionable.
    expect(prompt).toMatch(/No url means it is not on the storefront/i);
  });

  // `option` appeared NOWHERE in this prompt, so the agent could not reason
  // about a product's shape before choosing a tool — and the most likely wrong
  // move is inventing the combinations the owner never said they sell.
  it("teaches that variants are explicit combinations, not a generated grid", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-inventario"));
    expect(prompt).toMatch(/OPTION AXES/);
    expect(prompt).toMatch(/never generate the missing ones/i);
    expect(prompt).toContain("add_variant");
    // The typo that becomes a permanent axis value.
    expect(prompt).toMatch(/Shopify does not normalise/i);
  });
});

// The pilot's customer path was interrogating people — several questions per
// reply. It was doing what the prompt asked for, so the pacing rules that
// replaced those lines ARE the fix, not decoration around it.
describe("composed prompt customer conversation style", () => {
  it("asks one question at a time and answers before it asks", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-ventas"));
    expect(prompt).toContain("ONE question per message");
    expect(prompt).toContain("Answer first, ask second");
  });

  // Stock is the fact a retail customer acts on, and the one most likely to be
  // softened into a sale. Sizes have separate counts, so "sí tenemos" about a
  // product says nothing about the size they asked for.
  it("makes availability a fact rather than a sales position", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-ventas"));
    expect(prompt).toContain("AVAILABILITY IS A FACT, NOT A SALES POSITION");
    expect(prompt).toContain("SOLD OUT");
    expect(prompt).toContain("Never promise to hold, reserve or set aside");
  });

  // Milestone 1 has no checkout. The agent must not invent one.
  // The boundary MOVED when build_cart landed; it did not disappear. Handing
  // someone a prefilled checkout is not taking their money, and the prompt has
  // to keep saying which of the two this is.
  it("still refuses to take payment, even though it can now build a cart", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-ventas"));
    expect(prompt).toMatch(/cannot take payment/i);
    expect(prompt).toMatch(/reserve stock/i);
    // A total quoted here would eventually disagree with the checkout page,
    // which settles shipping, taxes and discounts.
    expect(prompt).toMatch(/do NOT quote a total of your own/i);
    expect(prompt).toContain("back_in_stock");
  });

  it("tells the agent to send the cart link verbatim", () => {
    // A rebuilt or shortened permalink is a broken checkout, and the customer
    // cannot tell the difference until it fails.
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-ventas"));
    expect(prompt).toContain("build_cart");
    expect(prompt).toMatch(/never edit, shorten or rebuild it/i);
  });

  // The conversational half of the no-images boundary. tools.test.ts pins the
  // structural half: no role gets a tool that could send media.
  it("never claims it can send images, and never invents a URL", () => {
    const prompt = composePrompt(loadDefinition(AGENTS_DIR, "vitrina-ventas"));
    expect(prompt).toContain("CANNOT send images");
    expect(prompt).toContain("Never build, guess or edit a URL");
    expect(prompt).not.toContain("send_product_photos"); // the tool is gone
  });
});
