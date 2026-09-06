import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import {
  loadDefinition,
  validateDefinition,
  type AgentDefinition,
} from "../src/agent/definition.js";
import { createSchema, openDb, type DB } from "../src/data/db.js";
import { buildToolServer, toolUniverse } from "../src/tools/registry.js";
import {
  chunkDocument,
  countIndexedChunks,
  estimateTokens,
  indexAgentKnowledge,
  loadAgentKnowledge,
  loadKnowledgeBase,
  openKnowledgeBase,
  type AgentKnowledge,
} from "../src/knowledge/store.js";
import { renderKnowledgeHits } from "../src/knowledge/tool.js";
import { fakePorts } from "./helpers/fake-ports.js";
import type { TurnContext } from "../src/types.js";

/**
 * The knowledge base: two tiers, one index, and one property that has to hold
 * before a second business exists — a chunk belongs to ONE agent and no query
 * from another agent can reach it.
 *
 * Nothing here touches the network, and the index is an in-memory SQLite
 * database per test.
 */

const UNIVERSE = toolUniverse();
const SHIPPED_GLOSSARY = readFileSync(
  join(REPO_ROOT, "agents", "vitrina-inventario", "knowledge", "glosario.md"),
  "utf8",
);

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vitrina-knowledge-test-"));
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface AgentFixture {
  id: string;
  inline?: string[];
  searchable?: string[];
  maxInlineTokens?: number;
  tools?: string[];
  persona?: string;
  /** Filename (under knowledge/) → content. */
  docs?: Record<string, string>;
}

/** Write one agent definition, its persona and its knowledge documents to disk. */
function writeAgent(fixture: AgentFixture): AgentDefinition {
  const agentDir = join(dir, fixture.id);
  mkdirSync(join(agentDir, "knowledge"), { recursive: true });
  writeFileSync(
    join(agentDir, "agent.yaml"),
    stringifyYaml({
      id: fixture.id,
      roles: ["owner"],
      model: { maxTurns: 12 },
      tools: fixture.tools ?? ["search_catalog"],
      prompt: { base: "grounding", persona: "prompt.md", slots: {} },
      knowledge: {
        inline: fixture.inline ?? [],
        searchable: fixture.searchable ?? [],
        maxInlineTokens: fixture.maxInlineTokens ?? 4000,
      },
      session: { resetOn: [], keyedBy: "principal" },
      reach: [],
    }),
  );
  writeFileSync(join(agentDir, "prompt.md"), fixture.persona ?? "A persona.");
  for (const [name, body] of Object.entries(fixture.docs ?? {})) {
    writeFileSync(join(agentDir, "knowledge", name), body);
  }
  return loadDefinition(dir, fixture.id);
}

function load(fixture: AgentFixture): AgentKnowledge {
  return loadAgentKnowledge(dir, writeAgent(fixture), UNIVERSE);
}

const PUBLICAR_DOC = `# Glosario

Intro.

## Publicar

Poner el producto en ACTIVO no lo publica en la tienda: publicarlo en el canal de venta
es una segunda operación.
`;

