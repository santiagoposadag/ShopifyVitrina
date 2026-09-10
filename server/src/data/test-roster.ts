import { timingSafeEqual } from "node:crypto";
import { normalizePhone } from "../config.js";
import { hashAgentToken, mintAgentToken } from "./agent-registry.js";
import type { DB } from "./db.js";

/**
 * TEMPORARY. Who may flip their OWN role from the test console.
 *
 * The store owner has to experience both sides of the assistant from their own
 * phone, and a role currently changes only from a terminal. This table is the
 * small, deletable thing that lets a handful of pre-registered test phones do
 * it themselves.
 *
 * REMOVING THE FEATURE IS DELETING FILES AND ROWS: this module, its test, the
 * console routes, and the `test_roster` block in db.ts. THE DEPENDENCY RUNS ONE
 * WAY — this module imports from `agent-registry.ts` and `config.ts`, and
 * nothing durable imports this. `agent-registry.ts` does not know it exists.
 *
 * ONE TOKEN, ONE PHONE. `findRosterByToken` returns exactly one entry and that
 * entry carries the phone, which is what lets the console have NO phone
 * parameter anywhere in its surface. Containment is then not a check somebody
 * could write wrong — there is no field to smuggle another number into.
 *
 * WHAT IS DELIBERATELY NOT HERE: no role (the `assignments` table stays the
 * single authority — a second copy is a second thing that can disagree with the
 * router), no plaintext token, no expiry, and no second enabling flag. The row
 * IS the credential: deleting it revokes on the next request with no restart,
 * and an empty table means the feature is dead.
 *
 * WHO MAY REGISTER A TEST PHONE IS NOT DECIDED YET, and nothing here decides
 * it: these functions carry no authorisation of their own, and the intended
 * caller is an operator-run entry point that already has the database open.
 * NOTHING SERVED OVER HTTP MAY CALL addRosterEntry OR rotateRosterToken —
 * a console that could enrol a phone is a console that grants itself reach,
 * which is exactly what the no-phone-parameter shape exists to prevent. There
 * is also no cap on how many phones may be registered, deliberately: that is a
 * business rule nobody has written, and a number picked here would BE it.
 *
 * THE CRYPTO IS IMPORTED, NOT COPIED. `mintAgentToken` and `hashAgentToken` are
 * the durable build's; four duplicated lines of a token construction is how two
 * things drift. The TABLE is separate though, and that is the point of the
 * separation: a console token must never authenticate at
 * POST /agents/:id/messages, and an agent-door token must never be able to flip
 * a role. Two tables, two key spaces.
 */

/** One roster row, as an operator left it. Never a token. */
export interface RosterEntry {
  /** normalizePhone's output — the same key space as `assignments`. */
  phone: string;
  /**
   * Operator-typed, so someone holding two phones can tell which link is
   * which. UNTRUSTED INPUT: the console renders it with `textContent` and must
   * never interpolate it into HTML.
   */
  label: string;
  created_at: string;
  rotated_at: string | null;
}

/** A freshly written credential. The plaintext token exists only here, once. */
export interface MintedRosterCredential {
  phone: string;
  token: string;
}

/**
 * The one normalisation, applied on the way in.
 *
 * `normalizePhone` is config.ts's — the same one `assignments.ts` keys by and
 * the same one the WhatsApp door's phone goes through. A roster row written as
 * `+57 300…` would never match the assignment keyed `57300…`, and the console
 * would flip a role nobody has while reporting success.
 */
function key(phone: string): string {
  const phoneKey = normalizePhone(phone);
  // A phone that normalises to nothing would be a credential keyed on the empty
  // string, matching every other input that also normalises to nothing. Refuse
  // it here rather than let one exist (same guard as assignments.assignRole).
  if (phoneKey.length === 0) {
    throw new Error(`"${phone}" contains no digits; a roster entry needs a phone number`);
  }
  return phoneKey;
}

interface RosterRow {
  phone: string;
  token_hash: string;
  label: string;
  created_at: string;
  rotated_at: string | null;
}

function toEntry(row: RosterRow): RosterEntry {
  return {
    phone: row.phone,
    label: row.label,
    created_at: row.created_at,
    rotated_at: row.rotated_at,
  };
}

const SELECT_ALL = `SELECT phone, token_hash, label, created_at, rotated_at FROM test_roster`;

