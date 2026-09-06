import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/data/db.js";
import {
  countAgentCredentials,
  deleteAgentCredential,
  findAgentByToken,
  hashAgentToken,
  listAgentCredentials,
  mintAgentToken,
  upsertAgentCredential,
} from "../src/data/agent-registry.js";

/**
 * The agent registry: who may speak through the agent door.
 *
 * This table IS the switch, so the first property below is the one that
 * matters most — an empty registry authenticates nobody. Everything else is
 * about the credential never existing at rest: a token in this file would sit
 * in every backup of it.
 */

const CALLER = "super-agent";
const TARGET = "vitrina-inventario";

describe("the agent registry", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  it("authenticates nobody when it is empty", () => {
    db = openDb(":memory:");

    expect(countAgentCredentials(db)).toBe(0);
    expect(findAgentByToken(db, mintAgentToken())).toBeNull();
  });

  it("answers null for an absent or empty token without touching the table", () => {
    db = openDb(":memory:");
    upsertAgentCredential(db, { agentId: CALLER, token: "t", reach: [TARGET] });

    expect(findAgentByToken(db, undefined)).toBeNull();
    expect(findAgentByToken(db, "")).toBeNull();
  });

  it("identifies the caller a token belongs to, with the reach the operator gave it", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token, reach: [TARGET] });

    expect(findAgentByToken(db, token)).toEqual({
      agentId: CALLER,
      reach: [TARGET],
      callbackPrefix: undefined,
    });
  });

  it("does not identify a caller from a token that matches no row", () => {
    db = openDb(":memory:");
    upsertAgentCredential(db, { agentId: CALLER, token: mintAgentToken(), reach: [TARGET] });

    expect(findAgentByToken(db, mintAgentToken())).toBeNull();
  });

  // The registry file is copied by data/backup.ts and lives on a volume; a
  // stored token would be the store's write access sitting in every copy.
  it("stores no plaintext token anywhere in the row", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();

    upsertAgentCredential(db, { agentId: CALLER, token, reach: [TARGET] });

    const row = db.prepare(`SELECT * FROM agent_registry`).get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row["token_hash"]).toBe(hashAgentToken(token));
  });

  it("mints a distinct token every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintAgentToken()));

    expect(tokens.size).toBe(50);
    // 256 bits, base64url: long enough that the SHA-256 at rest has no
    // dictionary to be attacked with.
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("invalidates the previous token when a credential is rotated", () => {
    db = openDb(":memory:");
    const first = mintAgentToken();
    const second = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token: first, reach: [TARGET] });

    upsertAgentCredential(db, { agentId: CALLER, token: second, reach: [TARGET] });

    expect(findAgentByToken(db, first)).toBeNull();
    expect(findAgentByToken(db, second)?.agentId).toBe(CALLER);
    expect(countAgentCredentials(db)).toBe(1);
  });

  it("closes the door for a credential that is deleted", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token, reach: [TARGET] });

    expect(deleteAgentCredential(db, CALLER)).toBe(true);

    expect(findAgentByToken(db, token)).toBeNull();
    expect(deleteAgentCredential(db, CALLER)).toBe(false);
  });

  it("tells two callers apart by their own tokens", () => {
    db = openDb(":memory:");
    const first = mintAgentToken();
    const second = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token: first, reach: [TARGET] });
    upsertAgentCredential(db, { agentId: "other-agent", token: second, reach: [] });

    expect(findAgentByToken(db, first)?.agentId).toBe(CALLER);
    expect(findAgentByToken(db, second)?.agentId).toBe("other-agent");
  });

  // A reach column is operator-written. Guessing what a malformed one meant is
  // how a caller ends up with reach it was never given.
  it("grants nothing when the stored reach is malformed", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token, reach: [TARGET] });
    db.prepare(`UPDATE agent_registry SET reach = 'not json'`).run();

    expect(findAgentByToken(db, token)?.reach).toEqual([]);
  });

  it("drops non-string entries from a hand-edited reach list", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token, reach: [] });
    db.prepare(`UPDATE agent_registry SET reach = '["a", 7, null]'`).run();

    expect(findAgentByToken(db, token)?.reach).toEqual(["a"]);
  });

  // timingSafeEqual THROWS on a length mismatch, which a truncated or
  // hand-edited token_hash would otherwise turn into a 500 that takes the door
  // down for every caller, not just the broken one.
  it("survives a hand-edited token_hash of the wrong length", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token, reach: [TARGET] });
    db.prepare(`UPDATE agent_registry SET token_hash = 'ab'`).run();

    expect(() => findAgentByToken(db, token)).not.toThrow();
    expect(findAgentByToken(db, token)).toBeNull();
  });

  it("keeps a callback prefix with the credential that may use it", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();

    upsertAgentCredential(db, {
      agentId: CALLER,
      token,
      reach: [TARGET],
      callbackPrefix: "https://super.internal/callbacks/",
    });

    expect(findAgentByToken(db, token)?.callbackPrefix).toBe("https://super.internal/callbacks/");
  });

  it("lists every caller for the ops tool without ever handing back a token", () => {
    db = openDb(":memory:");
    const token = mintAgentToken();
    upsertAgentCredential(db, { agentId: CALLER, token, reach: [TARGET] });
    upsertAgentCredential(db, { agentId: "aaa-agent", token: mintAgentToken(), reach: [] });

    const listed = listAgentCredentials(db);

    expect(listed.map((c) => c.agentId)).toEqual(["aaa-agent", CALLER]);
    expect(JSON.stringify(listed)).not.toContain(token);
    for (const credential of listed) {
      expect(Object.keys(credential)).toEqual(["agentId", "reach", "callbackPrefix"]);
    }
  });
});