describe("chunkDocument", () => {
  it("makes one chunk per ## section and keeps its heading", () => {
    const chunks = chunkDocument("glosario.md", PUBLICAR_DOC);
    expect(chunks.map((c) => c.heading)).toEqual(["Glosario", "Publicar"]);
    expect(chunks[1]?.body).toContain("segunda operación");
    // The heading is not repeated inside the body: it is stored beside it, so a
    // renderer decides once how a chunk is shown to the model.
    expect(chunks[1]?.body.startsWith("##")).toBe(false);
  });

  it("keeps the text above the first section as its own chunk, under the title", () => {
    const chunks = chunkDocument("glosario.md", PUBLICAR_DOC);
    expect(chunks[0]?.heading).toBe("Glosario");
    expect(chunks[0]?.body).toBe("Intro.");
  });

  it("drops a section with a heading and no body", () => {
    const chunks = chunkDocument("d.md", "## Vacía\n\n## Llena\n\nAlgo.\n");
    expect(chunks.map((c) => c.heading)).toEqual(["Llena"]);
  });

  it("splits a section too long to be one chunk, repeating its heading on each piece", () => {
    const paragraph = `${"palabra ".repeat(120)}\n\n`;
    const chunks = chunkDocument("largo.md", `## Sección\n\n${paragraph.repeat(6)}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.heading).toBe("Sección");
    // Ordinals are dense and ordered, because they are what puts a split
    // section back together in the order it was written.
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_c, i) => i));
  });

  it("falls back to the file name when a document has no heading at all", () => {
    const chunks = chunkDocument("suelto.md", "Solo un párrafo.\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("suelto.md");
  });
});

/**
 * There is no tokenizer in this build and we are not adding one. The budget is
 * enforced against an APPROXIMATION, so the only thing that matters is which
 * way it is wrong: it must overestimate, so the prompt can never be bigger than
 * the number in the definition says it is.
 */
describe("estimateTokens", () => {
  it("counts three characters per token, rounded up", () => {
    expect(estimateTokens("a".repeat(300))).toBe(100);
    expect(estimateTokens("a".repeat(301))).toBe(101);
    expect(estimateTokens("")).toBe(0);
  });

  it("overestimates Spanish prose rather than underestimating it", () => {
    const prose = SHIPPED_GLOSSARY;
    // Real tokenizers land near 4 characters per token for prose like this;
    // this one must never come in under that, or the budget is decoration.
    expect(estimateTokens(prose)).toBeGreaterThan(prose.length / 4);
  });
});

describe("loadAgentKnowledge", () => {
  it("concatenates the inline documents in the order the definition declares them", () => {
    const knowledge = load({
      id: "a",
      inline: ["knowledge/uno.md", "knowledge/dos.md"],
      docs: { "uno.md": "# Uno\n\nPrimero.\n", "dos.md": "# Dos\n\nSegundo.\n" },
    });
    expect(knowledge.prompt.inlineText.indexOf("Primero.")).toBeLessThan(
      knowledge.prompt.inlineText.indexOf("Segundo."),
    );
    expect(knowledge.prompt.hasSearchable).toBe(false);
    expect(knowledge.chunks).toHaveLength(0);
  });

  it("indexes only the searchable tier, and reports that the agent has one", () => {
    const knowledge = load({
      id: "a",
      inline: ["knowledge/uno.md"],
      searchable: ["knowledge/dos.md"],
      tools: ["search_catalog", "search_knowledge"],
      docs: { "uno.md": "# Uno\n\nPrimero.\n", "dos.md": "# Dos\n\nSegundo.\n" },
    });
    expect(knowledge.prompt.hasSearchable).toBe(true);
    expect(knowledge.chunks.map((c) => c.source)).toEqual(["dos.md"]);
  });

  it("fails naming the path when a declared document does not exist", () => {
    expect(() => load({ id: "a", inline: ["knowledge/falta.md"] })).toThrow(/falta\.md/);
  });

  // A definition is data, and a data file that can name a path outside its own
  // directory can read a credential file straight into a system prompt.
  it("fails when a declared document escapes the knowledge directory", () => {
    expect(() =>
      load({ id: "a", inline: ["../prompt.md"], docs: {} }),
    ).toThrow(/knowledge/i);
    expect(() => load({ id: "a", inline: ["/etc/hostname"] })).toThrow(/knowledge/i);
  });

  // The failure this prevents: the owner writes a policy, ships it, and no turn
  // can ever reach it because nothing declared it. Silent, and invisible from
  // the outside — the agent simply does not know the thing it was told.
  it("fails when a document in knowledge/ is declared by neither tier", () => {
    expect(() =>
      load({ id: "a", inline: ["knowledge/uno.md"], docs: { "uno.md": "# Uno\n\nX.\n", "huerfano.md": "# Nadie\n\nY.\n" } }),
    ).toThrow(/huerfano\.md/);
  });

  it("finds an undeclared document hiding in a subdirectory too", () => {
    const definition = writeAgent({
      id: "a",
      inline: ["knowledge/uno.md"],
      docs: { "uno.md": "# Uno\n\nX.\n" },
    });
    mkdirSync(join(dir, "a", "knowledge", "sub"), { recursive: true });
    writeFileSync(join(dir, "a", "knowledge", "sub", "escondido.md"), "# Nadie\n\nY.\n");
    expect(() => loadAgentKnowledge(dir, definition, UNIVERSE)).toThrow(/escondido\.md/);
  });

  it("fails when a knowledge document names a tool this agent was not given", () => {
    expect(() =>
      load({
        id: "a",
        inline: ["knowledge/uno.md"],
        tools: ["search_catalog"],
        docs: { "uno.md": "# Uno\n\nUsa adjust_inventory para el stock.\n" },
      }),
    ).toThrow(/adjust_inventory/);
  });
});

/**
 * The budget is enforced at BOOT and the over-budget case FAILS. Truncating is
 * the invisible option: half a policy reaches the model, reads like a whole
 * one, and the owner has no way to see which half was cut.
 */
describe("the inline budget", () => {
  it("accepts documents that fit", () => {
    const knowledge = load({
      id: "a",
      inline: ["knowledge/uno.md"],
      maxInlineTokens: 10,
      docs: { "uno.md": "# T\n\n123456789012345678901234\n" },
    });
    expect(knowledge.inlineTokens).toBeLessThanOrEqual(10);
  });

  it("fails boot when the inline documents exceed maxInlineTokens", () => {
    expect(() =>
      load({
        id: "a",
        inline: ["knowledge/uno.md"],
        maxInlineTokens: 5,
        docs: { "uno.md": `# T\n\n${"a".repeat(300)}\n` },
      }),
    ).toThrow(/maxInlineTokens/);
  });

  it("names the budget, the estimate and the documents in the failure", () => {
    let message = "";
    try {
      load({
        id: "a",
        inline: ["knowledge/uno.md"],
        maxInlineTokens: 5,
        docs: { "uno.md": `# T\n\n${"a".repeat(300)}\n` },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/uno\.md/);
    expect(message).toMatch(/\b5\b/);
    expect(message).toMatch(/10[0-9]/); // the estimate, ~104 tokens
  });

  it("never truncates: an over-budget definition produces no knowledge at all", () => {
    expect(() =>
      load({
        id: "a",
        inline: ["knowledge/uno.md"],
        maxInlineTokens: 5,
        docs: { "uno.md": `# T\n\n${"a".repeat(300)}\n` },
      }),
    ).toThrow();
  });

  it("fails boot when inline documents are declared against a zero budget", () => {
    expect(() =>
      load({
        id: "a",
        inline: ["knowledge/uno.md"],
        maxInlineTokens: 0,
        docs: { "uno.md": "# T\n\nX.\n" },
      }),
    ).toThrow(/maxInlineTokens/);
  });
});

