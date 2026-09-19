import { timingSafeEqual } from "node:crypto";
import { normalizePhone } from "../config.js";
import { hashAgentToken, mintAgentToken } from "./agent-registry.js";
import type { DB } from "./db.js";

/**
 * ADMIN ACCESS, AS SESSIONS THAT DIE ON THEIR OWN.
 *
 * An admin asks for access from their own WhatsApp and is sent a link. There is
 * no long-lived operator-minted credential anywhere in this design, and that is
 * a decision about the DELIVERY CHANNEL rather than about convenience: a token
 * that travels through a chat lands in a history that is backed up, synced to
 * WhatsApp Web, and readable by whoever holds the phone. A permanent credential
 * delivered that way turns one forwarded message into permanent access to every
 * customer's data. So every token here has a deadline it cannot outlive.
 *
 * WHAT AUTHORISES THE REQUEST IS NOT IN THIS FILE. `assignments` decides who is
 * an owner, and the WhatsApp intercept in `index.ts` is what consults it before
 * calling `issueAdminSession`. Nothing here checks a role, deliberately: this
 * module mints and validates, and a second copy of the owner rule living here
 * is a second thing that can disagree with the router.
 *
 * NOTHING SERVED OVER HTTP MAY CALL `issueAdminSession`. A console that can
 * mint its own session is a console that extends its own access indefinitely,
 * which is precisely what the deadlines exist to prevent. The two callers are
 * the WhatsApp intercept and the break-glass CLI.
 *
 * THE CRYPTO IS IMPORTED, NOT COPIED — `mintAgentToken` and `hashAgentToken`
 * are the durable build's, and duplicating four lines of token construction is
 * how two things drift. The TABLE is separate, which is the containment: a
 * console token must never authenticate at POST /agents/:id/messages, and an
 * agent-door token must never read a conversation.
 */

/**
 * How long an unopened link stays usable.
 *
 * MINUTES, because a link sitting unopened in a chat is the exposure this whole
 * design exists to bound. One from last week has to be dead — that is most of
 * what this buys, and it is worth more than it looks: the realistic leak is not
 * an attacker watching the chat in real time, it is a phone handed to someone,
 * a shared WhatsApp Web session, or a screenshot forwarded months later.
 */
export const ADMIN_CLAIM_TTL_MINUTES = 15;

/**
 * How long a session lasts once the link has been opened.
 *
 * Hours, because by then the person is working in the console, and
 * re-authenticating every few minutes is exactly how someone learns to keep a
 * link lying around — which would undo the paragraph above.
 */
export const ADMIN_SESSION_TTL_HOURS = 12;

export type AdminIssuedVia = "whatsapp" | "cli";

/** One session row, as a listing or an authenticated request sees it. Never a token. */
export interface AdminSession {
  id: number;
  /** Who asked, recorded at issue time. Attribution, never authorisation. */
  phone: string;
  issued_via: AdminIssuedVia;
  created_at: string;
  /** NULL until the link is first opened. Stamped once, never moved. */
  claimed_at: string | null;
  /** The claim deadline before `claimed_at`, the session deadline after. */
  expires_at: string;
  revoked_at: string | null;
}

/** A freshly minted session. The plaintext token exists only here, once. */
export interface MintedAdminSession {
  session: AdminSession;
  token: string;
}

interface AdminSessionRow extends AdminSession {
  token_hash: string;
}

const SELECT_ALL = `SELECT id, token_hash, phone, issued_via, created_at, claimed_at,
                           expires_at, revoked_at
                    FROM admin_sessions`;

function toSession(row: AdminSessionRow): AdminSession {
  const { token_hash: _ignored, ...session } = row;
  return session;
}

/**
 * Mint a session for a phone. Returns the plaintext token ONCE.
 *
 * The phone goes through `normalizePhone` — the same normalisation
 * `assignments` is keyed by and the same one the WhatsApp door produces. A row
 * written '+57 300…' would attribute an admin's writes to a number no lookup
 * can match, and the attribution is the only reason the column exists.
 *
 * A phone that normalises to nothing is refused rather than stored: it would
 * attribute every such session to one empty string. Same guard as
 * `assignments.assignRole`.
 */
export function issueAdminSession(
  db: DB,
  input: { phone: string; issuedVia: AdminIssuedVia },
): MintedAdminSession {
  const phone = normalizePhone(input.phone);
  if (phone.length === 0) {
    throw new Error(`"${input.phone}" contains no digits; an admin session needs a phone`);
  }
  const token = mintAgentToken();
  const info = db
    .prepare(
      `INSERT INTO admin_sessions (token_hash, phone, issued_via, expires_at)
       VALUES (@token_hash, @phone, @issued_via,
               datetime('now', @claim_ttl))`,
    )
    .run({
      token_hash: hashAgentToken(token),
      phone,
      issued_via: input.issuedVia,
      claim_ttl: `+${ADMIN_CLAIM_TTL_MINUTES} minutes`,
    });

  const row = db
    .prepare(`${SELECT_ALL} WHERE id = ?`)
    .get(info.lastInsertRowid) as AdminSessionRow;
  return { session: toSession(row), token };
}