/**
 * Register a test phone and mint its token. Returns the plaintext ONCE.
 *
 * NEVER OVERWRITES — the same distinction data/agent-credentials.ts draws
 * between `add` and `rotate`, for the same reason: an upsert here would
 * silently invalidate a live link and its holder would start getting 401s with
 * nothing connecting the two events. Replacing a token is `rotateRosterToken`,
 * and it has to be asked for.
 *
 * ONE IMMEDIATE TRANSACTION. The "does this phone already have one" read and
 * the insert it guards have to see one state: two operators registering the
 * same phone from two processes would otherwise interleave between the check
 * and the write, and the loser would replace a credential it had just been told
 * did not exist. Taking the write lock up front makes them queue (the same
 * reasoning as seedOwnerAssignments and migrateSessionsKey). The PRIMARY KEY is
 * the backstop underneath, so the worst case is a thrown constraint rather than
 * a silent replacement.
 */
export function addRosterEntry(db: DB, phone: string, label: string): MintedRosterCredential {
  const phoneKey = key(phone);
  const write = db.transaction((): MintedRosterCredential => {
    const existing = db.prepare(`SELECT phone FROM test_roster WHERE phone = ?`).get(phoneKey);
    if (existing !== undefined) {
      throw new Error(
        `"${phoneKey}" already has a console credential. Rotate it to replace the token, ` +
          "or remove it first.",
      );
    }
    const token = mintAgentToken();
    db.prepare(
      `INSERT INTO test_roster (phone, token_hash, label) VALUES (@phone, @token_hash, @label)`,
    ).run({ phone: phoneKey, token_hash: hashAgentToken(token), label: label.trim() });
    return { phone: phoneKey, token };
  });
  return write.immediate();
}

/**
 * Replace one phone's token. The previous one stops working with this write,
 * with no overlap window — the caller must be handed the new link in the same
 * step.
 *
 * THE LABEL IS CARRIED OVER because rotation is about the secret. A rotate that
 * blanked it would look like it worked and leave an operator unable to tell two
 * links apart.
 */
export function rotateRosterToken(db: DB, phone: string): MintedRosterCredential {
  const phoneKey = key(phone);
  const write = db.transaction((): MintedRosterCredential => {
    const token = mintAgentToken();
    const changed = db
      .prepare(
        `UPDATE test_roster SET token_hash = @token_hash, rotated_at = datetime('now')
         WHERE phone = @phone`,
      )
      .run({ phone: phoneKey, token_hash: hashAgentToken(token) }).changes;
    if (changed === 0) {
      throw new Error(`no credential for "${phoneKey}"; add one before rotating it`);
    }
    return { phone: phoneKey, token };
  });
  return write.immediate();
}

/** Revoke a test phone's access. It takes effect on that link's next request. */
export function deleteRosterEntry(db: DB, phone: string): boolean {
  return db.prepare(`DELETE FROM test_roster WHERE phone = ?`).run(key(phone)).changes > 0;
}

/**
 * The test phone a bearer token identifies, or null.
 *
 * THE PHONE COMES FROM HERE AND NOWHERE ELSE. The console has no phone
 * parameter; whatever this returns is whose role may be flipped.
 *
 * A SCAN with a constant-time compare per row, not a lookup by hash — the same
 * pattern as agent-registry.findAgentByToken, deliberately copied rather than
 * shared, so the two key spaces stay disjoint. The roster holds a handful of
 * rows, and this keeps the answer identical — one refusal, no detail — whether
 * the token is unknown, malformed or absent.
 *
 * The comparison is over the HASHES. Comparing plaintext would mean holding
 * one, and a `===` on a secret leaks its prefix through timing.
 */
export function findRosterByToken(db: DB, token: string | undefined): RosterEntry | null {
  if (!token) return null;
  const presented = Buffer.from(hashAgentToken(token), "hex");
  const rows = db.prepare(SELECT_ALL).all() as RosterRow[];

  let found: RosterRow | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.token_hash, "hex");
    // Length-guard first: timingSafeEqual THROWS on a length mismatch, which a
    // truncated or hand-edited token_hash would otherwise turn into a 500 that
    // takes the console down for every holder, not just for that row.
    if (stored.length !== presented.length) continue;
    // No early return: every row is compared, so the time this takes does not
    // depend on WHERE in the table the matching credential sits.
    if (timingSafeEqual(stored, presented)) found = row;
  }
  return found ? toEntry(found) : null;
}

/** Every registered test phone, for the ops tool. Ordered so two runs read the same. */
export function listRosterEntries(db: DB): RosterEntry[] {
  const rows = db.prepare(`${SELECT_ALL} ORDER BY phone`).all() as RosterRow[];
  return rows.map(toEntry);
}

/** How many test phones exist. Zero means the console authenticates nobody. */
export function countRosterEntries(db: DB): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM test_roster`).get() as { n: number };
  return row.n;
}
