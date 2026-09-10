import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findAgentByToken,
  hashAgentToken,
  mintAgentToken,
  upsertAgentCredential,
} from "../src/data/agent-registry.js";
import { listAssignments, roleForPhone } from "../src/data/assignments.js";
import { createSchema, openDb, type DB } from "../src/data/db.js";
import {
  addRosterEntry,
  countRosterEntries,
  deleteRosterEntry,
  findRosterByToken,
  listRosterEntries,
  rotateRosterToken,
} from "../src/data/test-roster.js";

/**
 * The test roster: which phones may flip their own role from the TEMPORARY
 * console.
 *
 * The property that carries the whole design is the second one below — a token
 * finds exactly ONE row, and that row carries the phone. The console has no
 * phone parameter anywhere, so containment is not a check that can be written
 * wrong; it is the shape of this lookup. Everything else here defends that
 * shape: the two key spaces stay disjoint, the row IS the credential, and no
 * plaintext token exists at rest.
 */

const PHONE = "573001112233";
const PHONE_TYPED = "+57 300 111 2233";
const OTHER_PHONE = "573004445566";

function fresh(): DB {
  return openDb(":memory:");
}

describe("the test roster", () => {
  it("authenticates nobody when it is empty", () => {
    const db = fresh();

    expect(countRosterEntries(db)).toBe(0);
    expect(findRosterByToken(db, mintAgentToken())).toBeNull();
    db.close();
  });

  // THE property. One token, one phone, and the phone comes from the row the
  // token matched — never from anything the request carried.
  it("finds exactly the row its own token was minted for", () => {
    const db = fresh();
    const mine = addRosterEntry(db, PHONE, "my phone");
    const theirs = addRosterEntry(db, OTHER_PHONE, "the other phone");

    expect(findRosterByToken(db, mine.token)?.phone).toBe(PHONE);
    expect(findRosterByToken(db, theirs.token)?.phone).toBe(OTHER_PHONE);
    db.close();
  });

  it("carries the operator's label back, so two phones are tellable apart", () => {
    const db = fresh();
    const { token } = addRosterEntry(db, PHONE, "Santiago — personal");

    expect(findRosterByToken(db, token)).toMatchObject({
      phone: PHONE,
      label: "Santiago — personal",
    });
    db.close();
  });

  it("trims the label an operator typed, and accepts an empty one", () => {
    const db = fresh();
    const padded = addRosterEntry(db, PHONE, "  spare handset  ");
    const blank = addRosterEntry(db, OTHER_PHONE, "");

    expect(findRosterByToken(db, padded.token)?.label).toBe("spare handset");
    expect(findRosterByToken(db, blank.token)?.label).toBe("");
    db.close();
  });

  it("refuses a token that matches no row", () => {
    const db = fresh();
    addRosterEntry(db, PHONE, "my phone");

    expect(findRosterByToken(db, mintAgentToken())).toBeNull();
    db.close();
  });

  it("refuses an absent or empty token without touching the table", () => {
    const db = fresh();
    addRosterEntry(db, PHONE, "my phone");

    expect(findRosterByToken(db, undefined)).toBeNull();
    expect(findRosterByToken(db, "")).toBeNull();
    db.close();
  });

  // A short or non-base64url token hashes to a perfectly well-formed SHA-256,
  // so this is not about the hash — it is that one refusal is the only answer,
  // with nothing thrown and nothing distinguishable from an unknown token.
  it("refuses a malformed or truncated token rather than throwing", () => {
    const db = fresh();
    addRosterEntry(db, PHONE, "my phone");

    for (const bad of ["x", "not-a-token", "!!!", " ", "0".repeat(500)]) {
      expect(() => findRosterByToken(db, bad)).not.toThrow();
      expect(findRosterByToken(db, bad)).toBeNull();
    }
    db.close();
  });

  // The length guard before timingSafeEqual, which THROWS on a length mismatch.
  // A hand-edited or truncated token_hash would otherwise take the whole
  // console down for every holder of a valid link, not just for that row.
  it("survives a truncated token_hash in the table, for every other holder", () => {
    const db = fresh();
    addRosterEntry(db, PHONE, "hand-edited");
    const good = addRosterEntry(db, OTHER_PHONE, "intact");
    db.prepare(`UPDATE test_roster SET token_hash = 'abcd' WHERE phone = ?`).run(PHONE);

    expect(() => findRosterByToken(db, good.token)).not.toThrow();
    expect(findRosterByToken(db, good.token)?.phone).toBe(OTHER_PHONE);
    db.close();
  });

  it("survives a non-hex token_hash in the table", () => {
    const db = fresh();
    addRosterEntry(db, PHONE, "hand-edited");
    const good = addRosterEntry(db, OTHER_PHONE, "intact");
    db.prepare(`UPDATE test_roster SET token_hash = 'not hex at all' WHERE phone = ?`).run(PHONE);

    expect(findRosterByToken(db, good.token)?.phone).toBe(OTHER_PHONE);
    db.close();
  });

  // The row IS the credential. A nullable hash would put a value into the scan
  // that Buffer.from(null, "hex") throws on — the exact failure the length
  // guard cannot save us from, since it never gets to run.
  it("refuses a row with no token_hash at the database level", () => {
    const db = fresh();

    expect(() =>
      db.prepare(`INSERT INTO test_roster (phone, token_hash) VALUES (?, NULL)`).run(PHONE),
    ).toThrow();
    db.close();
  });

  // Two rows sharing a hash would make one token resolve to whichever phone the
  // scan happened to see last — one link, silently the wrong person's role.
  it("refuses two rows sharing a token_hash at the database level", () => {
    const db = fresh();
    const { token } = addRosterEntry(db, PHONE, "my phone");

    expect(() =>
      db
        .prepare(`INSERT INTO test_roster (phone, token_hash) VALUES (?, ?)`)
        .run(OTHER_PHONE, hashAgentToken(token)),
    ).toThrow();

    expect(findRosterByToken(db, token)?.phone).toBe(PHONE);
    db.close();
  });

  it("stores no plaintext token, only its hash", () => {
    const db = fresh();
    const { token } = addRosterEntry(db, PHONE, "my phone");

    const row = db.prepare(`SELECT * FROM test_roster WHERE phone = ?`).get(PHONE) as Record<
      string,
      unknown
    >;
    expect(Object.values(row)).not.toContain(token);
    expect(row["token_hash"]).toBe(hashAgentToken(token));
    db.close();
  });

  // Deleting the row revokes on the NEXT request, with no restart and no second
  // flag to remember to turn off. An empty table means the feature is dead.
  it("revokes the moment its row is deleted", () => {
    const db = fresh();
    const { token } = addRosterEntry(db, PHONE, "my phone");

    expect(deleteRosterEntry(db, PHONE)).toBe(true);

    expect(findRosterByToken(db, token)).toBeNull();
    expect(countRosterEntries(db)).toBe(0);
    db.close();
  });

  it("reports nothing removed when the phone has no row", () => {
    const db = fresh();

    expect(deleteRosterEntry(db, PHONE)).toBe(false);
    db.close();
  });

  // One key space. A row written as "+57 300…" would never match an assignment
  // keyed "57300…", and the console would flip a role nobody has.
  it("keys a phone the way the assignments table does, however it was typed", () => {
    const db = fresh();
    const { phone, token } = addRosterEntry(db, PHONE_TYPED, "typed with spaces");

    expect(phone).toBe(PHONE);
    expect(findRosterByToken(db, token)?.phone).toBe(PHONE);
    expect(countRosterEntries(db)).toBe(1);
    db.close();
  });

  it("treats a differently typed spelling of one phone as the same row", () => {
    const db = fresh();
    addRosterEntry(db, PHONE_TYPED, "typed with spaces");

    expect(() => addRosterEntry(db, PHONE, "same phone, bare digits")).toThrow(/already/i);
    expect(deleteRosterEntry(db, PHONE)).toBe(true);
    db.close();
  });

  it("refuses a phone that normalises to no digits at all", () => {
    const db = fresh();

    expect(() => addRosterEntry(db, "+++", "nothing")).toThrow(/phone/i);
    expect(countRosterEntries(db)).toBe(0);
    db.close();
  });

  // `add` NEVER replaces. A second add would silently invalidate a live link and
  // its holder would start getting 401s with nothing connecting the two.
  it("refuses a second add for a phone that already has a credential", () => {
    const db = fresh();
    const first = addRosterEntry(db, PHONE, "my phone");

    expect(() => addRosterEntry(db, PHONE, "my phone again")).toThrow(/already/i);

    expect(findRosterByToken(db, first.token)?.phone).toBe(PHONE);
    expect(countRosterEntries(db)).toBe(1);
    db.close();
  });

  it("replaces the token on rotate, with no overlap window", () => {
    const db = fresh();
    const before = addRosterEntry(db, PHONE, "my phone");
    const after = rotateRosterToken(db, PHONE);

    expect(after.token).not.toBe(before.token);
    expect(findRosterByToken(db, before.token)).toBeNull();
    expect(findRosterByToken(db, after.token)?.phone).toBe(PHONE);
    expect(countRosterEntries(db)).toBe(1);
    db.close();
  });

  it("carries the label across a rotate, which is about the secret and nothing else", () => {
    const db = fresh();
    addRosterEntry(db, PHONE, "Santiago — personal");
    const after = rotateRosterToken(db, PHONE);

    expect(findRosterByToken(db, after.token)?.label).toBe("Santiago — personal");
    db.close();
  });

  it("refuses to rotate a phone that has no credential", () => {
    const db = fresh();

    expect(() => rotateRosterToken(db, PHONE)).toThrow(/no credential/i);
    expect(countRosterEntries(db)).toBe(0);
    db.close();
  });

  it("lists every entry in a stable order, and never a token", () => {
    const db = fresh();
    addRosterEntry(db, OTHER_PHONE, "second");
    addRosterEntry(db, PHONE, "first");

    const entries = listRosterEntries(db);
    expect(entries.map((e) => e.phone)).toEqual([PHONE, OTHER_PHONE]);
    expect(entries.map((e) => e.label)).toEqual(["first", "second"]);
    expect(JSON.stringify(entries)).not.toContain("token_hash");
    expect(countRosterEntries(db)).toBe(2);
    db.close();
  });

  /**
   * TWO KEY SPACES, two tables. A console token must never authenticate at
   * POST /agents/:id/messages, and an agent-door token must never be able to
   * flip a role. Sharing agent_registry would have made both true by accident.
   */
  describe("kept disjoint from the agent door", () => {
    it("does not authenticate a roster token at the agent door", () => {
      const db = fresh();
      const { token } = addRosterEntry(db, PHONE, "my phone");

      expect(findAgentByToken(db, token)).toBeNull();
      db.close();
    });

    it("does not authenticate an agent-door token against the roster", () => {
      const db = fresh();
      const token = mintAgentToken();
      upsertAgentCredential(db, { agentId: "super-agent", token, reach: [] });

      expect(findRosterByToken(db, token)).toBeNull();
      db.close();
    });

    it("leaves the agent registry untouched when a roster entry is written", () => {
      const db = fresh();
      const token = mintAgentToken();
      upsertAgentCredential(db, { agentId: "super-agent", token, reach: ["vitrina"] });

      addRosterEntry(db, PHONE, "my phone");
      rotateRosterToken(db, PHONE);
      deleteRosterEntry(db, PHONE);

      expect(findAgentByToken(db, token)?.agentId).toBe("super-agent");
      db.close();
    });
  });

  /**
   * The assignments table stays the single authority on role. A roster row is
   * permission to ASK for a flip, never a record of one — a second copy of the
   * role is a second thing that can disagree with the router.
   */
  describe("kept out of the role decision", () => {
    it("stores no role of its own", () => {
      const db = fresh();
      addRosterEntry(db, PHONE, "my phone");

      const columns = db.prepare(`PRAGMA table_info(test_roster)`).all() as { name: string }[];
      expect(columns.map((c) => c.name)).not.toContain("role");
      db.close();
    });

    it("does not assign a role by existing", () => {
      const db = fresh();
      addRosterEntry(db, PHONE, "my phone");

      expect(listAssignments(db)).toHaveLength(0);
      expect(roleForPhone(db, PHONE)).toBe("customer");
      db.close();
    });
  });

  /**
   * The table is TEMPORARY and removable by deleting rows — which only works if
   * a boot never re-creates or drops it behind an operator's back.
   */
  describe("across a boot", () => {
    it("keeps its rows when the schema is created again", () => {
      const db = fresh();
      const { token } = addRosterEntry(db, PHONE, "my phone");

      createSchema(db);
      createSchema(db);

      expect(findRosterByToken(db, token)?.phone).toBe(PHONE);
      expect(countRosterEntries(db)).toBe(1);
      db.close();
    });

    it("survives a real close and reopen through the whole boot path", () => {
      const dir = mkdtempSync(join(tmpdir(), "vitrina-roster-"));
      const path = join(dir, "vitrina.db");
      try {
        const first = openDb(path);
        const { token } = addRosterEntry(first, PHONE, "my phone");
        first.close();

        const second = openDb(path);
        expect(findRosterByToken(second, token)?.phone).toBe(PHONE);
        second.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
