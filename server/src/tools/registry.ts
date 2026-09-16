import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, ToolUniverse } from "../agent/definition.js";
import { ASK_AGENT_TOOL, SEARCH_KNOWLEDGE_TOOL } from "../agent/definition.js";
import { searchKnowledge } from "../knowledge/tool.js";
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
import { askAgent } from "./packs/agents.js";
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
  // Served to nobody in this build: neither shipped definition declares it, and
  // giving one of them the ability to ask another assistant is a decision about
  // what a CUSTOMER-facing agent can reach, not a wiring detail. Enabling it is
  // an edit to an agent.yaml (tools[] plus a reach entry), which the boot
  // validator checks as a pair.
  [ASK_AGENT_TOOL, { name: ASK_AGENT_TOOL, create: askAgent }],
  // The key is the constant agent/definition.ts validates the pairing against,
  // so the name the boot check looks for and the name the registry serves
  // cannot drift apart.
  [SEARCH_KNOWLEDGE_TOOL, { name: SEARCH_KNOWLEDGE_TOOL, create: searchKnowledge }],
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
 * One executed tool call, as the durable trace takes it.
 *
 * A NARROW PORT, not a database handle — the same shape and the same reasoning
 * as ConversationRecorder in egress/responder.ts. This module's job is building
 * the tool server; the write belongs to data/repo.ts, and injecting it keeps
 * every existing test of this registry free of a real database.
 *
 * IMPLEMENTATIONS MUST NOT THROW, and `traced` below ENFORCES that rather than
 * trusting it. This is called inside a live tool call, after the tool has
 * already run — quite possibly a write against a live store. A throw escaping
 * here would fail the turn, return the inbox batch to 'pending', and run that
 * write a second time on the retry: an observability feature corrupting the
 * thing it observes. The composition root catches and LOGS (see
 * agent/runtime.ts, the same shape as responder.ts recordSafely), so a
 * violation is visible; the wrapper's own catch is what makes it harmless.
 */
export interface ToolCallRecorder {
  record(call: {
    /** The name the model called, with no `mcp__vitrina__` prefix. */
    toolName: string;
    /** Position in this turn's call sequence, from 1. */
    ordinal: number;
    input: unknown;
    /** What the model was handed back, or the error message when it threw. */
    result: string;
    /** 'error' means the handler THREW; a business refusal is 'ok' with the refusal text. */
    outcome: "ok" | "error";
    durationMs: number;
  }): void;
}

/**
 * The text a tool handed back, out of the SDK's content-block shape.
 *
 * Every tool here returns `text()` from factory.ts — one text block — so this
 * is normally one string. It tolerates the general shape anyway rather than
 * indexing `[0]`: this runs on the result of a live call, and a tool that one
 * day returns two blocks must show both in the trace rather than silently
 * showing the first and looking complete.
 */
function resultText(value: unknown): string {
  const content = (value as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const text = (block as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Wrap one tool so every call it serves is traced.
 *
 * THE RESULT IS CAPTURED HERE RATHER THAN PARSED OUT OF THE SDK STREAM, and
 * that is the design decision worth stating. The stream carries `tool_result`
 * blocks and they could be read — runtime.ts already reads `tool_use` from it —
 * but this wrapper sees the exact value the handler produced, before any
 * transport has touched it, and it keeps working across an SDK release that
 * reshapes its messages. What the stream has that this does not is a call the
 * model ASKED for but that never executed (refused by canUseTool, or rejected
 * against the tool's schema); those never reach a handler, and runtime.ts
 * already logs the refusal branch.
 *
 * A THROW IS RECORDED AND RETHROWN, never swallowed. factory.ts `failure` is
 * explicit that only a business-rule refusal is reported back to the model and
 * anything else propagates so the turn fails, the batch retries, and the person
 * gets the apology instead of an invented answer. Swallowing here would convert
 * every one of those into a silent success.
 */
function traced(tool: SdkTool, recorder: ToolCallRecorder, nextOrdinal: () => number): SdkTool {
  /**
   * The recorder's contract is that it does not throw, and this is what makes a
   * violation harmless rather than catastrophic: by the time it runs the tool
   * has already executed, so letting it propagate would fail the turn and
   * re-run that execution on the batch retry. It cannot log — this module has
   * no logger and takes no dependency on one — so the visibility lives in the
   * implementation, which does (agent/runtime.ts).
   */
  const recordSafely = (call: Parameters<ToolCallRecorder["record"]>[0]): void => {
    try {
      recorder.record(call);
    } catch {
      // Swallowed by design; see above. The implementation logs.
    }
  };

  return {
    ...tool,
    handler: async (args: unknown, extra: unknown) => {
      // Taken BEFORE the call, so concurrent tools (the SDK may run several in
      // one assistant turn) keep the order the model issued them in rather than
      // the order they happened to finish.
      const ordinal = nextOrdinal();
      const startedAt = Date.now();
      try {
        const value = await tool.handler(args, extra);
        recordSafely({
          toolName: tool.name,
          ordinal,
          input: args,
          result: resultText(value),
          outcome: "ok",
          durationMs: Date.now() - startedAt,
        });
        return value;
      } catch (err) {
        recordSafely({
          toolName: tool.name,
          ordinal,
          input: args,
          result: err instanceof Error ? err.message : String(err),
          outcome: "error",
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
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
 *
 * `recorder` is OPTIONAL and absent means untraced. Not because tracing is
 * negotiable in the server — the composition root always passes one — but
 * because this function is called by tests that have no database, and a
 * required port would have made every one of them build a stub for a concern
 * they are not testing.
 */
export function buildToolServer(input: {
  definition: AgentDefinition;
  ctx: TurnContext;
  ports: ToolPorts;
  recorder?: ToolCallRecorder;
}): { server: ReturnType<typeof createSdkMcpServer>; toolNames: string[]; tools: SdkTool[] } {
  const { definition, ctx, ports, recorder } = input;
  const toolContext = newToolContext(ctx, definition.prompt.slots);

  // ONE sequence for the whole turn, shared by every tool — the same reasoning
  // as the inventory counter in factory.ts. A per-tool counter would number two
  // different tools' calls 1, 1, 2 and the trace would not say which came
  // first, which is the one thing an ordinal exists to say.
  let calls = 0;
  const nextOrdinal = (): number => {
    calls += 1;
    return calls;
  };

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
    const tool = entry.create(toolContext, ports);
    tools.push(recorder ? traced(tool, recorder, nextOrdinal) : tool);
  }

  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools }),
    toolNames: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
    tools,
  };
}
