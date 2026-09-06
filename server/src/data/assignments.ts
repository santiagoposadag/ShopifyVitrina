import { normalizePhone } from "../config.js";
import type { Role } from "../types.js";
import type { DB } from "./db.js";

/**
 * Who is an owner. The role boundary, as a table.
 *
 * This replaces `OWNER_PHONE_NUMBERS` as the AUTHORITY: `router.ts` asks this
 * for every inbound WhatsApp message, and the variable is copied in at boot as
 * a SEED for phones that have no row yet (`seedOwnerAssignments` below). The
 * distinction is the whole design, and it is stated once here:
 *
 *   A SEED IS NOT A SYNC. Nothing in this module ever deletes or overwrites a
 *   row because the variable no longer names it. Removing a phone from
 *   `OWNER_PHONE_NUMBERS` does NOT revoke it — revoking is `assignRole(...,
 *   "customer")` or `unassignPhone`, through the ops entry point
 *   (data/role-assignments.ts).
 *
 * The alternative — reconciling the table to the variable on every boot — was
 * rejected because of how the variable actually goes missing. `loadDotEnv`
 * swallows an absent .env (see config.ts), and every `npm run … -w server` runs
 * from a directory where a relative path misses; the observed failure mode of
 * that is an EMPTY allowlist, not a wrong one. A sync would then delete every
 * owner row on a restart, and the owner of the store would silently read as a
 * customer with nothing in the logs but a successful boot. The cost of the
 * choice made instead is real and is stated where an operator meets it: a phone
 * that was briefly an owner keeps that role until someone takes it away on
 * purpose, and the boot log names every disagreement between the two.
 *
 * NOTHING HERE READS A ROLE OUT OF A MESSAGE. The lookup key is the phone the
 * transport authenticated (inbox/webhook.ts), never anything a person wrote.
 */

/** One row: a phone and the role it was assigned, as an operator left it. */
export interface Assignment {
  phone: string;
  role: Role;
  created_at: string;
}

/** What one boot's seeding did, for the boot log. */
export interface SeedReport {
  /** Phones the variable named that had no row, now owners. */
  inserted: string[];
  /** Phones the variable named that were already owners. Nothing was written. */
  unchanged: string[];
  /**
   * Phones the variable names as owners that the TABLE records differently.
   * The table wins (a seed is not a sync), so this is the disagreement an
   * operator has to see: the variable is saying something no longer true.
   */
  disagreed: { phone: string; role: Role }[];
}

/**
 * The one normalisation, applied on the way in and on the way out.
 *
 * `normalizePhone` is config.ts's, deliberately reused rather than reimplemented
 * here: the webhook's phone goes through it, `isOwner` went through it, and two
 * spellings of "the same number" would mean an owner who wrote a '+' silently
 * reading as a customer forever.
 */
function key(phone: string): string {
  return normalizePhone(phone);
}

/**
 * The role this phone is assigned, or "customer" when it has no row.
 *
 * A MISSING ROW IS A CUSTOMER — the safe default and the behaviour an empty
 * allowlist already had. Never an error: a role lookup that can throw is a role
 * lookup that takes the pipeline down for an unknown number.
 *
 * An unrecognised role reads as "customer" as well. The CHECK constraint keeps
 * our own writes to the two roles this build serves, so what is left is a
 * hand-edited database — where guessing UP hands somebody the store.
 */
export function roleForPhone(db: DB, phone: string): Role {
  const row = db.prepare(`SELECT role FROM assignments WHERE phone = ?`).get(key(phone)) as
    | { role: string }
    | undefined;
  return row?.role === "owner" ? "owner" : "customer";
}

/**
 * Create or change one phone's assignment. The ops entry point's write.
 *
 * Takes effect on the next message with no restart, exactly like the agent
 * registry: the router reads this table per message rather than caching it, so
 * "who is an owner" is never a question about when the process last booted.
 */
