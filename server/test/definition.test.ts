import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/data/db.js";
import { CatalogCache } from "../src/shopify/cache.js";
import { ShopifyClient } from "../src/shopify/client.js";
import { allToolNames, buildToolServer, MCP_SERVER_NAME } from "../src/agent/tools.js";
import {
  loadAndValidateDefinitions,
  loadDefinition,
  validateDefinition,
  type ToolUniverse,
} from "../src/agent/definition.js";
import { AGENT_IDS, agentIdForRole } from "../src/router.js";
import { REPO_ROOT } from "../src/config.js";
import type { Config } from "../src/config.js";

const TEST_CONFIG = {
  shopifyStoreDomain: "tienda.myshopify.com",
  shopifyAdminToken: "shpat_x",
  shopifyApiVersion: "2026-01",
  shopifyLocationId: "",
} as Config;

// Every test below builds its own throwaway db: the fixture universe must not
// leak between tests, and better-sqlite3 handles are cheap in memory.
function toolUniverse(): ToolUniverse {
  const db = openDb(":memory:");
  const shopify = new ShopifyClient(TEST_CONFIG);
  const cache = new CatalogCache(shopify, 0);
  const names = allToolNames({ db, config: TEST_CONFIG, shopify, cache });
  db.close();
  return new Set(names);
}

const VALID_YAML = (overrides: Record<string, unknown> = {}) => {
  const base = {
    id: "fixture-agent",
    roles: ["owner"],
    model: { maxTurns: 12 },
    tools: ["search_catalog", "get_product"],
    prompt: { base: "grounding", persona: "prompt.md", slots: {} },
    knowledge: { inline: [], searchable: [], maxInlineTokens: 0 },
    session: { maxAgeDays: 7, resetOn: [], keyedBy: "principal" },
    reach: [],
    ...overrides,
  };
  return base;
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vitrina-definition-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAgent(id: string, yamlObj: Record<string, unknown>, personaText = "A persona."): string {
  const agentDir = join(dir, id);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.yaml"), stringifyYaml(yamlObj));
  writeFileSync(join(agentDir, "prompt.md"), personaText);
  return dir;
}

describe("loadDefinition", () => {
  it("loads a well-formed definition and its persona text", () => {
    writeAgent("fixture-agent", VALID_YAML());
    const definition = loadDefinition(dir, "fixture-agent");
    expect(definition.id).toBe("fixture-agent");
    expect(definition.tools).toEqual(["search_catalog", "get_product"]);
    expect(definition.personaText).toBe("A persona.");
  });

  it("fails on malformed YAML", () => {
    const agentDir = join(dir, "broken");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), "id: [unterminated");
    writeFileSync(join(agentDir, "prompt.md"), "persona");
    expect(() => loadDefinition(dir, "broken")).toThrow();
  });

  it("fails on an unknown top-level key", () => {
    writeAgent("fixture-agent", { ...VALID_YAML(), extra_field: "not part of the schema" });
    expect(() => loadDefinition(dir, "fixture-agent")).toThrow(/invalid/i);
  });

  it("fails on an unknown key inside a nested object", () => {
    writeAgent("fixture-agent", {
      ...VALID_YAML(),
      session: { maxAgeDays: 7, resetOn: [], keyedBy: "principal", extra: true },
    });
    expect(() => loadDefinition(dir, "fixture-agent")).toThrow(/invalid/i);
  });

  it("fails when a required field is missing", () => {
    const { model: _model, ...withoutModel } = VALID_YAML();
    writeAgent("fixture-agent", withoutModel);
    expect(() => loadDefinition(dir, "fixture-agent")).toThrow(/invalid/i);
  });

  it("fails when the declared id does not match the directory name", () => {
    writeAgent("fixture-agent", { ...VALID_YAML(), id: "some-other-id" });
    expect(() => loadDefinition(dir, "fixture-agent")).toThrow(/declares id/i);
  });

  it("fails when the persona file referenced by prompt.persona is missing", () => {
    const agentDir = join(dir, "fixture-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), stringifyYaml(VALID_YAML()));
    // No prompt.md written.
    expect(() => loadDefinition(dir, "fixture-agent")).toThrow(/persona file/i);
  });
});

