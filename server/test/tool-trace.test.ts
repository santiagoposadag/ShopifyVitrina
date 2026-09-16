import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/data/db.js";
import {
  deleteConversationToolCalls,
  listConversationToolCalls,
  recordToolCall,
} from "../src/data/repo.js";
import { buildToolServer, type ToolCallRecorder } from "../src/tools/registry.js";
import { text } from "../src/tools/factory.js";
import type { AgentDefinition } from "../src/agent/definition.js";
import type { ToolPorts } from "../src/tools/ports.js";
import type { TurnContext } from "../src/types.js";
import { AGENT_IDS } from "../src/router.js";

/**
 * The durable trace of what the assistant DID.
 *
 * `conversation_messages` answers "what words were exchanged" and cannot answer
 * "where did that number come from" or "did the write actually happen" — a
 * reply saying the price changed reads identically whether it did, was refused,
 * or was never attempted. This suite defends the two halves that make the trace
 * trustworthy:
 *
 *  1. THE WRITER IS SAFE ON A RETRY, because delivery is at-least-once and a
 *     failed batch re-runs the whole turn under the same turn key.
 *  2. THE WRAPPER SEES EVERY CALL AND CHANGES NONE OF THEM — same result to the
 *     model, same throw on the error path, and a recorder that blows up cannot
 *     take a live tool call with it.
 */

const PHONE = "573001112233";
const INVENTORY = AGENT_IDS.owner;

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function call(overrides: Partial<Parameters<typeof recordToolCall>[1]> = {}) {
  return recordToolCall(db, {
    conversationKey: PHONE,
    agentId: INVENTORY,
    turnKey: "t1",
    ordinal: 1,
    toolName: "search_catalog",
    toolInput: { query: "camisa" },
    result: "1. Camisa negra — match=91%",
    outcome: "ok",
    durationMs: 120,
    ...overrides,
  });
}

describe("recordToolCall: idempotent where a retry repeats itself", () => {
  it("writes the call once and reports it", () => {
    expect(call()).toBe(true);
    expect(listConversationToolCalls(db, PHONE, INVENTORY)).toHaveLength(1);
  });

  /**
   * A failed batch returns its rows to 'pending' and the next flush claims them
   * again under the SAME turn key — it is minted from the first inbox row and
   * is stable across attempts by construction. A replay that does the same work
   * really did the same work, and one row is the honest record of it.
   */
  it("collapses a replay that ran the same tool with the same arguments and got the same answer", () => {
    call();
    expect(call()).toBe(false);
    expect(listConversationToolCalls(db, PHONE, INVENTORY)).toHaveLength(1);
  });

  /**
   * The case that decides the key's shape. A replay whose answer DIVERGED — the
   * store changed between attempts — is the most valuable thing this table can
   * show, and keying on (turn, ordinal) alone would hide the second behind the
   * first. Same reasoning as recordOutboundMessage's own key.
   */
  it("keeps both when a replay got a different answer", () => {
    call({ result: "1. Camisa negra — AGOTADA" });
    call({ result: "1. Camisa negra — 4 disponibles" });

    const rows = listConversationToolCalls(db, PHONE, INVENTORY);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.result)).toEqual([
      "1. Camisa negra — AGOTADA",
      "1. Camisa negra — 4 disponibles",
    ]);
  });

  it("keeps both when a replay called the same tool with different arguments", () => {
    call({ toolInput: { query: "camisa" } });
    call({ toolInput: { query: "camisa negra" } });

    expect(listConversationToolCalls(db, PHONE, INVENTORY)).toHaveLength(2);
  });

  /**
   * Two calls to one tool inside one turn are ordinary ("busca camisas y
   * pantalones"). The ordinal is what tells them apart, exactly as the
   * inventory idempotency counter does for two stock movements in one turn.
   */
  it("keeps two identical calls that happened at different points in one turn", () => {
    call({ ordinal: 1 });
    call({ ordinal: 2 });

    expect(listConversationToolCalls(db, PHONE, INVENTORY)).toHaveLength(2);
  });
});

