import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/data/db.js";
import type { KapsoClient } from "../src/whatsapp/kapso.js";
import { getSessionId, setSessionId } from "../src/data/repo.js";
import type { TurnContext } from "../src/types.js";

// Only `query` is faked; tools.ts imports createSdkMcpServer/tool from the same
// module and needs the real ones to build the MCP server.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importActual) => ({
  ...(await importActual<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: queryMock,
}));

const { runAgentTurn, systemPrompt } = await import("../src/agent/agent.js");

const PHONE = "573001112233";
const CTX: TurnContext = { phone: PHONE, role: "customer" };

const CONFIG: Config = {
  anthropicApiKey: "sk-test",
  kapsoApiKey: "kapso-test",
  kapsoPhoneNumberId: "123",
  kapsoWebhookSecret: "whsec",
  ownerPhoneNumbers: new Set<string>(),
  dbPath: ":memory:",
  mediaDir: "/tmp/media",
  publicBaseUrl: "http://localhost:3001",
  port: 3001,
  model: "claude-haiku-4-5",
  sessionMaxAgeDays: 7,
  rateLimitPerPhonePerHour: 20,
  rateLimitGlobalPerDay: 500,
  batchDebounceMs: 8000,
  batchMaxWaitMs: 45000,
  batchMediaDebounceMs: 45000,
  batchMediaMaxWaitMs: 120000,
  storefrontBaseUrl: "http://localhost:3000",
  customerAgentEnabled: true,
};

