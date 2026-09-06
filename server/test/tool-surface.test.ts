import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { loadDefinition } from "../src/agent/definition.js";
import { buildToolServer, TOOL_REGISTRY } from "../src/tools/registry.js";
import {
  cartPermalink,
  storefrontHost,
} from "../src/shopify/catalog-port.js";
import {
  describeProduct,
  newOptionValues,
  renderProductList,
  renderSearchHits,
  whyVariantsCannotBeAdded,
} from "../src/tools/packs/catalog.js";
import { runRenderCases } from "./helpers/render-cases.js";
import { serializeTool, type ToolSurface } from "./helpers/tool-surface.js";
import { fakePorts } from "./helpers/fake-ports.js";
import { AGENT_IDS } from "../src/router.js";

const AGENTS_DIR = join(REPO_ROOT, "agents");
const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

/**
 * Captured from `agent/tools.ts` BEFORE the registry split, with the tool set
 * still chosen by `ctx.role`: fixtures/tool-surface.json is the owner's
 * fourteen tools and the customer's four, exactly as the model saw them.
 *
 * A description and a parameter schema are prompt surface. Rewording one
 * changes how the model behaves and no functional test would notice, so this is
 * the only thing standing between "the descriptions became templates" and "the
 * descriptions were rewritten". Slot rendering is included by construction:
 * both shipped definitions declare `slots: {}`, so every template must fall
 * back to the literal it replaced.
 *
 * ONE ENTRY HAS A DIFFERENT PROVENANCE, and it matters for how much this
 * fixture is worth as evidence: `search_knowledge` (owner, last in the array)
 * has NO pre-split counterpart — the tool was introduced by phase 4's knowledge
 * base, so its entry was captured from the code that introduced it rather than
 * from agent/tools.ts. Every other entry here predates the registry split and
 * is the byte-identity evidence for it. Do not regenerate the whole file: that
 * would silently turn all of it into a snapshot of current code, which proves
 * nothing about what the descriptions used to say.
 */
function goldenSurface(): Record<string, ToolSurface[]> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "tool-surface.json"), "utf8")) as Record<
    string,
    ToolSurface[]
  >;
}

function surfaceFor(agentId: string): ToolSurface[] {
  const definition = loadDefinition(AGENTS_DIR, agentId);
  const { tools } = buildToolServer({
    definition,
    ctx: {
      phone: "573000000000",
      role: "customer",
      agentId,
      conversationKey: "573000000000",
      turnKey: "msg:1",
    },
    ports: fakePorts().ports,
  });
  return tools.map(serializeTool);
}

describe("tool surface golden fixtures", () => {
  for (const agentId of Object.values(AGENT_IDS)) {
    it(`serves ${agentId} the same descriptions and parameter schemas as before the split`, () => {
      expect(surfaceFor(agentId)).toEqual(goldenSurface()[agentId]);
    });
  }

  // The role is passed deliberately WRONG above — every definition is built
  // with role "customer" — because after this phase the role must not be able
  // to change a tool, a description or a schema. Building the owner's fourteen
  // tools under it and still matching the fixture is what proves it.
  it("renders the same surface whatever role the turn context carries", () => {
    const definition = loadDefinition(AGENTS_DIR, AGENT_IDS.owner);
    const build = (role: "owner" | "customer"): ToolSurface[] =>
      buildToolServer({
        definition,
        ctx: {
          phone: "573000000000",
          role,
          agentId: AGENT_IDS.owner,
          conversationKey: "573000000000",
          turnKey: "msg:1",
        },
        ports: fakePorts().ports,
      }).tools.map(serializeTool);
    expect(build("owner")).toEqual(build("customer"));
  });

  // A template whose slot nothing fills would reach the model as literal
  // "{{example_variants_json}}" — a silent prompt regression that renders,
  // ships and reads fine in the code.
  it("leaves no unrendered {{slot}} in any description the registry can serve", () => {
    for (const surfaces of Object.values(goldenSurface())) {
      for (const surface of surfaces) {
        expect(surface.description).not.toMatch(/\{\{/);
        for (const param of Object.values(surface.params)) {
          for (const description of param.descriptions) expect(description).not.toMatch(/\{\{/);
        }
      }
    }
    expect(TOOL_REGISTRY.size).toBeGreaterThan(0);
  });
});

/**
 * The strings a tool hands BACK to the model, pinned the same way and for the
 * same reason: the caveat on an approximate search, the scope of an empty
 * inventory answer and the SOLD OUT marker are all instructions the model acts
 * on, and all of them survive a refactor that merely "moved a renderer".
 */
describe("rendered tool results golden fixtures", () => {
  it("reproduces every renderer's output exactly", () => {
    const expected = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "tool-results.json"), "utf8"),
    ) as Record<string, string>;
    expect(
      runRenderCases({
        describeProduct,
        renderSearchHits,
        renderProductList,
        whyVariantsCannotBeAdded,
        newOptionValues,
        storefrontHost,
        cartPermalink,
      }),
    ).toEqual(expected);
  });
});
