import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/data/db.js";
import type { WhatsAppChannel } from "../src/whatsapp/channel.js";
import { getSessionId, setSessionId } from "../src/data/repo.js";
import { Responders } from "../src/egress/responder.js";
import { whatsappPrincipal } from "../src/inbox/envelope.js";
import { agentIdForRole } from "../src/router.js";
import { CatalogCache } from "../src/shopify/cache.js";
import { ShopifyClient } from "../src/shopify/client.js";
import type { Role, TurnContext } from "../src/types.js";

// Only `query` is faked; tools.ts imports createSdkMcpServer/tool from the same
// module and needs the real ones to build the MCP server.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importActual) => ({
  ...(await importActual<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: queryMock,
}));

const { runAgentTurn, systemPrompt, NO_ANSWER_FALLBACK } = await import("../src/agent/agent.js");

const PHONE = "573001112233";

/**
 * A turn context exactly as the batcher builds one for a WhatsApp burst: the
 * conversation key IS the phone on this door, and the agent id comes from the
 * role rather than from anything the person wrote.
 */
function ctxFor(role: Role): TurnContext {
  return {
    phone: PHONE,
    role,
    agentId: agentIdForRole(role),
    conversationKey: PHONE,
    turnKey: "msg:1",
  };
}

const CTX: TurnContext = ctxFor("customer");

const CONFIG: Config = {
  anthropicApiKey: "sk-test",
  agentAuthToken: "",
  agentBaseUrl: "https://api.anthropic.com",
  webhookSecret: "whsec",
  whatsappProvider: "bridge",
  whatsappVerifyToken: "",
  whatsappPhoneNumberId: "",
  whatsappAccessToken: "",
  whatsappGraphBaseUrl: "https://graph.facebook.com",
  whatsappGraphVersion: "v23.0",
  bridgeUrl: "http://bridge:3002",
  bridgeApiToken: "bridge-token",
  bridgeStagingDir: "/tmp/inbound",
  ownerPhoneNumbers: new Set<string>(),
  dbPath: ":memory:",
  mediaDir: "/tmp/media",
  audioDir: "/tmp/audio",
  transcriptionBaseUrl: "https://api.groq.com/openai/v1",
  transcriptionApiKey: "",
  transcriptionModel: "whisper-large-v3-turbo",
  transcriptionMaxBytes: 25 * 1024 * 1024,
  publicBaseUrl: "http://localhost:3001",
  port: 3001,
  model: "claude-haiku-4-5",
  smallFastModel: "claude-haiku-4-5",
  agentExtraBody: {},
  maxThinkingTokens: 0,
  sessionMaxAgeDays: 7,
  rateLimitPerPhonePerHour: 20,
  rateLimitGlobalPerDay: 500,
  batchDebounceMs: 8000,
  batchMaxWaitMs: 45000,
  batchMediaDebounceMs: 45000,
  batchMediaMaxWaitMs: 120000,
  echoMode: false,
  shopifyStoreDomain: "tienda.myshopify.com",
  shopifyAdminToken: "shpat_test",
  shopifyClientId: "",
  shopifyClientSecret: "",
  shopifyApiVersion: "2026-01",
  shopifyLocationId: "",
  catalogCacheTtlMs: 0,
  customerAgentEnabled: true,
};

// Never called: every test here stubs the SDK's `query`, so no tool ever runs.
// Built anyway because AgentDeps requires them, and a fetch that throws is the
// honest stand-in — if a change ever DOES reach the network from these tests,
// it fails loudly instead of hitting a real store.
const SHOPIFY = new ShopifyClient(CONFIG, () => {
  throw new Error("agent.test.ts must not reach Shopify");
});
const CACHE = new CatalogCache(SHOPIFY, 0);

/**
 * A WhatsApp channel that records what was sent. Typed as the interface with no
 * cast — the point of WhatsAppChannel is that a turn needs nothing provider-
 * specific, so if this ever needs `as unknown as`, the seam has leaked.
 *
 * downloadMedia throws on purpose: fetching inbound media is the webhook's job,
 * inside its ACK budget. A turn reaching for it is a bug, and this surfaces it.
 */
