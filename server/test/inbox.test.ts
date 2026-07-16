import { describe, expect, it } from "vitest";
import { openDb } from "../src/data/db.js";
import {
  claimInboxBatch,
  deleteStaleInboxRows,
  getInboxRow,
  getSessionId,
  insertInboxMessage,
  listReplayableInbox,
  markInboxBatchDone,
  markInboxBatchFailed,
  setSessionId,
} from "../src/data/repo.js";

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
    const b = insertInboxMessage(db, { ...MSG, dedupe_key: "msg:wamid.2", phone: "573002" });
    const c = insertInboxMessage(db, { ...MSG, dedupe_key: "msg:wamid.3", phone: "573003" });
    if (!a || !b || !c) throw new Error("insert failed");

    claimInboxBatch(db, a.phone); // crashed mid-run → replayable
    claimInboxBatch(db, b.phone);
    markInboxBatchDone(db, [b.id]); // finished → settled
    claimInboxBatch(db, c.phone);
    markInboxBatchFailed(db, [c.id]); // failed → settled (kept for diagnosis)

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

    markInboxBatchDone(db, [oldDone.id, freshDone.id]);
    markInboxBatchFailed(db, [oldFailed.id]);
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

describe("inbox batch claim", () => {
  it("claims one phone's un-settled rows in arrival order and skips other phones", () => {
    const db = openDb(":memory:");
    const a = insertInboxMessage(db, { ...MSG, dedupe_key: "k1", agent_text: "uno" });
    const b = insertInboxMessage(db, { ...MSG, dedupe_key: "k2", agent_text: "dos" });
    const other = insertInboxMessage(db, { ...MSG, dedupe_key: "k3", phone: "573002" });
    const settled = insertInboxMessage(db, { ...MSG, dedupe_key: "k4", agent_text: "viejo" });
    if (!a || !b || !other || !settled) throw new Error("insert failed");
    markInboxBatchDone(db, [settled.id]);
    // Simulate a crash mid-batch: the row is left 'processing' with one attempt.
    db.prepare(`UPDATE inbox SET status = 'processing', attempts = 1 WHERE id = ?`).run(a.id);

    const claimed = claimInboxBatch(db, MSG.phone);

    expect(claimed.map((r) => r.agent_text)).toEqual(["uno", "dos"]);
    expect(claimed.every((r) => r.status === "processing")).toBe(true);
    expect(claimed[0]?.attempts).toBe(2); // the crashed row's earlier attempt counts
    expect(getInboxRow(db, other.id)?.status).toBe("pending");
    db.close();
  });

  it("returns an empty batch when the phone has nothing pending", () => {
    const db = openDb(":memory:");
    expect(claimInboxBatch(db, "573009")).toEqual([]);
    db.close();
  });

  it("settles a whole batch at once, done or failed", () => {
    const db = openDb(":memory:");
    const a = insertInboxMessage(db, { ...MSG, dedupe_key: "k1" });
    const b = insertInboxMessage(db, { ...MSG, dedupe_key: "k2" });
    const c = insertInboxMessage(db, { ...MSG, dedupe_key: "k3" });
    if (!a || !b || !c) throw new Error("insert failed");

    markInboxBatchDone(db, [a.id, b.id]);
    markInboxBatchFailed(db, [c.id]);

    expect(getInboxRow(db, a.id)?.status).toBe("done");
    expect(getInboxRow(db, b.id)?.status).toBe("done");
    expect(getInboxRow(db, c.id)?.status).toBe("failed");
    expect(listReplayableInbox(db)).toEqual([]); // nothing left to replay
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