export function assignRole(db: DB, phone: string, role: Role): void {
  const phoneKey = key(phone);
  // A phone that normalises to nothing would be a row that matches every input
  // normalising to nothing — an owner row keyed on the empty string. Refuse it
  // here rather than let one exist.
  if (phoneKey.length === 0) {
    throw new Error(`"${phone}" contains no digits; an assignment needs a phone number`);
  }
  db.prepare(
    `INSERT INTO assignments (phone, role) VALUES (@phone, @role)
     ON CONFLICT(phone) DO UPDATE SET role = excluded.role`,
  ).run({ phone: phoneKey, role });
}

/** Remove one phone's assignment; it reads as a customer again. */
export function unassignPhone(db: DB, phone: string): boolean {
  return db.prepare(`DELETE FROM assignments WHERE phone = ?`).run(key(phone)).changes > 0;
}

/** Every assignment, for the ops tool. Ordered so two runs read the same. */
export function listAssignments(db: DB): Assignment[] {
  return db
    .prepare(`SELECT phone, role, created_at FROM assignments ORDER BY role, phone`)
    .all() as Assignment[];
}

/** The phones holding one role — the owners, for a broadcast or a guard. */
export function listPhonesWithRole(db: DB, role: Role): string[] {
  const rows = db
    .prepare(`SELECT phone FROM assignments WHERE role = ? ORDER BY phone`)
    .all(role) as { phone: string }[];
  return rows.map((row) => row.phone);
}

/**
 * How many owners this database knows. Zero means the deployment cannot tell an
 * owner from a customer, which is what the purge tool refuses to act on.
 */
export function countAssignedOwners(db: DB): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM assignments WHERE role = 'owner'`).get() as {
    n: number;
  };
  return row.n;
}

/**
 * Copy `OWNER_PHONE_NUMBERS` into the table, for phones that have no row yet.
 *
 * INSERT-IF-ABSENT, and nothing else. It never updates, never deletes, and
 * never re-promotes: a phone the table records as a customer STAYS a customer
 * even while the variable still names it, which is what makes a demotion made
 * through the ops tool survive the next restart. See the module comment for why
 * the reverse (reconciling to the variable) is not what happens.
 *
 * IDEMPOTENT, because it runs on every boot: the second call writes nothing and
 * reports nothing inserted. `created_at` is not touched either, so a restart
 * does not rewrite when an assignment was made.
 *
 * ONE IMMEDIATE TRANSACTION. The read that builds the report and the writes it
 * describes have to see one state, and taking the write lock up front is what
 * makes two processes booting against the same file (a redeploy overlapping its
 * predecessor) queue rather than collide mid-upgrade — the same reasoning as
 * migrateSessionsKey in db.ts. The insert is conflict-tolerant regardless, so
 * the loser writes nothing rather than failing.
 */
export function seedOwnerAssignments(db: DB, phones: Iterable<string>): SeedReport {
  // Sorted and de-duplicated: the report goes into the boot log, and a log line
  // whose order depends on how someone happened to comma-separate a variable is
  // a log line nobody can diff between two boots.
  const wanted = [...new Set([...phones].map(key).filter((p) => p.length > 0))].sort();
  const report: SeedReport = { inserted: [], unchanged: [], disagreed: [] };
  if (wanted.length === 0) return report;

  const seed = db.transaction(() => {
    const existing = db.prepare(`SELECT phone, role FROM assignments WHERE phone = ?`);
    const insert = db.prepare(
      `INSERT INTO assignments (phone, role) VALUES (?, 'owner') ON CONFLICT(phone) DO NOTHING`,
    );
    for (const phone of wanted) {
      const row = existing.get(phone) as { phone: string; role: Role } | undefined;
      if (row === undefined) {
        insert.run(phone);
        report.inserted.push(phone);
      } else if (row.role === "owner") {
        report.unchanged.push(phone);
      } else {
        report.disagreed.push({ phone, role: row.role });
      }
    }
  });
  seed.immediate();
  return report;
}