/** A successful SDK stream: an assistant block plus the final result message. */
async function* successStream(sessionId: string, reply: string): AsyncGenerator<unknown> {
  yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: reply }] } };
  yield { type: "result", subtype: "success", session_id: sessionId, result: reply };
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
  let warnings: number;
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    sent = [];
    warnings = 0;
    deps = {
      db,
      config: CONFIG,
      log: {
        warn: () => {
          warnings += 1;
        },
      } as never,
      kapso: {
        sendText: async (_phone: string, text: string) => {
          sent.push(text);
        },
      } as unknown as KapsoClient,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("resumes the stored session and does not retry when it works", async () => {
    setSessionId(db, PHONE, "session-abc");
    queryMock.mockReturnValueOnce(successStream("session-abc", "Hola"));

    const reply = await runAgentTurn(deps, CTX, "hola");

    expect(reply).toBe("Hola");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(resumeArg(0)).toBe("session-abc");
    expect(warnings).toBe(0);
    expect(sent).toEqual(["Hola"]);
  });

  it("retries exactly once without resume when the stored session is gone", async () => {
    // The container was recreated: SQLite still has the id, but the SDK's
    // transcript for it died with the old overlay filesystem.
    setSessionId(db, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(successStream("session-fresh", "Hola de nuevo"));

    const reply = await runAgentTurn(deps, CTX, "hola");

    expect(reply).toBe("Hola de nuevo");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(resumeArg(0)).toBe("session-dead");
    expect(resumeArg(1)).toBeUndefined(); // the retry starts a fresh session
    expect(sent).toEqual(["Hola de nuevo"]); // the customer still gets ONE reply
    expect(warnings).toBe(1); // visible in production
  });

  it("persists the new session id from the successful fresh run", async () => {
    setSessionId(db, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(successStream("session-fresh", "Hola"));

    await runAgentTurn(deps, CTX, "hola");

    expect(getSessionId(db, PHONE)).toBe("session-fresh");
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
    setSessionId(db, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(exitingStream());

    await expect(runAgentTurn(deps, CTX, "hola")).rejects.toThrow(
      "Claude Code process exited with code 1",
    );
    expect(queryMock).toHaveBeenCalledTimes(2); // one retry, never a loop
    expect(sent).toEqual([]);
  });

  it("clears the stale session id so a replayed message does not resume it again", async () => {
    setSessionId(db, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockReturnValueOnce(exitingStream()); // retry fails too

    await expect(runAgentTurn(deps, CTX, "hola")).rejects.toThrow();

    expect(getSessionId(db, PHONE)).toBeUndefined();
  });

  it("retries when query() throws synchronously rather than mid-stream", async () => {
    setSessionId(db, PHONE, "session-dead");
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
    expect(prompt).not.toContain("upsert_product");
    expect(prompt).not.toContain("attach_pending_photos");
  });

  it("keeps the inventory instructions for the owner", () => {
    const prompt = systemPrompt("owner");
    expect(prompt).toContain("INVENTORY assistant");
    expect(prompt).toContain("upsert_product");
    expect(prompt).not.toContain("YOU DO NOT MANAGE INVENTORY");
  });

  it("keeps the grounding rules in both personas", () => {
    for (const role of ["customer", "owner"] as const) {
      expect(systemPrompt(role)).toContain("GROUNDING RULES");
    }
  });
});

// The pilot's customer path was interrogating people — several questions per
// reply, and a visit pushed before the customer had seen anything. It was doing
// what the prompt asked for ("move them toward a visit", "proactively offer to
// schedule"), so the pacing rules that replaced those lines ARE the fix, not
// decoration around it.
describe("systemPrompt customer conversation style", () => {
  it("asks one question at a time and answers before it asks", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("ONE question per message");
    expect(prompt).toContain("Answer first, ask second");
  });

  it("makes the visit the customer's decision, not the agent's goal", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("A VISIT IS THEIR DECISION, NOT YOUR GOAL");
    expect(prompt).toContain("Never offer one in your first reply");
    expect(prompt).not.toContain("move them toward a visit"); // the old goal
    expect(prompt).not.toContain("Proactively offer"); // the old eagerness
  });

  // The conversational half of the no-images boundary. tools.test.ts pins the
  // structural half: no role gets a tool that could send media.
  it("routes photos to the property page instead of the chat", () => {
    const prompt = systemPrompt("customer");
    expect(prompt).toContain("PHOTOS LIVE ON THE PROPERTY PAGE");
    expect(prompt).toContain("CANNOT send images");
    expect(prompt).toContain("Send the link exactly as the tool returned it"); // no invented URLs
    expect(prompt).not.toContain("send_product_photos"); // the tool is gone
  });
});

describe("runAgentTurn session reset after publish", () => {
  let db: DB;
  let sent: string[];
  let deps: Parameters<typeof runAgentTurn>[0];

  beforeEach(() => {
    queryMock.mockReset();
    db = openDb(":memory:");
    sent = [];
    deps = {
      db,
      config: CONFIG,
      log: { warn: () => undefined } as never,
      kapso: {
        sendText: async (_phone: string, text: string) => {
          sent.push(text);
        },
      } as unknown as KapsoClient,
    };
  });

  afterEach(() => {
    db.close();
  });

  it("clears the stored session instead of persisting when a tool requested a reset", async () => {
    // Fresh ctx per test: the flag mutates it, exactly as the tool does.
    const ctx: TurnContext = { phone: PHONE, role: "owner" };
    setSessionId(db, PHONE, "session-abc");
    queryMock.mockImplementationOnce(() => {
      ctx.sessionAfterTurn = "reset"; // upsert_product on a publish transition
      return successStream("session-new", "Listo, publiqué el código 0195");
    });

    const reply = await runAgentTurn(deps, ctx, "publícalo");

    expect(reply).toBe("Listo, publiqué el código 0195");
    expect(sent).toEqual(["Listo, publiqué el código 0195"]); // the reply still goes out
    expect(getSessionId(db, PHONE)).toBeUndefined(); // cleared, NOT replaced by session-new
  });

  it("without the flag, the new session id is persisted as before", async () => {
    const ctx: TurnContext = { phone: PHONE, role: "owner" };
    queryMock.mockReturnValueOnce(successStream("session-new", "Hola"));

    await runAgentTurn(deps, ctx, "hola");

    expect(getSessionId(db, PHONE)).toBe("session-new");
  });

  it("keeps the reset when the resume failed and the fresh retry published", async () => {
    // Attempt 1 resumes a dead session but its tools already committed the
    // publish before dying — the reset must stick regardless of which attempt
    // confirmed it.
    const ctx: TurnContext = { phone: PHONE, role: "owner" };
    setSessionId(db, PHONE, "session-dead");
    queryMock.mockReturnValueOnce(exitingStream());
    queryMock.mockImplementationOnce(() => {
      ctx.sessionAfterTurn = "reset";
      return successStream("session-fresh", "Listo, publiqué el código 0195");
    });

    await runAgentTurn(deps, ctx, "publícalo");

    expect(getSessionId(db, PHONE)).toBeUndefined();
  });
});
