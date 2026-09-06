import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchema, openDb, type DB } from "../src/data/db.js";
import {
  assignRole,
  countAssignedOwners,
  listAssignments,
  roleForPhone,
  seedOwnerAssignments,
  unassignPhone,
} from "../src/data/assignments.js";

const OWNER = "573001110000";
const CUSTOMER = "573002220000";

/**
 * A WhatsApp LID is not a phone number, and its digits look exactly like one to
 * normalizePhone (see CLAUDE.md). This one deliberately CONTAINS the owner's
 * digits as a prefix: a lookup that matched loosely would hand the store to a
 * stranger, and nothing downstream would report it.
 */
const LID_DIGITS = `${OWNER}4455`;

function fresh(): DB {
  return openDb(":memory:");
}

describe("the assignments table", () => {
  // IF NOT EXISTS is the whole migration for a table that did not exist before,
  // but only if a second run leaves the rows alone. A boot that re-created it
  // would revoke every assignment an operator ever made, silently.
  it("keeps existing rows when the schema is created again", () => {
    const db = fresh();
    assignRole(db, OWNER, "owner");

    createSchema(db);
    createSchema(db);

    expect(roleForPhone(db, OWNER)).toBe("owner");
    expect(listAssignments(db)).toHaveLength(1);
    db.close();
  });

  // The same question against a real file, through the whole boot path — openDb
  // runs createSchema AND migrate(), and a migration step that rebuilt or
  // dropped this table would be invisible to an in-memory check that never
  // closes the database.
  it("survives a real close and reopen, with its rows and its timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "vitrina-assignments-"));
    const path = join(dir, "vitrina.db");
    try {
      const first = openDb(path);
      assignRole(first, OWNER, "owner");
      assignRole(first, CUSTOMER, "customer");
      const before = listAssignments(first);
      first.close();

      const second = openDb(path);
      expect(listAssignments(second)).toEqual(before);
      expect(roleForPhone(second, OWNER)).toBe("owner");
      second.close();

      const third = openDb(path);
      expect(listAssignments(third)).toEqual(before);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Two roles, because two roles are what this build serves. A third one would
  // be dead configuration that reads, to whoever writes it, like a privilege.
  it("refuses a role nothing serves", () => {
    const db = fresh();
    const insert = db.prepare(`INSERT INTO assignments (phone, role) VALUES (?, ?)`);
    expect(() => insert.run(OWNER, "admin")).toThrow();
    db.close();
  });

  it("records when an assignment was made", () => {
    const db = fresh();
    assignRole(db, OWNER, "owner");
    expect(listAssignments(db)[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    db.close();
  });
});

describe("roleForPhone", () => {
  // The safe default and today's behaviour: nobody is an owner until a row says
  // so. A missing row is an answer, never an error.
  it("reads a phone with no row as a customer", () => {
    const db = fresh();
    expect(roleForPhone(db, OWNER)).toBe("customer");
    db.close();
  });

  it("reads a phone with an owner row as an owner", () => {
    const db = fresh();
    assignRole(db, OWNER, "owner");
    expect(roleForPhone(db, OWNER)).toBe("owner");
    db.close();
  });

  // One axis away from the case above: the same phone, the same table, a
  // different role. An explicit customer row is how an owner is demoted in a
  // way that survives the next boot's seed.
  it("reads a phone with a customer row as a customer", () => {
    const db = fresh();
    assignRole(db, CUSTOMER, "customer");
    expect(roleForPhone(db, CUSTOMER)).toBe("customer");
    db.close();
  });

  // ONE normalisation, config.normalizePhone, applied on the way in and on the
  // way out. Two would mean an owner who typed a '+' silently reads as a
  // customer for the rest of the deployment's life.
  it("matches however the number was written down", () => {
    const db = fresh();
    assignRole(db, "+57 300-111 0000", "owner");
    expect(roleForPhone(db, OWNER)).toBe("owner");
    expect(roleForPhone(db, "+57 (300) 111 0000")).toBe("owner");
    db.close();
  });

  // A LID reaching this far is already a bug upstream (bridge/inbound.go drops
  // them), but the lookup must be exact regardless: no prefix, no suffix, no
  // "contains". This LID starts with the owner's own digits.
  it("does not let a LID-shaped id inherit an owner's digits", () => {
    const db = fresh();
    assignRole(db, OWNER, "owner");
    expect(roleForPhone(db, LID_DIGITS)).toBe("customer");
    expect(roleForPhone(db, OWNER.slice(0, 8))).toBe("customer");
    db.close();
  });

  // Fail CLOSED. The CHECK constraint stops this being written through our own
  // code; a hand-edited database is the case that is left, and the wrong guess
  // there is the one that grants the store.
  it("reads an unrecognised role as a customer rather than guessing", () => {
    const db = fresh();
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`INSERT INTO assignments (phone, role) VALUES (?, ?)`).run(OWNER, "admin");
    expect(roleForPhone(db, OWNER)).toBe("customer");
    db.close();
  });
});

describe("assignRole and unassignPhone", () => {
  it("promotes and demotes the same phone", () => {
    const db = fresh();
    assignRole(db, CUSTOMER, "owner");
    expect(roleForPhone(db, CUSTOMER)).toBe("owner");
    assignRole(db, CUSTOMER, "customer");
    expect(roleForPhone(db, CUSTOMER)).toBe("customer");
    expect(listAssignments(db)).toHaveLength(1); // one row, not two
    db.close();
  });

  it("removes a row and reports whether there was one", () => {
    const db = fresh();
    assignRole(db, OWNER, "owner");
    expect(unassignPhone(db, OWNER)).toBe(true);
    expect(unassignPhone(db, OWNER)).toBe(false);
    expect(roleForPhone(db, OWNER)).toBe("customer");
    db.close();
  });

  it("counts the owners, which is what 'can this deployment tell them apart' means", () => {
    const db = fresh();
    expect(countAssignedOwners(db)).toBe(0);
    assignRole(db, OWNER, "owner");
    assignRole(db, CUSTOMER, "customer");
    expect(countAssignedOwners(db)).toBe(1);
    db.close();
  });
});

describe("seedOwnerAssignments", () => {
  // The contract Phase 6 promises: a deployment that sets OWNER_PHONE_NUMBERS
  // and knows nothing about this table keeps working with no operator action.
  it("turns the variable into owner rows", () => {
    const db = fresh();
    const report = seedOwnerAssignments(db, new Set([OWNER]));

    expect(roleForPhone(db, OWNER)).toBe("owner");
    expect(report.inserted).toEqual([OWNER]);
    db.close();
  });

  it("normalises what it seeds, the same way a lookup does", () => {
    const db = fresh();
    seedOwnerAssignments(db, new Set(["+57 300 111 0000"]));
    expect(roleForPhone(db, OWNER)).toBe("owner");
    db.close();
  });

  // Every boot runs this. A second run that re-inserted, updated a timestamp or
  // replaced a role would make a restart a privilege event.
  it("is idempotent across repeated boots", () => {
    const db = fresh();
    seedOwnerAssignments(db, new Set([OWNER]));
    const before = listAssignments(db);

    const second = seedOwnerAssignments(db, new Set([OWNER]));
    const third = seedOwnerAssignments(db, new Set([OWNER]));

    expect(second.inserted).toEqual([]);
    expect(second.unchanged).toEqual([OWNER]);
    expect(third.inserted).toEqual([]);
    expect(listAssignments(db)).toEqual(before);
    db.close();
  });

  // A SEED IS NOT A SYNC. Removing a phone from the variable does NOT revoke
  // it, deliberately: the alternative makes an empty or unread .env — which
  // loadDotEnv swallows silently — revoke the owner of the store.
  it("never deletes a row for a phone that left the variable", () => {
    const db = fresh();
    assignRole(db, OWNER, "owner");

    const report = seedOwnerAssignments(db, new Set());

    expect(roleForPhone(db, OWNER)).toBe("owner");
    expect(report.inserted).toEqual([]);
    db.close();
  });

  // The other half of the same rule: the TABLE wins over the variable, so a
  // demotion made through the ops tool is not undone by the next restart. It is
  // reported, because a variable and a table that disagree is worth a line in
  // the boot log rather than a silent preference.
  it("does not re-promote a phone the table demoted, and says so", () => {
    const db = fresh();
    assignRole(db, OWNER, "customer");

    const report = seedOwnerAssignments(db, new Set([OWNER]));

    expect(roleForPhone(db, OWNER)).toBe("customer");
    expect(report.inserted).toEqual([]);
    expect(report.disagreed).toEqual([{ phone: OWNER, role: "customer" }]);
    db.close();
  });

  it("seeds only what is missing when the variable grows", () => {
    const db = fresh();
    seedOwnerAssignments(db, new Set([OWNER]));

    const report = seedOwnerAssignments(db, new Set([OWNER, CUSTOMER]));

    expect(report.inserted).toEqual([CUSTOMER]);
    expect(report.unchanged).toEqual([OWNER]);
    expect(roleForPhone(db, CUSTOMER)).toBe("owner");
    db.close();
  });

  // An empty variable is the accident loadDotEnv makes routine. It must be a
  // no-op, not a revocation.
  it("writes nothing at all for an empty variable", () => {
    const db = fresh();
    const report = seedOwnerAssignments(db, new Set());
    expect(listAssignments(db)).toEqual([]);
    expect(report).toEqual({ inserted: [], unchanged: [], disagreed: [] });
    db.close();
  });

  // Two processes booting against one database file (a redeploy overlapping its
  // predecessor) run this concurrently. Insert-if-absent makes the loser's
  // write a no-op instead of an error or a duplicate.
  it("leaves the same rows whichever order two boots interleave in", () => {
    const db = fresh();
    seedOwnerAssignments(db, new Set([OWNER, CUSTOMER]));
    seedOwnerAssignments(db, new Set([CUSTOMER, OWNER]));

    expect(listAssignments(db).map((a) => a.phone).sort()).toEqual([OWNER, CUSTOMER].sort());
    db.close();
  });
});