/**
 * The tool and the searchable tier imply each other, and each direction is its
 * own silent failure — documents no turn can reach, and a tool that can only
 * ever report that it found nothing. Checked at BOOT, where a data-file mistake
 * belongs, and checked structurally so a definition built in memory cannot skip it.
 */
describe("the knowledge/tool pairing, at boot", () => {
  it("fails a definition with searchable documents and no search_knowledge", () => {
    const definition = writeAgent({
      id: "a",
      searchable: ["knowledge/g.md"],
      tools: ["search_catalog"],
      docs: { "g.md": PUBLICAR_DOC },
    });
    expect(() => validateDefinition(definition, UNIVERSE)).toThrow(/search_knowledge/);
  });

  it("fails a definition with search_knowledge and nothing searchable", () => {
    const definition = writeAgent({
      id: "a",
      inline: ["knowledge/g.md"],
      tools: ["search_catalog", "search_knowledge"],
      docs: { "g.md": PUBLICAR_DOC },
    });
    expect(() => validateDefinition(definition, UNIVERSE)).toThrow(/search_knowledge/);
  });

  it("passes when they agree, in either direction", () => {
    expect(() =>
      validateDefinition(
        writeAgent({
          id: "a",
          searchable: ["knowledge/g.md"],
          tools: ["search_catalog", "search_knowledge"],
          docs: { "g.md": PUBLICAR_DOC },
        }),
        UNIVERSE,
      ),
    ).not.toThrow();
    expect(() =>
      validateDefinition(
        writeAgent({ id: "b", inline: ["knowledge/g.md"], docs: { "g.md": PUBLICAR_DOC } }),
        UNIVERSE,
      ),
    ).not.toThrow();
  });

  it("holds for the shipped inventory agent, which declares both", () => {
    const definition = loadDefinition(join(REPO_ROOT, "agents"), "vitrina-inventario");
    expect(definition.tools).toContain("search_knowledge");
    expect(definition.knowledge.searchable.length).toBeGreaterThan(0);
    expect(() => validateDefinition(definition, UNIVERSE)).not.toThrow();
  });
});