describe("recordToolCall: bounded, and visibly so", () => {
  it("keeps a large result whole when it fits", () => {
    const body = "x".repeat(15_000);
    call({ result: body });

    expect(listConversationToolCalls(db, PHONE, INVENTORY)[0]?.result).toBe(body);
  });

  /**
   * A silent cut is the failure worth a test: a trace ending mid-sentence reads
   * as a tool that returned less than it did, to a reader whose entire purpose
   * is finding out what the tool returned.
   */
  it("marks a truncated result rather than cutting it silently", () => {
    call({ result: "y".repeat(20_000) });

    const stored = listConversationToolCalls(db, PHONE, INVENTORY)[0]?.result ?? "";
    expect(stored).toContain("[truncado:");
    expect(stored).toContain("4000 caracteres más");
  });

  /**
   * The writer runs inside a live tool call. JSON.stringify throws on a
   * circular structure, and a trace writer that can throw would turn
   * observability into a way to fail a turn — over a store the tool may have
   * already written to.
   */
  it("records an unserialisable input as itself instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => call({ toolInput: circular })).not.toThrow();
    expect(listConversationToolCalls(db, PHONE, INVENTORY)[0]?.input).toContain("no serializable");
  });
});

describe("listConversationToolCalls / deleteConversationToolCalls: scoped by agent", () => {
  it("never returns the other persona's calls for the same phone", () => {
    call({ agentId: INVENTORY, toolName: "update_product" });
    call({ agentId: AGENT_IDS.customer, toolName: "search_catalog" });

    expect(listConversationToolCalls(db, PHONE, INVENTORY).map((r) => r.tool_name)).toEqual([
      "update_product",
    ]);
  });

  /**
   * The scope is mandatory for the reason deleteConversationMessages documents:
   * one key holds rows under both personas, and an unscoped delete would take a
   * spared persona's trace with it.
   */
  it("deletes only the named persona's calls", () => {
    call({ agentId: INVENTORY });
    call({ agentId: AGENT_IDS.customer });

    expect(deleteConversationToolCalls(db, PHONE, AGENT_IDS.customer)).toBe(1);
    expect(listConversationToolCalls(db, PHONE, INVENTORY)).toHaveLength(1);
  });
});

// --- The wrapper -------------------------------------------------------------

const CTX: TurnContext = {
  principal: { kind: "whatsapp", phone: PHONE },
  phone: PHONE,
  role: "owner",
  agentId: INVENTORY,
  conversationKey: PHONE,
  turnKey: "t1",
  hop: 0,
};

/**
 * A definition serving exactly one fake tool, so the wrapper is tested without
 * a Shopify port or a real pack behind it. The registry is keyed by name, so
 * the tool under test is a real registry entry driven by a stub port.
 */
function definitionWith(tools: string[]): AgentDefinition {
  return {
    id: INVENTORY,
    tools,
    prompt: { slots: {} },
    model: { maxTurns: 12 },
  } as unknown as AgentDefinition;
}

/** The text a tool handed back, out of the SDK's content-block shape. */
function resultTextOf(value: unknown): string {
  const content = (value as { content?: { text?: string }[] }).content ?? [];
  return content.map((b) => b.text ?? "").join("\n");
}

/** A ports stub whose catalog answers `locations()` with what the test names. */
function portsWithLocations(impl: () => Promise<unknown>): ToolPorts {
  return { catalog: { locations: impl } } as unknown as ToolPorts;
}