describe("validateDefinition", () => {
  it("passes a definition whose tools[] and prompt agree", () => {
    writeAgent("fixture-agent", VALID_YAML(), "Uses search_catalog and get_product.");
    const definition = loadDefinition(dir, "fixture-agent");
    expect(() => validateDefinition(definition, toolUniverse())).not.toThrow();
  });

  // The hole the plan calls out: a persona naming a tool the definition never
  // granted used to produce an agent that asked for a tool it does not have —
  // silently, at conversation time, blaming itself rather than the definition.
  it("fails boot when the prompt mentions a tool outside tools[]", () => {
    writeAgent(
      "fixture-agent",
      VALID_YAML({ tools: ["search_catalog"] }),
      "Call get_product to check details.",
    );
    const definition = loadDefinition(dir, "fixture-agent");
    expect(() => validateDefinition(definition, toolUniverse())).toThrow(/get_product/);
  });

  it("fails boot when tools[] names a tool this build does not serve", () => {
    writeAgent("fixture-agent", VALID_YAML({ tools: ["search_catalog", "teleport_product"] }));
    const definition = loadDefinition(dir, "fixture-agent");
    expect(() => validateDefinition(definition, toolUniverse())).toThrow(/teleport_product/);
  });

  it("fails boot when session.resetOn names a tool this build does not serve", () => {
    writeAgent(
      "fixture-agent",
      VALID_YAML({ session: { maxAgeDays: 7, resetOn: ["teleport_product"], keyedBy: "principal" } }),
    );
    const definition = loadDefinition(dir, "fixture-agent");
    expect(() => validateDefinition(definition, toolUniverse())).toThrow(/teleport_product/);
  });

  it("fails boot when session.resetOn names a real tool this agent was not given", () => {
    writeAgent(
      "fixture-agent",
      VALID_YAML({
        tools: ["search_catalog"],
        session: { maxAgeDays: 7, resetOn: ["update_product"], keyedBy: "principal" },
      }),
    );
    const definition = loadDefinition(dir, "fixture-agent");
    expect(() => validateDefinition(definition, toolUniverse())).toThrow(/update_product/);
  });

  it("does not flag ordinary prose that merely resembles a tool name", () => {
    // "search catalog" (spaces, no underscore) is not the literal tool name —
    // this is the boundary of what word-boundary matching can and cannot see.
    writeAgent(
      "fixture-agent",
      VALID_YAML({ tools: ["search_catalog"] }),
      "Use the search catalog feature to answer questions.",
    );
    const definition = loadDefinition(dir, "fixture-agent");
    expect(() => validateDefinition(definition, toolUniverse())).not.toThrow();
  });
});

describe("loadAndValidateDefinitions", () => {
  it("loads and validates every id, or throws before returning any of them", () => {
    writeAgent("good-one", VALID_YAML({ id: "good-one" }));
    writeAgent("bad-one", VALID_YAML({ id: "bad-one", tools: ["not_a_real_tool"] }));
    expect(() => loadAndValidateDefinitions(dir, ["good-one", "bad-one"], toolUniverse())).toThrow();
  });

  it("returns a definition per id when every one is valid", () => {
    writeAgent("good-one", VALID_YAML({ id: "good-one" }));
    writeAgent("good-two", VALID_YAML({ id: "good-two" }));
    const definitions = loadAndValidateDefinitions(dir, ["good-one", "good-two"], toolUniverse());
    expect([...definitions.keys()].sort()).toEqual(["good-one", "good-two"]);
  });
});

/**
 * The privilege boundary, pinned again from the definition side before Phase 3
 * makes `tools[]` the authority `buildToolServer` actually reads. Derived from
 * `buildToolServer` itself — the same way tools.test.ts derives it — so the
 * two pins cannot drift into agreeing with each other instead of with the code.
 */
describe("shipped definitions match buildToolServer's tool sets", () => {
  function toolNamesFor(role: "owner" | "customer"): Set<string> {
    const db = openDb(":memory:");
    const shopify = new ShopifyClient(TEST_CONFIG);
    const cache = new CatalogCache(shopify, 0);
    const { toolNames } = allToolNamesForRole({ db, config: TEST_CONFIG, shopify, cache }, role);
    db.close();
    return new Set(toolNames);
  }

  // allToolNames always builds the owner (superset) role; the per-role set for
  // this pin has to go through buildToolServer directly instead.
  function allToolNamesForRole(
    deps: { db: ReturnType<typeof openDb>; config: Config; shopify: ShopifyClient; cache: CatalogCache },
    role: "owner" | "customer",
  ) {
    const { toolNames } = buildToolServer({
      ...deps,
      ctx: {
        phone: "573000000000",
        role,
        agentId: agentIdForRole(role),
        conversationKey: "573000000000",
        turnKey: "msg:1",
      },
    });
    return { toolNames: toolNames.map((n) => n.replace(`mcp__${MCP_SERVER_NAME}__`, "")) };
  }

  it("vitrina-inventario's tools[] equals what the owner role is served", () => {
    const definition = loadDefinition(join(REPO_ROOT, "agents"), AGENT_IDS.owner);
    expect(new Set(definition.tools)).toEqual(toolNamesFor("owner"));
  });

  it("vitrina-ventas' tools[] equals what the customer role is served", () => {
    const definition = loadDefinition(join(REPO_ROOT, "agents"), AGENT_IDS.customer);
    expect(new Set(definition.tools)).toEqual(toolNamesFor("customer"));
  });
});

/** The two shipped definitions load and validate cleanly against the real registry. */
describe("shipped definitions", () => {
  it("both load and validate against the real tool universe", () => {
    const definitions = loadAndValidateDefinitions(
      join(REPO_ROOT, "agents"),
      Object.values(AGENT_IDS),
      toolUniverse(),
    );
    expect([...definitions.keys()].sort()).toEqual([...Object.values(AGENT_IDS)].sort());
  });
});