/**
 * A regression, and a real one: the hash separator below was first written as a
 * LITERAL NUL inside a template literal. The composed string was correct and
 * every test passed, but `file` reported the module as `data` and `grep`
 * answered "binary file matches" instead of printing the line — in a repository
 * navigated by grep, whose docs cite `file:line` and whose scripts check those
 * citations, that is a module nobody can review or cite. Git diffs it as text,
 * so it sails through review; an editor may strip the bytes on the next save.
 */
describe("the knowledge modules stay greppable text", () => {
  for (const file of ["store.ts", "tool.ts"]) {
    it(`src/knowledge/${file} contains no raw control bytes`, () => {
      const bytes = readFileSync(join(import.meta.dirname, "..", "src", "knowledge", file));
      const offending = [...bytes].filter((b) => b < 0x20 && b !== 9 && b !== 10 && b !== 13);
      expect(offending).toEqual([]);
    });
  }
});

/**
 * The index is DERIVED: the documents on disk are the source of truth and this
 * table is rebuilt from them. What must never happen is a boot that appends to
 * what the last boot wrote — delivery of a message is at-least-once, and a
 * restart is routine.
 */
describe("indexing at boot", () => {
  const searchableAgent = (id: string, body: string): AgentKnowledge =>
    loadAgentKnowledge(
      dir,
      writeAgent({
        id,
        searchable: ["knowledge/g.md"],
        tools: ["search_catalog", "search_knowledge"],
        docs: { "g.md": body },
      }),
      UNIVERSE,
    );

  it("does not duplicate chunks when the same content is indexed twice", () => {
    const agent = searchableAgent("a", PUBLICAR_DOC);
    expect(indexAgentKnowledge(db, agent)).toBe("indexed");
    const after = countIndexedChunks(db, "a");
    expect(indexAgentKnowledge(db, agent)).toBe("unchanged");
    expect(countIndexedChunks(db, "a")).toBe(after);
  });

  it("replaces the old chunks when the content changed, rather than appending", async () => {
    indexAgentKnowledge(db, searchableAgent("a", PUBLICAR_DOC));
    const first = countIndexedChunks(db, "a");
    const changed = searchableAgent("a", `${PUBLICAR_DOC}\n## Envíos\n\nOtra cosa.\n`);
    expect(indexAgentKnowledge(db, changed)).toBe("indexed");
    expect(countIndexedChunks(db, "a")).toBe(first + 1);

    const base = openKnowledgeBase(db, [changed]);
    const hits = await base.search({ agentId: "a", query: "publicar" });
    // One hit for the section that survived, not two copies of it.
    expect(hits.filter((h) => h.heading === "Publicar")).toHaveLength(1);
  });

  it("drops an agent's chunks when its definition no longer declares any", async () => {
    indexAgentKnowledge(db, searchableAgent("a", PUBLICAR_DOC));
    const stripped = loadAgentKnowledge(
      dir,
      writeAgent({ id: "a", docs: { "g.md": PUBLICAR_DOC }, inline: ["knowledge/g.md"] }),
      UNIVERSE,
    );
    openKnowledgeBase(db, [stripped]);
    expect(countIndexedChunks(db, "a")).toBe(0);
  });

  // An agent renamed or dropped from the definitions leaves rows nothing reads
  // and nothing replaces. Only the boot path knows the full served list, so
  // only the boot path is allowed to delete on the strength of it.
  it("sweeps chunks of an agent this runtime no longer serves, on the boot path", () => {
    indexAgentKnowledge(db, searchableAgent("a", PUBLICAR_DOC));
    indexAgentKnowledge(db, searchableAgent("b", PUBLICAR_DOC));
    loadKnowledgeBase({
      db,
      agentsDir: dir,
      definitions: [loadDefinition(dir, "a")],
      universe: UNIVERSE,
    });
    expect(countIndexedChunks(db, "a")).toBeGreaterThan(0);
    expect(countIndexedChunks(db, "b")).toBe(0);
  });

  it("does not sweep from openKnowledgeBase, which may be handed a subset", () => {
    indexAgentKnowledge(db, searchableAgent("a", PUBLICAR_DOC));
    indexAgentKnowledge(db, searchableAgent("b", PUBLICAR_DOC));
    openKnowledgeBase(db, [searchableAgent("a", PUBLICAR_DOC)]);
    expect(countIndexedChunks(db, "b")).toBeGreaterThan(0);
  });
});

