import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchema, openDb, type DB } from "../src/data/db.js";
import {
  claimInboxBatch,
  deleteConversationMessages,
  deleteStaleInboxRows,
  getInboxRow,
  insertInboxMessage,
  listConversationMessages,
  markInboxBatchDone,
  recordInboundMessages,
  recordOutboundMessage,
  type InboxRow,
} from "../src/data/repo.js";

/**
 * The durable conversation record: what was said, in both directions, kept
 * beyond the work queue that carried it.
 *
 * `inbox` is a QUEUE, not a history — deleteStaleInboxRows drops settled rows
 * seven days on, and nothing has ever persisted an outbound reply at all. So
 * the two failures this file exists to catch are a record the inbox sweep takes
 * with it, and a record a retried batch writes twice: delivery is at-least-once,
 * and processBatch re-runs the same code over the same messages up to
 * MAX_BATCH_ATTEMPTS times.
 */

const PHONE = "573001112233";
const OTHER_PHONE = "573009998877";
const AGENT = "vitrina-inventario";

let seq = 0;

/**
 * Put messages on the wire for one conversation and claim them, exactly as
 * processBatch does — so the rows handed to the recorder are the rows the
 * batcher actually holds, ordered and stamped the way it sees them.
 */
function arrive(db: DB, phone: string, texts: string[]): InboxRow[] {
  for (const text of texts) {
    seq += 1;
    insertInboxMessage(db, { dedupe_key: `wamid:${seq}`, phone, agent_text: text });
  }
  return claimInboxBatch(db, phone);
}

/** Re-stamp claimed rows, so ordering assertions do not hinge on one second. */
function stampedAt(rows: InboxRow[], stamps: string[]): InboxRow[] {
  return rows.map((row, i) => ({ ...row, received_at: stamps[i]! }));
}

/**
 * Settle a batch, as processBatch does once its turn succeeds. Needed wherever
 * a test flushes twice: claimInboxBatch takes every UN-SETTLED row of the
 * conversation, so an unsettled first burst is claimed again by the second.
 */
function settle(db: DB, rows: InboxRow[]): void {
  markInboxBatchDone(
    db,
    rows.map((row) => row.id),
  );
}

