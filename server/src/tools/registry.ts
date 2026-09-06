import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, ToolUniverse } from "../agent/definition.js";
import type { TurnContext } from "../types.js";
import { newToolContext, type SdkTool, type ToolFactory } from "./factory.js";
import type { ToolPorts } from "./ports.js";
import {
  addVariant,
  adjustInventory,
  createProduct,
  deleteProduct,
  getInventory,
  getProduct,
  getProductAnyStatus,
  listLocations,
  listProducts,
  searchCatalog,
  updateProduct,
} from "./packs/catalog.js";
import { buildCart } from "./packs/cart.js";
import { listLeads, saveLead } from "./packs/leads.js";
import { attachPendingPhotos } from "./packs/media.js";

export const MCP_SERVER_NAME = "vitrina";

export { newToolContext } from "./factory.js";

/**
 * One entry in the registry.
 *
 * `name` is what the MODEL sees; the map key is what a DEFINITION names. They
 * are usually the same string and deliberately not the same concept: two
 * entries may expose one name where the behaviour differs but the vocabulary
 * must not. `get_product` is that case — both personas name `get_product` in
 * prose, and the Phase 2 validator checks that prose against the declared list,
 * so the customer's ACTIVE-only reader and the owner's any-status reader are
 * two keys under one exposed name rather than one tool with a role switch.
 */
export interface ToolEntry {
  name: string;
  create: ToolFactory;
}

/**
 * Every tool this build can serve, keyed by the name a definition uses.
 *
 * This map IS the authority: `agent/definition.ts` validates `tools[]` and
 * `session.resetOn` against it at boot, and `buildToolServer` serves exactly
 * what a definition names and nothing else. A tool added to a pack reaches
 * nobody until some agent.yaml asks for it.
 */
export const TOOL_REGISTRY: ReadonlyMap<string, ToolEntry> = new Map<string, ToolEntry>([
  ["search_catalog", { name: "search_catalog", create: searchCatalog }],
  ["get_product", { name: "get_product", create: getProduct }],
  ["get_product_any_status", { name: "get_product", create: getProductAnyStatus }],
  ["save_lead", { name: "save_lead", create: saveLead }],
  ["build_cart", { name: "build_cart", create: buildCart }],
  ["list_products", { name: "list_products", create: listProducts }],
  ["create_product", { name: "create_product", create: createProduct }],
  ["update_product", { name: "update_product", create: updateProduct }],
  ["add_variant", { name: "add_variant", create: addVariant }],
  ["delete_product", { name: "delete_product", create: deleteProduct }],
  ["get_inventory", { name: "get_inventory", create: getInventory }],
  ["adjust_inventory", { name: "adjust_inventory", create: adjustInventory }],
  ["attach_pending_photos", { name: "attach_pending_photos", create: attachPendingPhotos }],
  ["list_locations", { name: "list_locations", create: listLocations }],
  ["list_leads", { name: "list_leads", create: listLeads }],
]);

/**
 * What the boot validator checks a definition against.
 *
 * Both halves are needed and they are not the same set: `tools[]` names KEYS,
 * while a persona's prose names what the model sees. Checking prose against
 * keys would fail an owner persona that says `get_product` while declaring
 * `get_product_any_status` — the exact pairing the two entries exist for.
 */
export function toolUniverse(): ToolUniverse {
  return {
    keys: new Set(TOOL_REGISTRY.keys()),
    exposedNames: new Map([...TOOL_REGISTRY].map(([key, entry]) => [key, entry.name])),
  };
}

/**
 * Build the in-process MCP server for ONE turn of ONE agent.
 *
 * The served set is `definition.tools[]` — no role is consulted anywhere in
 * here, which is the whole point: the privilege boundary is data, and the same
 * definition serves the same tools whoever the turn belongs to.
 *
 * Every tool of the turn is built from ONE ToolContext, which is what keeps the
 * inventory idempotency counter a single sequence per turn rather than one per
 * pack (see factory.ts).
 */
export function buildToolServer(input: {
  definition: AgentDefinition;
  ctx: TurnContext;
  ports: ToolPorts;
}): { server: ReturnType<typeof createSdkMcpServer>; toolNames: string[]; tools: SdkTool[] } {
  const { definition, ctx, ports } = input;
  const toolContext = newToolContext(ctx, definition.prompt.slots);

  const tools: SdkTool[] = [];
  const exposed = new Set<string>();
  for (const key of definition.tools) {
    const entry = TOOL_REGISTRY.get(key);
    if (!entry) {
      // Unreachable through a validated definition (definition.ts fails boot on
      // it). Reached only by a definition built in memory, and a turn served
      // with a silently missing tool is worse than a turn that fails loudly.
      throw new Error(
        `Agent "${definition.id}" declares tool "${key}", which is not in the registry`,
      );
    }
    if (exposed.has(entry.name)) {
      // Two tools of one name on one MCP server is a coin flip over which one
      // the model reaches — and with get_product that coin decides whether a
      // customer can read a draft.
      throw new Error(
        `Agent "${definition.id}" declares two tools exposed as "${entry.name}"`,
      );
    }
    exposed.add(entry.name);
    tools.push(entry.create(toolContext, ports));
  }

  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools }),
    toolNames: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
    tools,
  };
}