/**
 * PER-AGENT ISOLATION — the security property of this phase.
 *
 * Both fixtures below hold the SAME document, so the only difference between
 * them is the agent id. A search that ignored the scope would return two hits
 * where these expect one, which is what makes this a pin rather than a
 * description: revert the scope and it fails.
 */
describe("search is scoped to one agent", () => {
  function twoAgentsWithTheSameDocument(): void {
    for (const id of ["agent-a", "agent-b"]) {
      const agent = loadAgentKnowledge(
        dir,
        writeAgent({
          id,
          searchable: ["knowledge/g.md"],
          tools: ["search_catalog", "search_knowledge"],
          docs: { "g.md": PUBLICAR_DOC },
        }),
        UNIVERSE,
      );
      indexAgentKnowledge(db, agent);
    }
  }

  it("returns only the calling agent's chunks when both hold identical content", async () => {
    twoAgentsWithTheSameDocument();
    const base = openKnowledgeBase(db, []);
    const hits = await base.search({ agentId: "agent-a", query: "publicar" });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.agentId).toBe("agent-a");
    // The unscoped answer is exactly twice this one; that is the mutation this
    // assertion exists to catch.
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for a term that exists only in another agent's document", async () => {
    const only = (id: string, body: string): AgentKnowledge =>
      loadAgentKnowledge(
        dir,
        writeAgent({
          id,
          searchable: ["knowledge/g.md"],
          tools: ["search_catalog", "search_knowledge"],
          docs: { "g.md": body },
        }),
        UNIVERSE,
      );
    indexAgentKnowledge(db, only("agent-a", "# A\n\n## Publicar\n\nTexto del agente A.\n"));
    indexAgentKnowledge(db, only("agent-b", "# B\n\n## Devoluciones\n\nPalabraexclusivadeb.\n"));

    const base = openKnowledgeBase(db, []);
    expect(await base.search({ agentId: "agent-a", query: "palabraexclusivadeb" })).toEqual([]);
    expect(
      (await base.search({ agentId: "agent-b", query: "palabraexclusivadeb" })).length,
    ).toBe(1);
  });

  it("returns nothing for an agent id that has no knowledge indexed", async () => {
    twoAgentsWithTheSameDocument();
    const base = openKnowledgeBase(db, []);
    expect(await base.search({ agentId: "agent-c", query: "publicar" })).toEqual([]);
  });
});