describe("the conversation_messages schema", () => {
  let db: DB;

  afterEach(() => {
    db.close();
  });

  it("gives a fresh database the table without a migration step", () => {
    db = openDb(":memory:");

    const columns = (
      db.prepare(`PRAGMA table_info(conversation_messages)`).all() as { name: string }[]
    ).map((c) => c.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "dedupe_key",
        "direction",
        "conversation_key",
        "agent_id",
        "body",
        "kind",
        "turn_key",
        "source_inbox_id",
        "occurred_at",
      ]),
    );
  });

  // A new table, so CREATE TABLE IF NOT EXISTS IS the migration: the running
  // pilot's database has every other table and not this one, and the next boot
  // has to add it without disturbing what is already there.
  it("creates the table on a database that predates it, keeping the rest intact", () => {
    db = openDb(":memory:");
    insertInboxMessage(db, { dedupe_key: "wamid:legacy", phone: PHONE, agent_text: "hola" });
    db.exec(`DROP TABLE conversation_messages`);

    createSchema(db);

    expect(() => db.prepare(`SELECT 1 FROM conversation_messages`).all()).not.toThrow();
    expect(getInboxRow(db, 1)?.agent_text).toBe("hola");
  });

  it("re-runs on an up-to-date database without touching what is stored", () => {
    db = openDb(":memory:");
    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows: arrive(db, PHONE, ["hola"]) });

    createSchema(db);

    expect(listConversationMessages(db, PHONE)).toHaveLength(1);
  });

  it("indexes the conversation so a read never scans the whole record", () => {
    db = openDb(":memory:");
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM conversation_messages WHERE conversation_key = ?
         ORDER BY occurred_at ASC, id ASC`,
      )
      .all(PHONE) as { detail: string }[];

    expect(plan.map((step) => step.detail).join(" ")).toContain("USING INDEX");
  });

  // The record must outlive the inbox row it names, so it cannot be a foreign
  // key: with foreign_keys = ON a declared one would either refuse the TTL
  // sweep or cascade into here, and both defeat the table.
  it("declares no foreign key back to the inbox", () => {
    db = openDb(":memory:");

    expect(db.prepare(`PRAGMA foreign_key_list(conversation_messages)`).all()).toEqual([]);
  });
});

describe("recording what arrived", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  // Per MESSAGE, not per prompt. buildBatchText collapses a burst into one
  // string; that string is a derived artifact of how long the debounce happened
  // to be, while the messages are what the person actually sent.
  it("writes one row per message, not one per coalesced prompt", () => {
    const rows = arrive(db, PHONE, ["hola", "tenes camisas?", "negras"]);

    const written = recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows });

    expect(written).toBe(3);
    expect(listConversationMessages(db, PHONE).map((m) => m.body)).toEqual([
      "hola",
      "tenes camisas?",
      "negras",
    ]);
  });

  it("carries the turn key on every row, so which messages were answered together is visible", () => {
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t1",
      rows: arrive(db, PHONE, ["hola", "tenes camisas?"]),
    });
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t2",
      rows: arrive(db, PHONE, ["y en negro?"]),
    });

    expect(listConversationMessages(db, PHONE).map((m) => m.turn_key)).toEqual(["t1", "t1", "t2"]);
  });

  // The conversation comes off the ROW, which is where the door that
  // authenticated the sender wrote it — not from a second argument that could
  // file one person's words under another's conversation. The dedupe key is the
  // inbox id, so such a mistake would be permanent: the correcting write reads
  // as a duplicate and is ignored.
  it("files each message under the conversation its own row names", () => {
    const rows = arrive(db, PHONE, ["hola"]);

    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows });

    expect(listConversationMessages(db, PHONE)).toHaveLength(1);
    expect(listConversationMessages(db, OTHER_PHONE)).toEqual([]);
  });

  it("records which assistant answered, which no inbox row can say", () => {
    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows: arrive(db, PHONE, ["hola"]) });

    expect(listConversationMessages(db, PHONE)[0]?.agent_id).toBe(AGENT);
  });

  // THE retry case. A failed batch returns its rows to 'pending' and the next
  // flush claims them again, running this same code with the same rows and the
  // same turn key. Keyed on the originating inbox row, a re-record is a no-op.
  it("records the same batch twice as one set of rows", () => {
    const rows = arrive(db, PHONE, ["hola", "tenes camisas?"]);
    const input = { agentId: AGENT, turnKey: "t1", rows };

    expect(recordInboundMessages(db, input)).toBe(2);
    expect(recordInboundMessages(db, input)).toBe(0);
    expect(listConversationMessages(db, PHONE)).toHaveLength(2);
  });

  // A retried batch does not just repeat: it ABSORBS whatever arrived while it
  // was waiting. The rows it already recorded must not double, and the new ones
  // must land.
  it("records only what is new when a retried batch has grown", () => {
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t1",
      rows: arrive(db, PHONE, ["hola", "tenes camisas?"]),
    });

    const grown = arrive(db, PHONE, ["negras"]);
    expect(grown).toHaveLength(3);

    expect(recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows: grown })).toBe(1);
    expect(listConversationMessages(db, PHONE)).toHaveLength(3);
  });

  // A photo's caption is stored as its text and an uncaptioned photo has none
  // at all, so an empty body is a photo, an unsupported event, or a bug — and
  // the record cannot tell them apart without the kind the door parsed.
  it("keeps the kind the door parsed, so an uncaptioned photo is not an empty line", () => {
    insertInboxMessage(db, {
      dedupe_key: "wamid:photo",
      phone: PHONE,
      agent_text: "",
      kind: "media",
    });
    const rows = claimInboxBatch(db, PHONE);

    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows });

    expect(listConversationMessages(db, PHONE)[0]).toMatchObject({ kind: "media", body: "" });
  });

  it("stamps each message with when it arrived, not with when the burst flushed", () => {
    const rows = stampedAt(arrive(db, PHONE, ["hola"]), ["2026-01-01 10:00:00"]);

    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows });

    expect(listConversationMessages(db, PHONE)[0]?.occurred_at).toBe("2026-01-01 10:00:00");
  });

  it("records nothing at all for an empty batch", () => {
    expect(recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows: [] })).toBe(0);
  });
});

describe("recording what was sent", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("writes the reply the caller actually delivered", () => {
    const written = recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Tenemos camisas negras en talla M.",
    });

    expect(written).toBe(true);
    expect(listConversationMessages(db, PHONE)[0]).toMatchObject({
      direction: "outbound",
      body: "Tenemos camisas negras en talla M.",
      turn_key: "t1",
      agent_id: AGENT,
      source_inbox_id: null,
    });
  });

  // Delivery is at-least-once end to end: a crash between the send and the
  // batch settling replays the turn, and an identical reply then reaches the
  // record a second time. Same turn, same words, one row.
  it("collapses the same reply delivered twice for one turn", () => {
    const reply = { agentId: AGENT, conversationKey: PHONE, turnKey: "t1", body: "Listo." };

    expect(recordOutboundMessage(db, reply)).toBe(true);
    expect(recordOutboundMessage(db, reply)).toBe(false);
    expect(listConversationMessages(db, PHONE)).toHaveLength(1);
  });

  // The other half of that decision, and the reason the key is not the turn
  // alone: a replayed turn may answer DIFFERENTLY, and the person received both.
  // A record that hid the second would be a record of a conversation nobody had.
  it("keeps a second, different reply from the same turn", () => {
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Listo.",
    });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Perdón, ya no queda stock.",
    });

    expect(listConversationMessages(db, PHONE)).toHaveLength(2);
  });

  it("keeps the same words said again in a later turn", () => {
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Listo.",
    });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t2",
      body: "Listo.",
    });

    expect(listConversationMessages(db, PHONE)).toHaveLength(2);
  });

  it("keeps the same words said to two different people apart", () => {
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Listo.",
    });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: OTHER_PHONE,
      turnKey: "t1",
      body: "Listo.",
    });

    expect(listConversationMessages(db, PHONE)).toHaveLength(1);
    expect(listConversationMessages(db, OTHER_PHONE)).toHaveLength(1);
  });

  // An inbound key can never be an outbound key: the two directions mint theirs
  // differently, so a message id and a reply hash cannot collide into one row.
  it("never collides with an inbound message", () => {
    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows: arrive(db, PHONE, ["hola"]) });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "hola",
    });

    expect(listConversationMessages(db, PHONE)).toHaveLength(2);
  });
});

describe("reading a conversation back", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("interleaves both directions in the order they happened", () => {
    const first = arrive(db, PHONE, ["hola", "tenes camisas?"]);
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t1",
      rows: stampedAt(first, ["2026-01-01 10:00:01", "2026-01-01 10:00:02"]),
    });
    settle(db, first);
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Si, en negro y blanco.",
      occurredAt: "2026-01-01 10:00:05",
    });
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t2",
      rows: stampedAt(arrive(db, PHONE, ["dame la negra"]), ["2026-01-01 10:00:09"]),
    });

    expect(listConversationMessages(db, PHONE).map((m) => [m.direction, m.body])).toEqual([
      ["inbound", "hola"],
      ["inbound", "tenes camisas?"],
      ["outbound", "Si, en negro y blanco."],
      ["inbound", "dame la negra"],
    ]);
  });

  // Same second, both directions: occurred_at has second resolution, so write
  // order is the only thing left to order by — and a reply cannot precede the
  // message it answers.
  it("falls back to write order when two messages share a second", () => {
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t1",
      rows: stampedAt(arrive(db, PHONE, ["hola"]), ["2026-01-01 10:00:00"]),
    });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Hola!",
      occurredAt: "2026-01-01 10:00:00",
    });

    expect(listConversationMessages(db, PHONE).map((m) => m.direction)).toEqual([
      "inbound",
      "outbound",
    ]);
  });

  it("returns nothing for a conversation that has none", () => {
    expect(listConversationMessages(db, PHONE)).toEqual([]);
  });

  it("shows only the conversation asked for", () => {
    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows: arrive(db, PHONE, ["mia"]) });
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t2",
      rows: arrive(db, OTHER_PHONE, ["ajena"]),
    });

    expect(listConversationMessages(db, PHONE).map((m) => m.body)).toEqual(["mia"]);
  });

  // A limit takes the MOST RECENT, then hands them back oldest-first. Taking
  // the first n would answer "how did this conversation start" to a caller
  // asking what just happened, which is the question a long thread makes urgent.
  it("takes the most recent messages under a limit, still oldest first", () => {
    for (const n of [1, 2, 3, 4]) {
      recordOutboundMessage(db, {
        agentId: AGENT,
        conversationKey: PHONE,
        turnKey: `t${n}`,
        body: `reply ${n}`,
        occurredAt: `2026-01-01 10:00:0${n}`,
      });
    }

    expect(listConversationMessages(db, PHONE, 2).map((m) => m.body)).toEqual([
      "reply 3",
      "reply 4",
    ]);
  });
});

describe("outliving the work queue", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  // The whole reason this table exists. deleteStaleInboxRows drops settled rows
  // after seven days; the record of the conversation must not go with them, and
  // source_inbox_id must therefore not be a foreign key.
  it("survives the inbox sweep that deletes the rows it was made from", () => {
    const rows = arrive(db, PHONE, ["hola", "tenes camisas?"]);
    recordInboundMessages(db, { agentId: AGENT, turnKey: "t1", rows });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Si.",
    });
    markInboxBatchDone(
      db,
      rows.map((row) => row.id),
    );
    db.prepare(`UPDATE inbox SET processed_at = datetime('now', '-30 days')`).run();

    expect(deleteStaleInboxRows(db)).toBe(2);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM inbox`).get()).toEqual({ n: 0 });
    expect(listConversationMessages(db, PHONE)).toHaveLength(3);
    expect(listConversationMessages(db, PHONE)[0]?.source_inbox_id).toBe(rows[0]!.id);
  });

  // No automatic expiry is IMPLEMENTED ON PURPOSE: how long a customer's
  // conversation is kept is a business decision nobody has made. This pins that
  // nothing quietly started making it.
  it("keeps a message no matter how old it is", () => {
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "hace años",
      occurredAt: "2019-01-01 00:00:00",
    });

    deleteStaleInboxRows(db);

    expect(listConversationMessages(db, PHONE)).toHaveLength(1);
  });
});

