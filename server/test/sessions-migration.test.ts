import { afterEach, describe, expect, it } from "vitest";
import { createSchema, openDb, type DB } from "../src/data/db.js";
import { getSessionId, listSessions, setSessionId } from "../src/data/repo.js";
import { refusingLegacyAgentIdFor } from "../src/router.js";

/**
 * The sessions key change, against a database that already exists.
 *
 * `sessions` was `PRIMARY KEY (phone)`, and neither CREATE TABLE IF NOT EXISTS
 * nor ALTER TABLE can turn that into `PRIMARY KEY (agent_id, conversation_key)`
 * — the first is a no-op on an existing table, the second cannot touch a
 * primary key. So this is a table rebuild, it runs on every boot, and the two
 * things that can go wrong with it are losing rows and running twice.
 */

const OWNER = "573001112233";
const CUSTOMER = "573009998877";

/** Exactly the DDL a pre-migration build shipped, so the fixture is not a paraphrase. */
const LEGACY_SESSIONS_DDL = `
  CREATE TABLE sessions (
    phone TEXT PRIMARY KEY,
    agent_session_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * A database as an older build left it: every other table at today's shape, and
 * `sessions` still keyed by phone. Built by replacing the table rather than by
 * hand-rolling the whole schema, so this fixture cannot drift away from the
 * schema the rest of the suite runs against.
 */
function legacyDb(): DB {
  const db = openDb(":memory:");
  db.exec(`DROP TABLE sessions;${LEGACY_SESSIONS_DDL}`);
  return db;
}

function insertLegacyRow(db: DB, phone: string, sessionId: string, updatedAt: string): void {
  db.prepare(`INSERT INTO sessions (phone, agent_session_id, updated_at) VALUES (?, ?, ?)`).run(
    phone,
    sessionId,
    updatedAt,
  );
}

const NOW = "2026-01-01 00:00:00";
/** Owner phones map to the inventory agent, everyone else to sales — index.ts's rule. */
const RESOLVER = (phone: string): string =>
  phone === OWNER ? "vitrina-inventario" : "vitrina-ventas";

describe("sessions migration to (agent_id, conversation_key)", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  it("gives a fresh database the composite key without any migration step", () => {
    db = openDb(":memory:");

    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as {
      name: string;
      pk: number;
    }[];
    const key = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(key).toEqual(["agent_id", "conversation_key"]);
  });

  it("copies legacy rows under the agent the resolver names for their phone", () => {
    db = legacyDb();
    insertLegacyRow(db, OWNER, "session-owner", NOW);
    insertLegacyRow(db, CUSTOMER, "session-customer", NOW);

    createSchema(db, { legacyAgentIdFor: RESOLVER });

    expect(getSessionId(db, "vitrina-inventario", OWNER)).toBe("session-owner");
    expect(getSessionId(db, "vitrina-ventas", CUSTOMER)).toBe("session-customer");
    // And under nobody else: a copy that fanned a row out to every agent would
    // hand one person's transcript to a different assistant.
    expect(getSessionId(db, "vitrina-ventas", OWNER)).toBeUndefined();
    expect(getSessionId(db, "vitrina-inventario", CUSTOMER)).toBeUndefined();
  });

  // The expiry window is a SLIDING one, measured from updated_at. Stamping the
  // copies with now() would resurrect every session the window had already
  // retired and drag months of history back into the next turn.
  it("preserves updated_at, so an expired session stays expired", () => {
    db = legacyDb();
    insertLegacyRow(db, CUSTOMER, "session-stale", "2020-05-05 05:05:05");

    createSchema(db, { legacyAgentIdFor: RESOLVER });

    expect(getSessionId(db, "vitrina-ventas", CUSTOMER, 7)).toBeUndefined();
    expect(getSessionId(db, "vitrina-ventas", CUSTOMER)).toBe("session-stale");
  });

  // The decision this pins: a legacy row knows a phone and not an agent, and a
  // caller with no owner allowlist in reach cannot resolve one. Guessing would
  // give a customer the inventory assistant's transcript; dropping costs one
  // conversation's history, which the resume-failure path already survives.
  it("drops legacy rows when no resolver is supplied", () => {
    db = legacyDb();
    insertLegacyRow(db, OWNER, "session-owner", NOW);
    insertLegacyRow(db, CUSTOMER, "session-customer", NOW);

    createSchema(db);

    expect(listSessions(db)).toEqual([]);
    // The table is still the NEW one: the rebuild happened, only the copy did not.
    expect(getSessionId(db, "vitrina-ventas", CUSTOMER)).toBeUndefined();
    setSessionId(db, "vitrina-ventas", CUSTOMER, "session-fresh");
    expect(getSessionId(db, "vitrina-ventas", CUSTOMER)).toBe("session-fresh");
  });

  // It runs on EVERY boot. A second pass that rebuilt again would drop the
  // sessions the first pass just migrated, so every redeploy would silently
  // reset every live conversation.
  it("is a no-op on the next boot and keeps every row", () => {
    db = legacyDb();
    insertLegacyRow(db, OWNER, "session-owner", NOW);

    createSchema(db, { legacyAgentIdFor: RESOLVER });
    setSessionId(db, "vitrina-ventas", CUSTOMER, "session-after-migration");
    createSchema(db, { legacyAgentIdFor: RESOLVER });
    createSchema(db, { legacyAgentIdFor: RESOLVER });

    expect(getSessionId(db, "vitrina-inventario", OWNER)).toBe("session-owner");
    expect(getSessionId(db, "vitrina-ventas", CUSTOMER)).toBe("session-after-migration");
    expect(listSessions(db)).toHaveLength(2);
  });

  // Rows written after the migration must not depend on the resolver being
  // passed: a later boot without one (an ops script, a test) must not wipe them.
  it("does not touch migrated rows when a later boot omits the resolver", () => {
    db = legacyDb();
    insertLegacyRow(db, OWNER, "session-owner", NOW);

    createSchema(db, { legacyAgentIdFor: RESOLVER });
    createSchema(db);

    expect(getSessionId(db, "vitrina-inventario", OWNER)).toBe("session-owner");
  });

  it("leaves nothing behind from the rebuild", () => {
    db = legacyDb();
    insertLegacyRow(db, OWNER, "session-owner", NOW);

    createSchema(db, { legacyAgentIdFor: RESOLVER });

    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sessions%'`)
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(["sessions"]);
  });
});