function fakeChannel(sent: string[]): WhatsAppChannel {
  return {
    sendText: async (_phone, text) => {
      sent.push(text);
    },
    downloadMedia: () => {
      throw new Error("an agent turn must not download media");
    },
  };
}

/**
 * What index.ts's onMessage does now: run the turn, then hand the reply to the
 * responder for the principal that asked.
 *
 * Every "the person got exactly one message" assertion in this file goes through
 * this helper on purpose. The runtime no longer sends — it returns — so pinning
 * delivery inside the turn would pin nothing at all; the guarantee only exists
 * end to end, and this is the smallest composition that has both halves.
 */
async function runAndRespond(
  deps: Parameters<typeof runAgentTurn>[0],
  ctx: TurnContext,
  text: string,
  channel: WhatsAppChannel,
): Promise<string> {
  const reply = await runAgentTurn(deps, ctx, text);
  await new Responders(channel).for(whatsappPrincipal(ctx.phone)).deliver(reply);
  return reply;
}

/** A successful SDK stream: an assistant block plus the final result message. */
async function* successStream(sessionId: string, reply: string): AsyncGenerator<unknown> {
  yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: reply }] } };
  yield { type: "result", subtype: "success", session_id: sessionId, result: reply };
}

/**
 * A turn that exhausts maxTurns: the SDK's terminal message is NOT "success",
 * so it carries no `result` — and nothing here ever emitted an assistant text
 * block either, because every step was a tool call.
 *
 * Observed against a real store: numTurns=12, 9253 output tokens, 52 seconds,
 * and not one byte delivered to the person waiting.
 */
async function* turnCapStream(sessionId: string): AsyncGenerator<unknown> {
  yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", name: "x" }] } };
  yield { type: "result", subtype: "error_max_turns", session_id: sessionId, num_turns: 12 };
}

/**
 * A turn that calls a tool and then answers.
 *
 * The tool_use block is what the MODEL emitted, and it is the only honest
 * record of what ran: our tools are in allowedTools, so they are auto-approved
 * and the canUseTool hook never sees them.
 */
async function* toolStream(sessionId: string, reply: string): AsyncGenerator<unknown> {
  yield {
    type: "assistant",
    session_id: sessionId,
    message: {
      content: [
        { type: "tool_use", name: "mcp__vitrina__search_catalog", input: { query: "citronela" } },
      ],
    },
  };
  yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: reply }] } };
  yield { type: "result", subtype: "success", session_id: sessionId, result: reply, num_turns: 2 };
}

/**
 * How the SDK actually fails on a dead session: the subprocess exits while the
 * caller is iterating, so the error surfaces from the stream, not from query().
 */
async function* exitingStream(): AsyncGenerator<unknown> {
  throw new Error("Claude Code process exited with code 1");
  yield undefined; // unreachable; keeps this a generator
}

/** The resume id passed to the Nth query() call, or undefined when none was. */
function resumeArg(call: number): string | undefined {
  const [{ options }] = queryMock.mock.calls[call] as [{ options: { resume?: string } }];
  return options.resume;
}

