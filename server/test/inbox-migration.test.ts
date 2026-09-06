import { afterEach, describe, expect, it } from "vitest";
import { createSchema, openDb, type DB } from "../src/data/db.js";
import {
  claimInboxBatch,
  getInboxRow,
  insertInboxMessage,
  listReplayableInbox,
} from "../src/data/repo.js";

/**
 * The six envelope columns on `inbox`, against a database that already exists.
 *
 * One inbox, two doors: a row now records who asked, which agent must answer,
 * which conversation it belongs to, where the reply goes and how many agent
 * hops produced it. `CREATE TABLE IF NOT EXISTS` never reaches a table that is
 * already there, so the running pilot only gets these columns through migrate()
 * — and the two things that can go wrong with that are losing rows and leaving
 * a row nothing can ever claim.
 *
 * A row with no conversation_key is the failure this file exists to catch: the
 * claim is BY conversation now, so such a row is unclaimable, and unclaimable
 * means a message that is never answered and never reported.
 */

const PHONE = "573001112233";

/** Exactly the `inbox` DDL a pre-envelope build shipped — not a paraphrase. */
const LEGACY_INBOX_DDL = `
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    agent_text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text'
      CHECK (kind IN ('text','media')),
    audio_path TEXT,
    media_ref TEXT,
    media_kind TEXT,
    media_mime TEXT,
    media_name TEXT,
    media_sent_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','processing','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );
`;

/**
 * A database as an older build left it: every other table at today's shape and
 * `inbox` without its envelope. Built by replacing the one table rather than by
 * hand-rolling the whole schema, so the fixture cannot drift from what the rest
 * of the suite runs against.
 */
function legacyDb(): DB {
  const db = openDb(":memory:");
  db.exec(`DROP TABLE inbox;${LEGACY_INBOX_DDL}`);
  return db;
}

function insertLegacyRow(db: DB, phone: string, text: string, status = "pending"): number {
  const info = db
    .prepare(
      `INSERT INTO inbox (dedupe_key, phone, agent_text, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`msg:${text}`, phone, text, status);
  return Number(info.lastInsertRowid);
}

function columnNames(db: DB): string[] {
  return (db.prepare(`PRAGMA table_info(inbox)`).all() as { name: string }[]).map((c) => c.name);
}

describe("the inbox envelope columns, migrated", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  it("gives a fresh database every envelope column without a migration step", () => {
    db = openDb(":memory:");

    expect(columnNames(db)).toEqual(
      expect.arrayContaining([
        "agent_id",
        "principal_kind",
        "principal_id",
        "conversation_key",
        "reply_to",
        "hop",
      ]),
    );
  });

  it("adds the columns to a database that predates them", () => {
    db = legacyDb();
    expect(columnNames(db)).not.toContain("conversation_key");

    createSchema(db);

    expect(columnNames(db)).toEqual(
      expect.arrayContaining([
        "agent_id",
        "principal_kind",
        "principal_id",
        "conversation_key",
        "reply_to",
        "hop",
      ]),
    );
  });

  // The row is what a person sent before the second door existed. Left with a
  // NULL conversation_key it could never be claimed again: the claim is by
  // conversation, so the message would sit unanswered with nothing reporting it.
  it("backfills a legacy row's conversation from the only identity it has", () => {
    db = legacyDb();
    const id = insertLegacyRow(db, PHONE, "hola");

    createSchema(db);

    const row = getInboxRow(db, id)!;
    expect(row.conversation_key).toBe(PHONE);
    expect(row.principal_id).toBe(PHONE);
    // The default on the ADD COLUMN, not a guess: every legacy row is WhatsApp's.
    expect(row.principal_kind).toBe("whatsapp");
    expect(row.hop).toBe(0);
    expect(row.agent_id).toBeNull();
    expect(row.reply_to).toBeNull();
  });

  it("leaves a backfilled legacy row claimable, and claims it by its phone", () => {
    db = legacyDb();
    insertLegacyRow(db, PHONE, "hola");

    createSchema(db);

    const claimed = claimInboxBatch(db, PHONE);
    expect(claimed.map((r) => r.agent_text)).toEqual(["hola"]);
  });

  // Idempotence is the property a boot loop depends on: the schema runs on
  // EVERY openDb, and a step that ran twice must not undo the first run.
  it("is idempotent across repeated boots and preserves the rows", () => {
    db = legacyDb();
    const id = insertLegacyRow(db, PHONE, "hola");

    createSchema(db);
    createSchema(db);
    createSchema(db);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM inbox`).get()).toEqual({ n: 1 });
    const row = getInboxRow(db, id)!;
    expect(row.conversation_key).toBe(PHONE);
    expect(row.status).toBe("pending");
    // One column, once: a second ALTER would throw, and a duplicate column
    // would make every SELECT * ambiguous.
    expect(columnNames(db).filter((c) => c === "conversation_key")).toHaveLength(1);
  });

  it("does not rewrite a conversation key that a door already set", () => {
    db = openDb(":memory:");
    insertInboxMessage(db, {
      dedupe_key: "a2a:1",
      phone: "",
      agent_text: "consulta interna",
      conversation_key: "a2a:super-agent:corr-1",
      principal_kind: "agent",
      principal_id: "super-agent",
      agent_id: "vitrina-inventario",
    });

    createSchema(db);

    const row = listReplayableInbox(db)[0]!;
    expect(row.conversation_key).toBe("a2a:super-agent:corr-1");
    expect(row.principal_id).toBe("super-agent");
  });
});

