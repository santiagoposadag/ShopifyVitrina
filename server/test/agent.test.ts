import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db.js";
import type { KapsoClient } from "../src/kapso.js";
import { getSessionId, setSessionId } from "../src/repo.js";
import type { TurnContext } from "../src/types.js";

// Only `query` is faked; tools.ts imports createSdkMcpServer/tool from the same
// module and needs the real ones to build the MCP server.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importActual) => ({
  ...(await importActual<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: queryMock,
}));

const { runAgentTurn } = await import("../src/agent.js");

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
