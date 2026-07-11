import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  deleteStaleInboxRows,
  getInboxRow,
  getSessionId,
  insertInboxMessage,
  listReplayableInbox,
  markInboxDone,
  markInboxFailed,
  markInboxProcessing,
  setSessionId,
} from "../src/repo.js";

const MSG = { dedupe_key: "msg:wamid.1", phone: "573001", agent_text: "hola" };

describe("inbox lifecycle (at-least-once)", () => {
  it("persists a message as pending and replays it", () => {
    const db = openDb(":memory:");
    const row = insertInboxMessage(db, MSG);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(listReplayableInbox(db).map((r) => r.id)).toEqual([row?.id]);
    db.close();
  });

  it("replays rows interrupted mid-processing, but not settled ones", () => {
    const db = openDb(":memory:");
    const a = insertInboxMessage(db, MSG);
    const b = insertInboxMessage(db, { ...MSG, dedupe_key: "msg:wamid.2" });
    const c = insertInboxMessage(db, { ...MSG, dedupe_key: "msg:wamid.3" });
    if (!a || !b || !c) throw new Error("insert failed");

    markInboxProcessing(db, a.id); // crashed mid-run → replayable
    markInboxProcessing(db, b.id);
    markInboxDone(db, b.id); // finished → settled
    markInboxProcessing(db, c.id);
    markInboxFailed(db, c.id); // failed → settled (kept for diagnosis)

    expect(listReplayableInbox(db).map((r) => r.id)).toEqual([a.id]);
    expect(getInboxRow(db, a.id)?.attempts).toBe(1);
    expect(getInboxRow(db, b.id)?.status).toBe("done");
    expect(getInboxRow(db, c.id)?.status).toBe("failed");
    db.close();
  });

  it("deletes settled rows past their TTL but keeps fresh and unfinished ones", () => {
    const db = openDb(":memory:");
    const oldDone = insertInboxMessage(db, { ...MSG, dedupe_key: "k1" });
    const freshDone = insertInboxMessage(db, { ...MSG, dedupe_key: "k2" });
    const oldFailed = insertInboxMessage(db, { ...MSG, dedupe_key: "k3" });
    const pending = insertInboxMessage(db, { ...MSG, dedupe_key: "k4" });
    if (!oldDone || !freshDone || !oldFailed || !pending) throw new Error("insert failed");

    markInboxDone(db, oldDone.id);
    markInboxDone(db, freshDone.id);
    markInboxFailed(db, oldFailed.id);
    const backdate = db.prepare(`UPDATE inbox SET processed_at = datetime('now', ?) WHERE id = ?`);
    backdate.run("-10 days", oldDone.id); // past the 7-day done TTL
    backdate.run("-40 days", oldFailed.id); // past the 30-day failed TTL

    expect(deleteStaleInboxRows(db)).toBe(2);
    expect(getInboxRow(db, oldDone.id)).toBeNull();
    expect(getInboxRow(db, oldFailed.id)).toBeNull();
    expect(getInboxRow(db, freshDone.id)?.status).toBe("done");
    expect(getInboxRow(db, pending.id)?.status).toBe("pending");
    db.close();
  });
});

describe("session expiry", () => {
  it("returns the session while fresh and expires it after maxAgeDays", () => {
    const db = openDb(":memory:");
    setSessionId(db, "573001", "session-abc");
    expect(getSessionId(db, "573001", 7)).toBe("session-abc");

    db.prepare(`UPDATE sessions SET updated_at = datetime('now', '-10 days') WHERE phone = ?`).run(
      "573001",
    );
    expect(getSessionId(db, "573001", 7)).toBeUndefined(); // expired → fresh conversation
    expect(getSessionId(db, "573001")).toBe("session-abc"); // no max age → still stored
    db.close();
  });
});