describe("insertInboxMessage and the envelope", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  // The WhatsApp door names no conversation, because on that door the phone IS
  // the conversation. Resolved in SQL so no caller can write a row with none.
  it("defaults a WhatsApp row's conversation and principal to its phone", () => {
    db = openDb(":memory:");

    const row = insertInboxMessage(db, {
      dedupe_key: "msg:1",
      phone: PHONE,
      agent_text: "hola",
    })!;

    expect(row.conversation_key).toBe(PHONE);
    expect(row.principal_kind).toBe("whatsapp");
    expect(row.principal_id).toBe(PHONE);
    expect(row.hop).toBe(0);
  });

  it("records an agent row's envelope exactly as the door authenticated it", () => {
    db = openDb(":memory:");

    const row = insertInboxMessage(db, {
      dedupe_key: "a2a:1",
      phone: "",
      agent_text: "¿cuántas CAM-NEG-M quedan?",
      agent_id: "vitrina-inventario",
      principal_kind: "agent",
      principal_id: "super-agent",
      conversation_key: "a2a:super-agent:corr-1",
      reply_to: "https://super.internal/callbacks/7",
      hop: 2,
    })!;

    expect(row).toMatchObject({
      agent_id: "vitrina-inventario",
      principal_kind: "agent",
      principal_id: "super-agent",
      conversation_key: "a2a:super-agent:corr-1",
      reply_to: "https://super.internal/callbacks/7",
      hop: 2,
      // An agent caller has no phone, and the column predates the second door.
      phone: "",
    });
  });
});

describe("claimInboxBatch claims a conversation, not a phone", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  it("claims one phone's rows exactly as it always did", () => {
    db = openDb(":memory:");
    insertInboxMessage(db, { dedupe_key: "msg:1", phone: PHONE, agent_text: "hola" });
    insertInboxMessage(db, { dedupe_key: "msg:2", phone: PHONE, agent_text: "¿precio?" });
    insertInboxMessage(db, { dedupe_key: "msg:3", phone: "573009998877", agent_text: "otra" });

    const claimed = claimInboxBatch(db, PHONE);

    expect(claimed.map((r) => r.agent_text)).toEqual(["hola", "¿precio?"]);
  });

  // The correlation id is chosen by the CALLER. Without a namespace an agent
  // could pass a phone number and claim — answer, and settle — that person's
  // pending messages, receiving their words in its own response body.
  it("cannot reach a phone's rows from an agent conversation with the same digits", () => {
    db = openDb(":memory:");
    insertInboxMessage(db, { dedupe_key: "msg:1", phone: PHONE, agent_text: "hola" });
    insertInboxMessage(db, {
      dedupe_key: "a2a:1",
      phone: "",
      agent_text: "consulta interna",
      principal_kind: "agent",
      principal_id: "super-agent",
      conversation_key: `a2a:super-agent:${PHONE}`,
      agent_id: "vitrina-inventario",
    });

    const claimed = claimInboxBatch(db, `a2a:super-agent:${PHONE}`);

    expect(claimed.map((r) => r.agent_text)).toEqual(["consulta interna"]);
    expect(getInboxRow(db, 1)!.status).toBe("pending");
  });
});
