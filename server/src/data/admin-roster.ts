import { timingSafeEqual } from "node:crypto";
import { hashAgentToken, mintAgentToken } from "./agent-registry.js";
import type { DB } from "./db.js";

/**
 * WHO MAY READ EVERY CONVERSATION IN THIS DEPLOYMENT.
 *
 * The admin console (admin/console.ts) authenticates by looking a presented
 * token up in here. An empty table matches nothing and the console answers 404
 * on every path, so the surface is shipped CLOSED and there is no second
 * enabling flag — same "off by default" story as agent_registry, and for the
 * same reason: two switches for one thing is how one ends up in the wrong
 * position.
 *
 * A THIRD CREDENTIAL TABLE, AND THE SEPARATION IS THE CONTAINMENT. This must
 * never be merged with `test_roster`. That roster's entire shape is one token →
 * one phone, which is what lets the test console have no phone parameter
 * anywhere in its surface; an admin credential reads EVERYONE by definition.
 * Sharing one table would silently turn every test link into a reader of every
 * customer's conversation, and nothing in either console's code would show it.
 * It must never be merged with `agent_registry` either — a console token that
 * authenticated at POST /agents/:id/messages could speak AS an agent. Three
 * tables, three key spaces, none a superset of another.
 *
 * KEYED BY AN OPERATOR-CHOSEN NAME, NOT A PHONE. An admin is not a WhatsApp
 * principal: they never receive a message and no role is ever resolved for
 * them. A phone primary key would invite the question "is this admin an owner?"
 * — which nothing answers and nothing should, because the answer would be a
 * second authority competing with the `assignments` table.
 *
 * WHAT A TOKEN HERE GRANTS IS READ-ONLY, AND THE CONSOLE IS WHAT ENFORCES IT:
 * the admin surface has no write route at all. Nothing in this module can flip
 * a role, reprice a product or delete a conversation, and nothing here may ever
 * gain such a function — the credential's whole value is that its blast radius
 * is "saw things", not "changed things".
 *
 * NOTHING SERVED OVER HTTP MAY CALL addAdminEntry OR rotateAdminToken. A
 * console that can enrol a reader is a console that grants itself reach.
 * Enrolment is the operator's CLI only (data/admin-credentials.ts).
 *
 * THE CRYPTO IS IMPORTED, NOT COPIED, exactly as test-roster.ts does it:
 * duplicating four lines of token construction is how two things drift apart.
 * Only the TABLE is separate, which is the whole point.
 */

/** One admin row, as an operator left it. Never a token. */
export interface AdminEntry {
  /** The operator-chosen identifier. Lowercased and trimmed — see `key`. */
  name: string;
  /**
   * Operator-typed, so two links can be told apart. UNTRUSTED INPUT: the
   * console renders it with `textContent` and must never interpolate it into
   * HTML.
   */
  label: string;
  created_at: string;
  rotated_at: string | null;
}

/** A freshly written credential. The plaintext token exists only here, once. */
export interface MintedAdminCredential {
  name: string;
  token: string;
}

/**
 * The one normalisation, applied on the way in.
 *
 * Lowercased and trimmed so "Santiago" and "santiago " are one admin rather
 * than two rows an operator believes are one — the same class of mistake
 * normalizePhone prevents for a phone, and the reason a rotate must be able to
 * find the row an add wrote.
 *
 * The character set is restricted so a name is safe to print in a terminal
 * listing and to use in a log line without quoting. It is NOT a security
 * boundary — the console never interpolates it into HTML either — it is about
 * an identifier staying an identifier.
 */
function key(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error("an admin credential needs a name, so two links can be told apart");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    throw new Error(
      `"${name}" is not a usable admin name: use letters, digits, dot, dash or underscore, ` +
        "starting with a letter or digit",
    );
  }
  return trimmed;
}

interface AdminRow {
  name: string;
  token_hash: string;
  label: string;
  created_at: string;
  rotated_at: string | null;
}

function toEntry(row: AdminRow): AdminEntry {
  return {
    name: row.name,
    label: row.label,
    created_at: row.created_at,
    rotated_at: row.rotated_at,
  };
}