/**
 * The resolver an OPS ENTRY POINT passes (router.ts refusingLegacyAgentIdFor).
 *
 * Opening the database is what runs this migration, so a command cannot check
 * first — the check has to be the resolver itself. Since Phase 6 the owner
 * allowlist may legitimately live only in the assignments table, so refusing
 * every command on an empty variable would be the wrong question; refusing only
 * when a legacy row must actually be placed is the right one.
 */
describe("the refusing resolver an ops entry point passes", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  it("leaves the legacy table untouched when it cannot tell owner from customer", () => {
    db = legacyDb();
    insertLegacyRow(db, OWNER, "session-owner", NOW);

    expect(() =>
      createSchema(db, { legacyAgentIdFor: refusingLegacyAgentIdFor(new Set()) }),
    ).toThrow(/OWNER_PHONE_NUMBERS is empty/);

    // Rolled back whole: the rebuild runs in one transaction, so the row is
    // still there, still under the old key, and a later run with an allowlist
    // migrates it correctly. A half-migrated database is the one outcome that
    // could not be recovered from.
    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("phone");
    expect(columns.some((c) => c.name === "conversation_key")).toBe(false);
    expect(
      db.prepare(`SELECT agent_session_id FROM sessions WHERE phone = ?`).get(OWNER),
    ).toEqual({ agent_session_id: "session-owner" });
    // And the half-built copy is gone with it, rather than left behind for the
    // next boot to trip over.
    expect(() => db.prepare(`SELECT 1 FROM sessions_rekeyed`).get()).toThrow(/no such table/);
  });

  // ONE axis from the case above: the same empty allowlist, no legacy row to
  // place. Nothing is at risk, so the command must run — this is the deployment
  // whose owners live in the assignments table with the variable unset.
  it("migrates an empty legacy table with no allowlist at all", () => {
    db = legacyDb();

    expect(() =>
      createSchema(db, { legacyAgentIdFor: refusingLegacyAgentIdFor(new Set()) }),
    ).not.toThrow();

    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    expect(columns.some((c) => c.name === "conversation_key")).toBe(true);
  });

  // And an already-migrated database never reaches the resolver at all, which
  // is what makes every routine run of an ops command unaffected by this.
  it("never asks about a database that has already been re-keyed", () => {
    db = openDb(":memory:");
    setSessionId(db, "vitrina-inventario", OWNER, "session-owner");

    expect(() =>
      createSchema(db, { legacyAgentIdFor: refusingLegacyAgentIdFor(new Set()) }),
    ).not.toThrow();
    expect(getSessionId(db, "vitrina-inventario", OWNER)).toBe("session-owner");
  });
});