describe("buildToolServer: the wrapper around every tool", () => {
  /**
   * The wrapper is transparent to the model: it records, and hands back the
   * handler's own value untouched. A wrapper that reshaped a result would
   * change what the assistant reads without changing what the trace shows,
   * which is the one failure a trace cannot reveal about itself.
   */
  it("records a call and returns the handler's own value unchanged", async () => {
    const recorded: Parameters<ToolCallRecorder["record"]>[0][] = [];
    const recorder: ToolCallRecorder = { record: (c) => void recorded.push(c) };

    const { tools } = buildToolServer({
      definition: definitionWith(["list_locations"]),
      ctx: CTX,
      ports: portsWithLocations(async () => [
        { id: "gid://shopify/Location/1", name: "Bodega" },
      ]),
      recorder,
    });

    const returned = await tools[0]!.handler({}, undefined);

    // What the model gets is what the tool produced, in the shape factory.ts
    // `text` builds.
    expect(returned).toEqual(text(resultTextOf(returned)));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      toolName: "list_locations",
      ordinal: 1,
      outcome: "ok",
    });
    // The recorded result is the exact text handed to the model, not a summary.
    expect(recorded[0]?.result).toBe(resultTextOf(returned));
    expect(recorded[0]?.result).toContain("Bodega");
  });

  /**
   * The ordinal is ONE sequence for the whole turn, shared by every tool. A
   * per-tool counter would number two different tools' calls 1, 1, 2 and the
   * trace would not say which came first — the one thing an ordinal exists to
   * say.
   */
  it("numbers calls across different tools in one sequence", async () => {
    const recorded: Parameters<ToolCallRecorder["record"]>[0][] = [];
    const recorder: ToolCallRecorder = { record: (c) => void recorded.push(c) };

    const { tools } = buildToolServer({
      definition: definitionWith(["list_locations", "list_leads"]),
      ctx: CTX,
      ports: {
        catalog: { locations: async () => [] },
        leads: { list: async () => [] },
      } as unknown as ToolPorts,
      recorder,
    });

    for (const tool of tools) {
      await tool.handler({}, undefined).catch(() => undefined);
    }

    expect(recorded.map((c) => c.ordinal)).toEqual([1, 2]);
    expect(new Set(recorded.map((c) => c.toolName)).size).toBe(2);
  });

  /**
   * factory.ts is explicit that only a business-rule refusal is reported back
   * to the model and anything else propagates, so the turn fails, the batch
   * retries, and the person gets the apology rather than an invented answer.
   * Swallowing here would convert every one of those into a silent success.
   */
  it("records a throw as an error and rethrows it unchanged", async () => {
    const recorded: Parameters<ToolCallRecorder["record"]>[0][] = [];
    const recorder: ToolCallRecorder = { record: (c) => void recorded.push(c) };
    const boom = new Error("la red se cayó");

    const { tools } = buildToolServer({
      definition: definitionWith(["list_locations"]),
      ctx: CTX,
      ports: portsWithLocations(async () => {
        throw boom;
      }),
      recorder,
    });

    await expect(tools[0]!.handler({}, undefined)).rejects.toThrow("la red se cayó");
    expect(recorded[0]).toMatchObject({ outcome: "error", result: "la red se cayó" });
  });

  /**
   * The port's contract says implementations must not throw, and the real one
   * (agent/runtime.ts) catches and logs. This pins that a recorder which
   * violates it still cannot take a live tool call down — by the time it runs,
   * the tool has already executed, quite possibly a write against a live store.
   */
  it("does not let a broken recorder fail a tool that already ran", async () => {
    const recorder: ToolCallRecorder = {
      record: () => {
        throw new Error("disco lleno");
      },
    };

    const { tools } = buildToolServer({
      definition: definitionWith(["list_locations"]),
      ctx: CTX,
      ports: portsWithLocations(async () => []),
      recorder,
    });

    await expect(tools[0]!.handler({}, undefined)).resolves.toBeDefined();
  });

  it("serves an identical tool set whether or not a recorder is attached", () => {
    const withRecorder = buildToolServer({
      definition: definitionWith(["list_locations", "list_leads"]),
      ctx: CTX,
      ports: {} as unknown as ToolPorts,
      recorder: { record: vi.fn() },
    });
    const without = buildToolServer({
      definition: definitionWith(["list_locations", "list_leads"]),
      ctx: CTX,
      ports: {} as unknown as ToolPorts,
    });

    expect(withRecorder.toolNames).toEqual(without.toolNames);
    expect(withRecorder.tools.map((t) => t.name)).toEqual(without.tools.map((t) => t.name));
  });
});