describe("forgetting a conversation", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("removes exactly that conversation and nothing else", () => {
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t1",
      rows: arrive(db, PHONE, ["hola", "tenes camisas?"]),
    });
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Si.",
    });
    recordInboundMessages(db, {
      agentId: AGENT,
      turnKey: "t2",
      rows: arrive(db, OTHER_PHONE, ["buenas"]),
    });

    expect(deleteConversationMessages(db, PHONE)).toBe(3);

    expect(listConversationMessages(db, PHONE)).toEqual([]);
    expect(listConversationMessages(db, OTHER_PHONE)).toHaveLength(1);
  });

  it("reports nothing deleted for a conversation with no record", () => {
    expect(deleteConversationMessages(db, PHONE)).toBe(0);
  });

  // A purged conversation that starts talking again is a NEW conversation, not
  // a resurrection: the inbox rows it was made from are long gone, so nothing
  // can re-record what was deleted, and the same key must be writable again.
  it("lets the same conversation be recorded again afterwards", () => {
    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t1",
      body: "Si.",
    });
    deleteConversationMessages(db, PHONE);

    recordOutboundMessage(db, {
      agentId: AGENT,
      conversationKey: PHONE,
      turnKey: "t2",
      body: "Hola.",
    });

    expect(listConversationMessages(db, PHONE)).toHaveLength(1);
  });
});