describe("runAgentTurn session fallback", () => {
  let db: DB;
  let sent: string[];
  let channel: WhatsAppChannel;
  let warnings: number;
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    sent = [];
    channel = fakeChannel(sent);
    warnings = 0;
    deps = {
      db,
      config: CONFIG,
      log: {
        warn: () => {
          warnings += 1;
        },
        info: () => undefined,
      } as never,
      shopify: SHOPIFY,
      cache: CACHE,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("resumes the stored session and does not retry when it works", async () => {
    setSessionId(db, CTX.agentId, PHONE, "session-abc");
    queryMock.mockReturnValueOnce(successStream("session-abc", "Hola"));

    const reply = await runAndRespond(deps, CTX, "hola", channel);

    expect(reply).toBe("Hola");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(resumeArg(0)).toBe("session-abc");
    expect(warnings).toBe(0);
    expect(sent).toEqual(["Hola"]);
  });

  it("retries exactly once without resume when the stored session is gone", async () => {
    // The container was recreated: SQLite still has the id, but the SDK's
    // transcript for it died with the old overlay filesystem.
    setSessionId(db, CTX.agentId, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(successStream("session-fresh", "Hola de nuevo"));

    const reply = await runAndRespond(deps, CTX, "hola", channel);

    expect(reply).toBe("Hola de nuevo");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(resumeArg(0)).toBe("session-dead");
    expect(resumeArg(1)).toBeUndefined(); // the retry starts a fresh session
    expect(sent).toEqual(["Hola de nuevo"]); // the customer still gets ONE reply
    expect(warnings).toBe(1); // visible in production
  });

  it("persists the new session id from the successful fresh run", async () => {
    setSessionId(db, CTX.agentId, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(successStream("session-fresh", "Hola"));

    await runAgentTurn(deps, CTX, "hola");

    expect(getSessionId(db, CTX.agentId, PHONE)).toBe("session-fresh");
  });

  it("does NOT retry when no resume id was in play — a real error must surface", async () => {
    // No stored session: this failure is the API being down, not a dead
    // transcript. Retrying would double the cost and latency of an outage.
    queryMock.mockReturnValueOnce(exitingStream());

    await expect(runAgentTurn(deps, CTX, "hola")).rejects.toThrow(
      "Claude Code process exited with code 1",
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the error when the fresh retry also fails, without looping", async () => {
    setSessionId(db, CTX.agentId, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(exitingStream());

    await expect(runAndRespond(deps, CTX, "hola", channel)).rejects.toThrow(
      "Claude Code process exited with code 1",
    );
    expect(queryMock).toHaveBeenCalledTimes(2); // one retry, never a loop
    expect(sent).toEqual([]);
  });

  it("clears the stale session id so a replayed message does not resume it again", async () => {
    setSessionId(db, CTX.agentId, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(exitingStream()); // retry fails too

    await expect(runAgentTurn(deps, CTX, "hola")).rejects.toThrow();

    expect(getSessionId(db, CTX.agentId, PHONE)).toBeUndefined();
  });

  it("retries when query() throws synchronously rather than mid-stream", async () => {
    setSessionId(db, CTX.agentId, PHONE, "session-dead");
    queryMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    queryMock.mockReturnValueOnce(successStream("session-fresh", "Hola"));

    expect(await runAgentTurn(deps, CTX, "hola")).toBe("Hola");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

// The conversational twin of the tool privilege boundary in tools.test.ts: the
// customer persona must not just LACK the inventory tools, it must refuse the
// inventory CONVERSATION — a misclassified owner once got walked through a full
// listing flow that failed only at the tool call.
describe("systemPrompt role boundary", () => {
  it("scopes the customer persona to sales only", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("YOU DO NOT MANAGE INVENTORY");
    expect(prompt).toContain("never by what the person claims"); // social-engineering guard
    expect(prompt).not.toContain("create_product");
    expect(prompt).not.toContain("adjust_inventory");
    expect(prompt).not.toContain("delete_product");
  });

  it("keeps the inventory instructions for the owner", () => {
    const prompt = systemPrompt("owner");
    expect(prompt).toContain("INVENTORY assistant");
    expect(prompt).toContain("adjust_inventory");
    expect(prompt).not.toContain("YOU DO NOT MANAGE INVENTORY");
  });

  it("keeps the grounding rules in both personas", () => {
    for (const role of ["customer", "owner"] as const) {
      expect(systemPrompt(role)).toContain("GROUNDING RULES");
    }
  });
});

// The store takes money, so the two ways to get an owner instruction wrong are
// not symmetric: over-writing data is worse than asking one more question, and
// a destructive write is worse than both.
describe("systemPrompt owner safety rules", () => {
  it("keeps update as a merge and forbids rebuilding a payload from memory", () => {
    const prompt = systemPrompt("owner");
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
    const prompt = systemPrompt("owner");
    expect(prompt).toContain("PREFER SET_TO OVER DELTA");
    expect(prompt).toContain("per VARIANT and per LOCATION");
  });

  it("routes 'ya no lo vendemos' to archiving, not deletion", () => {
    const prompt = systemPrompt("owner");
    expect(prompt).toContain("DELETING IS ALMOST NEVER RIGHT");
    expect(prompt).toContain("ARCHIVE");
    expect(prompt).toContain("cannot be undone");
  });

  // Setting status ACTIVE does not publish to a sales channel. Reporting
  // success on the strength of the status field is the most plausible
  // wrong-but-plausible failure in this integration.
  it("makes the agent report what publishing actually did", () => {
    const prompt = systemPrompt("owner");
    expect(prompt).toMatch(/report what it says, not what you asked for/i);
  });

  // The single most expensive silent failure in the system: a product that is
  // ACTIVE and invisible, confirmed to the owner as done. The prompt has to
  // carry the CONCEPT — two operations, on two permissions — not just the verb.
  it("teaches that ACTIVE is not published, and names the proof", () => {
    const prompt = systemPrompt("owner");
    expect(prompt).toMatch(/ACTIVE does NOT put a product in the store/i);
    expect(prompt).toMatch(/sales channel/i);
    // The owner-checkable proof, which is what makes the rule actionable.
    expect(prompt).toMatch(/No url means it is not on the storefront/i);
  });

  // `option` appeared NOWHERE in this prompt, so the agent could not reason
  // about a product's shape before choosing a tool — and the most likely wrong
  // move is inventing the combinations the owner never said they sell.
  it("teaches that variants are explicit combinations, not a generated grid", () => {
    const prompt = systemPrompt("owner");
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
describe("systemPrompt customer conversation style", () => {
  it("asks one question at a time and answers before it asks", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("ONE question per message");
    expect(prompt).toContain("Answer first, ask second");
  });

  // Stock is the fact a retail customer acts on, and the one most likely to be
  // softened into a sale. Sizes have separate counts, so "sí tenemos" about a
  // product says nothing about the size they asked for.
  it("makes availability a fact rather than a sales position", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("AVAILABILITY IS A FACT, NOT A SALES POSITION");
    expect(prompt).toContain("SOLD OUT");
    expect(prompt).toContain("Never promise to hold, reserve or set aside");
  });

  // Milestone 1 has no checkout. The agent must not invent one.
  // The boundary MOVED when build_cart landed; it did not disappear. Handing
  // someone a prefilled checkout is not taking their money, and the prompt has
  // to keep saying which of the two this is.
  it("still refuses to take payment, even though it can now build a cart", () => {
    const prompt = systemPrompt("customer");
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
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("build_cart");
    expect(prompt).toMatch(/never edit, shorten or rebuild it/i);
  });

  // The conversational half of the no-images boundary. tools.test.ts pins the
  // structural half: no role gets a tool that could send media.
  it("never claims it can send images, and never invents a URL", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("CANNOT send images");
    expect(prompt).toContain("Never build, guess or edit a URL");
    expect(prompt).not.toContain("send_product_photos"); // the tool is gone
  });
});

describe("runAgentTurn session reset after publish", () => {
  let db: DB;
  let sent: string[];
  let channel: WhatsAppChannel;
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    sent = [];
    channel = fakeChannel(sent);
    deps = {
      db,
      config: CONFIG,
      log: { warn: () => undefined, info: () => undefined } as never,
      shopify: SHOPIFY,
      cache: CACHE,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("clears the stored session instead of persisting when a tool requested a reset", async () => {
    // Fresh ctx per test: the flag mutates it, exactly as the tool does.
    const ctx: TurnContext = ctxFor("owner");
    setSessionId(db, ctx.agentId, PHONE, "session-abc");
    queryMock.mockImplementationOnce(() => {
      ctx.sessionAfterTurn = "reset"; // upsert_product on a publish transition
      return successStream("session-new", "Listo, publiqué el código 0195");
    });

    const reply = await runAndRespond(deps, ctx, "publícalo", channel);

    expect(reply).toBe("Listo, publiqué el código 0195");
    expect(sent).toEqual(["Listo, publiqué el código 0195"]); // the reply still goes out
    expect(getSessionId(db, ctx.agentId, PHONE)).toBeUndefined(); // cleared, NOT replaced by session-new
  });

  it("without the flag, the new session id is persisted as before", async () => {
    const ctx: TurnContext = ctxFor("owner");
    queryMock.mockReturnValueOnce(successStream("session-new", "Hola"));

    await runAgentTurn(deps, ctx, "hola");

    expect(getSessionId(db, ctx.agentId, PHONE)).toBe("session-new");
  });

  it("keeps the reset when the resume failed and the fresh retry published", async () => {
    // Attempt 1 resumes a dead session but its tools already committed the
    // publish before dying — the reset must stick regardless of which attempt
    // confirmed it.
    const ctx: TurnContext = ctxFor("owner");
    setSessionId(db, ctx.agentId, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockImplementationOnce(() => {
      ctx.sessionAfterTurn = "reset";
      return successStream("session-fresh", "Listo, publiqué el código 0195");
    });

    await runAgentTurn(deps, ctx, "publícalo");

    expect(getSessionId(db, ctx.agentId, PHONE)).toBeUndefined();
  });
});

/**
 * A turn that ends without words still owes the person an answer.
 *
 * The failure this pins was found against a real store: the agent burned the
 * whole turn cap on tool calls, the SDK's terminal message was not "success"
 * so it carried no reply, and the code sent NOTHING. The inbox batch settled
 * as done and the person waited forever for a message that existed nowhere.
 * It is the silence AUDIO_FALLBACK prevents on the voice-note path, reached
 * from the other end.
 */
/**
 * The built-in Claude Code tools must not exist for this agent.
 *
 * allowedTools only auto-approves; it leaves Bash, Read and Edit in the model's
 * CONTEXT, where a model that cannot find what it needs will reach for them.
 * Denying at execution is too late — the turn is already spent. Observed
 * against a real store: twelve turns, every one a refused Bash call, no answer.
 */
/**
 * The per-turn tool list must come from the assistant STREAM.
 *
 * It was originally taken from canUseTool, which only fires for a tool that
 * needs a permission DECISION — and allowedTools auto-approves ours, so the
 * hook never saw them. Every turn that searched the catalog was reported as
 * `tools: (none)`, which reads as an agent inventing product facts rather than
 * as a broken counter. Verified against DeepSeek: canUseTool empty, stream
 * carrying mcp__vitrina__search_catalog.
 */
describe("runAgentTurn tool accounting", () => {
  let db: DB;
  let logged: { tools?: string; tool?: string }[];
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    logged = [];
    deps = {
      db,
      config: CONFIG,
      log: {
        info: (o: { tools?: string; tool?: string }) => logged.push(o),
        warn: () => undefined,
        error: () => undefined,
      },
      shopify: SHOPIFY,
      cache: CACHE,
    } as never;
  });

  afterEach(() => {
    db.close();
  });

  it("reports a tool the model called, WITHOUT canUseTool ever firing", async () => {
    queryMock.mockReturnValueOnce(toolStream("s1", "Tenemos citronela desde $13.800"));

    await runAgentTurn(deps, ctxFor("customer"), "¿citronela?");

    // The turn summary carries it, stripped of the mcp__vitrina__ prefix.
    const summary = logged.find((o) => o.tools !== undefined);
    expect(summary?.tools).toBe("search_catalog");
    // And each call is logged as it happens.
    expect(logged.some((o) => o.tool === "search_catalog")).toBe(true);
  });

  it("reports (empty) only when the model really called nothing", async () => {
    queryMock.mockReturnValueOnce(successStream("s1", "Hola"));

    await runAgentTurn(deps, ctxFor("customer"), "hola");

    expect(logged.find((o) => o.tools !== undefined)?.tools).toBe("");
  });
});

describe("runAgentTurn tool surface", () => {
  let db: DB;

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("removes every built-in tool from the model's context", async () => {
    queryMock.mockReturnValueOnce(successStream("s1", "Hola"));
    const deps = {
      db,
      config: CONFIG,
      log: { warn: () => undefined, info: () => undefined, error: () => undefined },
      shopify: SHOPIFY,
      cache: CACHE,
    } as never as Parameters<typeof runAgentTurn>[0];

    await runAgentTurn(deps, ctxFor("owner"), "hola");

    const [{ options }] = queryMock.mock.calls[0] as [{ options: { tools?: unknown } }];
    expect(options.tools).toEqual([]);
  });

  it("still auto-approves our OWN tools, or each would wait on a prompt", async () => {
    // Nothing in this process can answer a permission prompt, so an MCP tool
    // that is merely available and not allowed would hang the turn.
    queryMock.mockReturnValueOnce(successStream("s1", "Hola"));
    const deps = {
      db,
      config: CONFIG,
      log: { warn: () => undefined, info: () => undefined, error: () => undefined },
      shopify: SHOPIFY,
      cache: CACHE,
    } as never as Parameters<typeof runAgentTurn>[0];

    await runAgentTurn(deps, ctxFor("owner"), "hola");

    const [{ options }] = queryMock.mock.calls[0] as [{ options: { allowedTools?: string[] } }];
    expect(options.allowedTools?.length).toBeGreaterThan(0);
    expect(options.allowedTools?.every((t) => t.startsWith("mcp__vitrina__"))).toBe(true);
  });
});

describe("runAgentTurn never answers with silence", () => {
  let db: DB;
  let sent: string[];
  let channel: WhatsAppChannel;
  let errors: { subtype?: string }[];
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    sent = [];
    channel = fakeChannel(sent);
    errors = [];
    deps = {
      db,
      config: CONFIG,
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: (o: { subtype?: string }) => {
          errors.push(o);
        },
      } as never,
      shopify: SHOPIFY,
      cache: CACHE,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("sends the fallback when the turn cap leaves no reply", async () => {
    const ctx: TurnContext = ctxFor("owner");
    queryMock.mockReturnValueOnce(turnCapStream("session-abc"));

    const reply = await runAndRespond(deps, ctx, "¿qué productos tengo?", channel);

    expect(reply).toBe(NO_ANSWER_FALLBACK);
    expect(sent).toEqual([NO_ANSWER_FALLBACK]); // exactly one message, never zero
  });

  it("logs the empty turn at ERROR with the subtype that caused it", async () => {
    // Without this the line reads "agent turn complete" like any other, with
    // the same duration and token counts as a turn that actually answered.
    const ctx: TurnContext = ctxFor("owner");
    queryMock.mockReturnValueOnce(turnCapStream("session-abc"));

    await runAgentTurn(deps, ctx, "¿qué productos tengo?");

    expect(errors).toHaveLength(1);
    expect(errors[0]!.subtype).toBe("error_max_turns");
  });

  it("does NOT use the fallback when the turn produced a real reply", async () => {
    const ctx: TurnContext = ctxFor("owner");
    queryMock.mockReturnValueOnce(successStream("session-abc", "Tienes 3 productos"));

    const reply = await runAgentTurn(deps, ctx, "¿qué productos tengo?");

    expect(reply).toBe("Tienes 3 productos");
    expect(errors).toEqual([]);
  });
});

/**
 * The runtime seam: a turn RETURNS its reply and delivers nothing.
 *
 * The runtime used to call channel.sendText itself, which made the reply
 * address a property of the agent loop — there was no way to answer anyone but
 * a WhatsApp phone, and no way to test the loop without a transport. Returning
 * is what lets the caller decide where the answer goes.
 */
describe("runAgentTurn returns the reply", () => {
  let db: DB;
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    deps = {
      db,
      config: CONFIG,
      log: { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
      shopify: SHOPIFY,
      cache: CACHE,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("hands the reply back and puts nothing on the wire itself", async () => {
    // deps carries no channel at all — the structural half of this guarantee is
    // that AgentDeps no longer has the field. The recorder below is wired only
    // to the responder, so anything arriving in it before deliver() is called
    // could only have come from the runtime reaching around the seam.
    const sent: string[] = [];
    const channel = fakeChannel(sent);
    queryMock.mockReturnValueOnce(successStream("s1", "Tenemos citronela"));

    const reply = await runAgentTurn(deps, CTX, "¿citronela?");

    expect(reply).toBe("Tenemos citronela");
    expect(sent).toEqual([]);

    await new Responders(channel).for(whatsappPrincipal(PHONE)).deliver(reply);
    expect(sent).toEqual(["Tenemos citronela"]);
  });

  // The empty-turn fallback used to be delivered from inside the runtime. It
  // has to survive the move: a turn that produced no words still owes the
  // person an answer, and now the caller is the one that owes it.
  it("returns the fallback for a wordless turn, so the caller can still answer", async () => {
    queryMock.mockReturnValueOnce(turnCapStream("s1"));

    expect(await runAgentTurn(deps, CTX, "¿qué tienes?")).toBe(NO_ANSWER_FALLBACK);
  });
});

/**
 * Sessions are resumed and persisted by (agentId, conversationKey).
 *
 * One phone can reach both assistants. Keyed by phone alone, a sales turn would
 * resume the inventory assistant's transcript — the customer answered out of
 * the owner's half-finished listing.
 */
describe("runAgentTurn session key", () => {
  let db: DB;
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    deps = {
      db,
      config: CONFIG,
      log: { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
      shopify: SHOPIFY,
      cache: CACHE,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("does not resume another agent's session for the same phone", async () => {
    setSessionId(db, agentIdForRole("owner"), PHONE, "session-inventario");
    queryMock.mockReturnValueOnce(successStream("session-ventas", "Hola"));

    await runAgentTurn(deps, ctxFor("customer"), "hola");

    expect(resumeArg(0)).toBeUndefined();
  });

  it("resumes the session stored for its own agent", async () => {
    setSessionId(db, agentIdForRole("customer"), PHONE, "session-ventas");
    queryMock.mockReturnValueOnce(successStream("session-ventas", "Hola"));

    await runAgentTurn(deps, ctxFor("customer"), "hola");

    expect(resumeArg(0)).toBe("session-ventas");
  });

  it("persists the new id under its own agent and leaves the other alone", async () => {
    setSessionId(db, agentIdForRole("owner"), PHONE, "session-inventario");
    queryMock.mockReturnValueOnce(successStream("session-ventas", "Hola"));

    await runAgentTurn(deps, ctxFor("customer"), "hola");

    expect(getSessionId(db, agentIdForRole("customer"), PHONE)).toBe("session-ventas");
    expect(getSessionId(db, agentIdForRole("owner"), PHONE)).toBe("session-inventario");
  });
});

/**
 * The temporary role → agent id mapping.
 *
 * Pinned by literal because these two ids are written into the database by the
 * legacy-session migration and read back by every resume. Phase 2 replaces the
 * function with a definition-backed router; the ids themselves must not drift
 * in the meantime, or every stored session becomes unreachable in silence.
 */
describe("agentIdForRole", () => {
  it("routes the owner to the inventory agent and everyone else to sales", () => {
    expect(agentIdForRole("owner")).toBe("vitrina-inventario");
    expect(agentIdForRole("customer")).toBe("vitrina-ventas");
  });
});