/**
 * The session a bearer token identifies, or null — CLAIMING IT if this is its
 * first use.
 *
 * A READ THAT WRITES, which is unusual enough to justify. The claim has to
 * happen on the first authenticated request because that is the only moment
 * anything observes the link being opened: there is no separate "log in" step,
 * the page simply starts fetching with the token in an Authorization header. A
 * caller that had to claim explicitly would be a caller that could forget to.
 *
 * ONE IMMEDIATE TRANSACTION around the match and the claim. The page fires its
 * first two requests concurrently (the index and its count), so two claims
 * genuinely race on the very first load; without the write lock both would
 * stamp `claimed_at` and the second would push `expires_at` out a second time.
 * Harmless in effect, wrong in the record — and the record is what an operator
 * reads to answer "when was this opened".
 *
 * A SCAN with a constant-time compare per row, not a lookup by hash — the same
 * pattern as agent-registry.findAgentByToken, copied rather than shared so the
 * key spaces stay disjoint. Only LIVE rows are scanned: expired and revoked
 * ones can never match, and excluding them in SQL is what keeps a year of dead
 * tokens from being compared on every page load.
 */
export function authenticateAdminSession(db: DB, token: string | undefined): AdminSession | null {
  if (!token) return null;
  const presented = Buffer.from(hashAgentToken(token), "hex");

  const claim = db.transaction((): AdminSession | null => {
    const rows = db
      .prepare(
        `${SELECT_ALL}
         WHERE revoked_at IS NULL AND expires_at > datetime('now')`,
      )
      .all() as AdminSessionRow[];

    let found: AdminSessionRow | null = null;
    for (const row of rows) {
      const stored = Buffer.from(row.token_hash, "hex");
      // Length-guard first: timingSafeEqual THROWS on a length mismatch, which
      // a truncated or hand-edited token_hash would otherwise turn into a 500
      // that takes the console down for every holder, not just for that row.
      if (stored.length !== presented.length) continue;
      // No early return: every row is compared, so the time this takes does not
      // depend on WHERE in the table the matching session sits.
      if (timingSafeEqual(stored, presented)) found = row;
    }
    if (!found) return null;

    if (found.claimed_at === null) {
      db.prepare(
        `UPDATE admin_sessions
         SET claimed_at = datetime('now'), expires_at = datetime('now', @session_ttl)
         WHERE id = @id AND claimed_at IS NULL`,
      ).run({ id: found.id, session_ttl: `+${ADMIN_SESSION_TTL_HOURS} hours` });
      return toSession(db.prepare(`${SELECT_ALL} WHERE id = ?`).get(found.id) as AdminSessionRow);
    }
    return toSession(found);
  });

  return claim.immediate();
}

/** Revoke one session. It stops working on its next request, with no restart. */
export function revokeAdminSession(db: DB, id: number): boolean {
  return (
    db
      .prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
      .run(id).changes > 0
  );
}

/**
 * Revoke every live session for a phone. Returns how many were revoked.
 *
 * The lever for "this person no longer works here" and for an owner who thinks
 * a link leaked. Removing their `assignments` row stops them asking for a NEW
 * one; it does nothing to the session already issued, because that session is a
 * token and not a role lookup. Both steps are needed and this is the second.
 */
export function revokeAdminSessionsForPhone(db: DB, phone: string): number {
  return db
    .prepare(
      `UPDATE admin_sessions SET revoked_at = datetime('now')
       WHERE phone = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
    )
    .run(normalizePhone(phone)).changes;
}

/** Sessions that could still be used right now. */
export function listLiveAdminSessions(db: DB): AdminSession[] {
  const rows = db
    .prepare(
      `${SELECT_ALL}
       WHERE revoked_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC`,
    )
    .all() as AdminSessionRow[];
  return rows.map(toSession);
}

/** Every session, live or not, newest first — for the ops tool's audit view. */
export function listAdminSessions(db: DB, limit = 50): AdminSession[] {
  const rows = db
    .prepare(`${SELECT_ALL} ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AdminSessionRow[];
  return rows.map(toSession);
}

/** How many sessions could be used right now. Zero means the console is closed. */
export function countLiveAdminSessions(db: DB): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM admin_sessions
       WHERE revoked_at IS NULL AND expires_at > datetime('now')`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Drop sessions that died long enough ago to be uninteresting. Returns the
 * count.
 *
 * NOT ON EXPIRY, on expiry PLUS a grace period, because a dead session is still
 * an audit record: "who had access yesterday" is answerable only while the row
 * exists, and an admin write to a conversation names the session that made it.
 * Swept eventually rather than never, so the table does not grow without bound
 * on a deployment that asks for a link several times a day.
 */
export function deleteStaleAdminSessions(db: DB, olderThanDays = 30): number {
  return db
    .prepare(`DELETE FROM admin_sessions WHERE expires_at < datetime('now', ?)`)
    .run(`-${olderThanDays} days`).changes;
}