/**
 * The query is a person's own words, arriving through the model. FTS5 has its
 * own query grammar, so anything unescaped in it is either a syntax error that
 * fails the turn or an operator the person did not mean to write.
 */
describe("search handles whatever the query says", () => {
  beforeEach(() => {
    indexAgentKnowledge(
      db,
      loadAgentKnowledge(
        dir,
        writeAgent({
          id: "a",
          searchable: ["knowledge/g.md"],
          tools: ["search_catalog", "search_knowledge"],
          docs: { "g.md": PUBLICAR_DOC },
        }),
        UNIVERSE,
      ),
    );
  });

  it("does not throw on FTS operators, quotes or punctuation", async () => {
    const base = openKnowledgeBase(db, []);
    for (const query of [
      '"',
      "publicar AND",
      "NEAR(publicar",
      "-publicar",
      "publicar*",
      "^publicar",
      "publicar OR (",
      "¿qué significa publicar?",
    ]) {
      await expect(base.search({ agentId: "a", query })).resolves.toBeInstanceOf(Array);
    }
  });

  it("returns nothing for a query with no searchable words", async () => {
    const base = openKnowledgeBase(db, []);
    expect(await base.search({ agentId: "a", query: "  ¿? ..  " })).toEqual([]);
  });

  it("ignores accents in both directions", async () => {
    const base = openKnowledgeBase(db, []);
    expect((await base.search({ agentId: "a", query: "operacion" })).length).toBe(1);
    expect((await base.search({ agentId: "a", query: "operación" })).length).toBe(1);
  });

  /**
   * The regression that motivated stemming the query terms. FTS5's tokenizer
   * folds accents and does not stem, so an exact-word query answers "¿cómo
   * publico un producto?" with whatever section says "producto" most often —
   * measured against the shipped documents, that was "Retirar un producto de la
   * venta", which is the opposite of what was asked.
   */
  it("matches a Spanish inflection of an indexed word", async () => {
    const base = openKnowledgeBase(db, []);
    // "publico" shares no whole word with "publicar" or "publicarlo".
    expect((await base.search({ agentId: "a", query: "publico" })).length).toBe(1);
    expect((await base.search({ agentId: "a", query: "publicado" })).length).toBe(1);
  });

  // A question made entirely of function words is still a question. Filtering
  // it down to nothing would answer it with silence, which is the one answer
  // that teaches the model nothing about whether the base has the fact.
  it("falls back to the whole query when every word is a stopword", async () => {
    const base = openKnowledgeBase(db, []);
    await expect(base.search({ agentId: "a", query: "¿qué es esto?" })).resolves.toBeInstanceOf(
      Array,
    );
  });

  it("honours the limit", async () => {
    const base = openKnowledgeBase(db, []);
    expect((await base.search({ agentId: "a", query: "publicar producto", limit: 1 })).length).toBe(1);
  });
});

/**
 * The plan's own acceptance case for phase 4, tested at the RETRIEVAL layer:
 * the owner asks what "publicar" means and the knowledge that answers it comes
 * back. What the model then says with it is not something a test can pin.
 */
describe("the shipped glossary answers '¿qué significa publicar?'", () => {
  it("is retrievable from the searchable tier", async () => {
    const agent = loadAgentKnowledge(
      dir,
      writeAgent({
        id: "a",
        searchable: ["knowledge/glosario.md"],
        tools: ["search_catalog", "search_knowledge"],
        docs: { "glosario.md": SHIPPED_GLOSSARY },
      }),
      UNIVERSE,
    );
    indexAgentKnowledge(db, agent);
    const [best] = await openKnowledgeBase(db, []).search({
      agentId: "a",
      query: "¿qué significa publicar?",
    });
    expect(best?.heading).toMatch(/Publicar/);
    expect(best?.body).toMatch(/ACTIVO/);
  });

  it("is in the shipped owner's inline slice, so a resumed transcript still carries it", () => {
    const definition = loadDefinition(join(REPO_ROOT, "agents"), "vitrina-inventario");
    const knowledge = loadAgentKnowledge(join(REPO_ROOT, "agents"), definition, UNIVERSE);
    expect(knowledge.prompt.inlineText).toMatch(/ACTIVO y seguir invisible/);
    expect(knowledge.inlineTokens).toBeLessThanOrEqual(definition.knowledge.maxInlineTokens);
  });
});