const SELECT_ALL = `SELECT name, token_hash, label, created_at, rotated_at FROM admin_roster`;

/**
 * Enrol an admin and mint their token. Returns the plaintext ONCE.
 *
 * NEVER OVERWRITES — the same distinction agent-credentials.ts and
 * test-roster.ts draw between `add` and `rotate`, for the same reason: an
 * upsert here would silently invalidate a live link and its holder would start
 * getting 401s with nothing connecting the two events.
 *
 * ONE IMMEDIATE TRANSACTION around the "does this name exist" read and the
 * insert it guards, so two operators enrolling the same name from two processes
 * queue rather than interleave — the loser would otherwise replace a credential
 * it had just been told did not exist. The PRIMARY KEY is the backstop
 * underneath, so the worst case is a thrown constraint, not a silent
 * replacement.
 */
export function addAdminEntry(db: DB, name: string, label: string): MintedAdminCredential {
  const nameKey = key(name);
  const write = db.transaction((): MintedAdminCredential => {
    const existing = db.prepare(`SELECT name FROM admin_roster WHERE name = ?`).get(nameKey);
    if (existing !== undefined) {
      throw new Error(
        `"${nameKey}" already has an admin credential. Rotate it to replace the token, ` +
          "or remove it first.",
      );
    }
    const token = mintAgentToken();
    db.prepare(
      `INSERT INTO admin_roster (name, token_hash, label) VALUES (@name, @token_hash, @label)`,
    ).run({ name: nameKey, token_hash: hashAgentToken(token), label: label.trim() });
    return { name: nameKey, token };
  });
  return write.immediate();
}

/**
 * Replace one admin's token. The previous one stops working with this write,
 * with no overlap window — the holder must be handed the new link in the same
 * step.
 *
 * THE LABEL IS CARRIED OVER because rotation is about the secret. A rotate that
 * blanked it would look like it worked and leave an operator unable to tell two
 * links apart.
 */
export function rotateAdminToken(db: DB, name: string): MintedAdminCredential {
  const nameKey = key(name);
  const write = db.transaction((): MintedAdminCredential => {
    const token = mintAgentToken();
    const changed = db
      .prepare(
        `UPDATE admin_roster SET token_hash = @token_hash, rotated_at = datetime('now')
         WHERE name = @name`,
      )
      .run({ name: nameKey, token_hash: hashAgentToken(token) }).changes;
    if (changed === 0) {
      throw new Error(`no admin credential for "${nameKey}"; add one before rotating it`);
    }
    return { name: nameKey, token };
  });
  return write.immediate();
}

/** Revoke an admin's access. It takes effect on that link's next request. */
export function deleteAdminEntry(db: DB, name: string): boolean {
  return db.prepare(`DELETE FROM admin_roster WHERE name = ?`).run(key(name)).changes > 0;
}

/**
 * The admin a bearer token identifies, or null.
 *
 * A SCAN with a constant-time compare per row, not a lookup by hash — the same
 * pattern as agent-registry.findAgentByToken and test-roster.findRosterByToken,
 * deliberately copied rather than shared so the three key spaces stay disjoint.
 * The roster holds a handful of rows, and this keeps the answer identical — one
 * refusal, no detail — whether the token is unknown, malformed or absent.
 *
 * The comparison is over the HASHES. Comparing plaintext would mean holding
 * one, and a `===` on a secret leaks its prefix through timing.
 */
export function findAdminByToken(db: DB, token: string | undefined): AdminEntry | null {
  if (!token) return null;
  const presented = Buffer.from(hashAgentToken(token), "hex");
  const rows = db.prepare(SELECT_ALL).all() as AdminRow[];

  let found: AdminRow | null = null;
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

/** Every enrolled admin, for the ops tool. Ordered so two runs read the same. */
export function listAdminEntries(db: DB): AdminEntry[] {
  const rows = db.prepare(`${SELECT_ALL} ORDER BY name`).all() as AdminRow[];
  return rows.map(toEntry);
}

/** How many admins exist. Zero means the console authenticates nobody. */
export function countAdminEntries(db: DB): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM admin_roster`).get() as { n: number };
  return row.n;
}