/** The shipped definitions, loaded exactly as the composition root does. */
describe("the shipped knowledge base", () => {
  const agentsDir = join(REPO_ROOT, "agents");
  const shipped = () =>
    loadKnowledgeBase({
      db,
      agentsDir,
      definitions: ["vitrina-inventario", "vitrina-ventas"].map((id) =>
        loadDefinition(agentsDir, id),
      ),
      universe: UNIVERSE,
    });

  it("loads, indexes and validates both shipped agents", () => {
    const base = shipped();
    expect(base.promptFor("vitrina-inventario")?.inlineText.length).toBeGreaterThan(0);
    expect(countIndexedChunks(db, "vitrina-inventario")).toBeGreaterThan(0);
    // The customer agent is deliberately given no knowledge in this phase: its
    // prompt, and therefore its behaviour, must be exactly what it was.
    expect(base.promptFor("vitrina-ventas")).toBeUndefined();
    expect(countIndexedChunks(db, "vitrina-ventas")).toBe(0);
  });

  it("answers the owner's '¿cómo publico un producto?' from the searchable tier", async () => {
    const [best] = await shipped().search({
      agentId: "vitrina-inventario",
      query: "¿cómo publico un producto?",
    });
    expect(best?.source).toBe("operaciones.md");
    expect(best?.heading).toMatch(/Publicar/);
  });

  // The isolation property against the agents that actually ship, not only
  // against fixtures: the sales agent has no knowledge, and asking the store on
  // its behalf must not reach the inventory agent's documents.
  it("returns nothing to the sales agent, whose knowledge is deliberately empty", async () => {
    expect(await shipped().search({ agentId: "vitrina-ventas", query: "publicar" })).toEqual([]);
  });
});

/**
 * The index against a database that already exists.
 *
 * The two tables are NEW, so `CREATE TABLE IF NOT EXISTS` is the whole
 * migration — nothing here alters a table or adds a column, which is the case
 * db.ts's own comments warn about. This is the fixture that proves it: a
 * database with today's schema minus these two tables, reopened.
 */
describe("a database that predates the knowledge index", () => {
  it("gains the tables on the next boot and indexes into them", () => {
    db.exec(`DROP TABLE knowledge_chunks; DROP TABLE knowledge_index;`);
    expect(() => db.prepare(`SELECT 1 FROM knowledge_chunks`).get()).toThrow();

    createSchema(db);

    const agent = loadAgentKnowledge(
      dir,
      writeAgent({
        id: "a",
        searchable: ["knowledge/g.md"],
        tools: ["search_catalog", "search_knowledge"],
        docs: { "g.md": PUBLICAR_DOC },
      }),
      UNIVERSE,
    );
    expect(indexAgentKnowledge(db, agent)).toBe("indexed");
    expect(countIndexedChunks(db, "a")).toBeGreaterThan(0);
  });
});

/**
 * The tool. Its isolation is structural in two independent ways, and both are
 * pinned: the model cannot NAME an agent (there is no such parameter), and the
 * id the store is queried with comes from the turn.
 */
describe("the search_knowledge tool", () => {
  function turnContext(agentId: string): TurnContext {
    return {
      phone: "573000000000",
      role: "owner",
      agentId,
      conversationKey: "573000000000",
      turnKey: "msg:1",
    };
  }

  function toolFor(agentId: string, base: ReturnType<typeof openKnowledgeBase>) {
    const definition = writeAgent({
      id: agentId,
      searchable: ["knowledge/g.md"],
      tools: ["search_knowledge"],
      docs: { "g.md": PUBLICAR_DOC },
    });
    const fake = fakePorts();
    const { tools } = buildToolServer({
      definition,
      ctx: turnContext(agentId),
      ports: { ...fake.ports, knowledge: base },
    });
    const found = tools.find((t) => t.name === "search_knowledge");
    if (!found) throw new Error("search_knowledge was not served");
    return found;
  }

  async function call(
    tool: { handler: (args: never, extra: never) => Promise<{ content: { text?: string }[] }> },
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await tool.handler(args as never, undefined as never);
    return result.content.map((b) => b.text ?? "").join("");
  }

  it("is served only to a definition that declares it", () => {
    const withoutIt = writeAgent({ id: "plain", tools: ["search_catalog"] });
    const { tools } = buildToolServer({
      definition: withoutIt,
      ctx: turnContext("plain"),
      ports: fakePorts().ports,
    });
    expect(tools.map((t) => t.name)).not.toContain("search_knowledge");
  });

  it("gives the model no parameter that could name an agent", () => {
    const tool = toolFor("agent-a", openKnowledgeBase(db, []));
    for (const param of Object.keys(tool.inputSchema as Record<string, unknown>)) {
      expect(param).not.toMatch(/agent/i);
    }
  });

  it("returns the chunks of the agent whose turn it is", async () => {
    const agents = ["agent-a", "agent-b"].map((id) =>
      loadAgentKnowledge(
        dir,
        writeAgent({
          id,
          searchable: ["knowledge/g.md"],
          tools: ["search_knowledge"],
          docs: {
            "g.md":
              id === "agent-a"
                ? "# A\n\n## Publicar\n\nLo que sabe el agente A.\n"
                : "# B\n\n## Publicar\n\nSecretodelagenteb.\n",
          },
        }),
        UNIVERSE,
      ),
    );
    for (const agent of agents) indexAgentKnowledge(db, agent);
    const base = openKnowledgeBase(db, []);

    const answer = await call(toolFor("agent-a", base), { query: "publicar" });
    expect(answer).toContain("Lo que sabe el agente A");
    expect(answer).not.toContain("Secretodelagenteb");

    // And the same query on the other agent's turn sees only the other half.
    const other = await call(toolFor("agent-b", base), { query: "publicar" });
    expect(other).toContain("Secretodelagenteb");
    expect(other).not.toContain("Lo que sabe el agente A");
  });

  it("names the document and section each chunk came from", async () => {
    const agent = loadAgentKnowledge(
      dir,
      writeAgent({
        id: "agent-a",
        searchable: ["knowledge/g.md"],
        tools: ["search_knowledge"],
        docs: { "g.md": PUBLICAR_DOC },
      }),
      UNIVERSE,
    );
    indexAgentKnowledge(db, agent);
    const answer = await call(toolFor("agent-a", openKnowledgeBase(db, [])), {
      query: "publicar",
    });
    expect(answer).toContain("g.md");
    expect(answer).toContain("Publicar");
  });

  /**
   * A tool result is prompt surface: this caveat is said on EVERY call and not
   * once in the system prompt, for the same reason search_catalog repeats its
   * approximate-match warning — a system prompt sits far back in a resumed
   * transcript, and a keyword hit is a candidate rather than an answer.
   */
  it("repeats the caveat on every result", () => {
    const rendered = renderKnowledgeHits("publicar", [
      { agentId: "agent-a", source: "g.md", heading: "Publicar", body: "Texto." },
    ]);
    expect(rendered).toContain("Keyword matches");
    expect(rendered).toContain("a match is not proof");
    expect(rendered).toContain("[g.md · Publicar]");
    expect(rendered).toContain("Texto.");
  });

  it("says nothing matched rather than letting the model fill the gap", async () => {
    const answer = await call(toolFor("agent-a", openKnowledgeBase(db, [])), {
      query: "devoluciones",
    });
    expect(answer).toMatch(/no/i);
    expect(answer.length).toBeGreaterThan(0);
  });
});
