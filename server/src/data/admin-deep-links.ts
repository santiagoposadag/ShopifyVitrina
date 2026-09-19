import { timingSafeEqual } from "node:crypto";
import { normalizePhone } from "../config.js";
import { hashAgentToken, mintAgentToken } from "./agent-registry.js";
import { issueAdminSession, type AdminSession } from "./admin-sessions.js";
import type { DB } from "./db.js";

/**
 * ONE-SHOT LINKS THAT LAND SOMEBODY ON ONE CONVERSATION.
 *
 * THE SHAPE IS FORCED BY WHATSAPP TEMPLATES. A template's URL button takes
 * exactly ONE variable and it is appended at the END of a fixed base URL, so
 * `/admin/conversation/<key>?agent=<id>&t=<token>` cannot exist in a template at
 * all. One opaque value has to carry who it was minted for, which conversation
 * to open, and with which persona — which is exactly what a row here is.
 *
 * IT IS ALSO THE SAFER SHAPE, independently of Meta. The session link an owner
 * asks for is NOT single use (see admin-sessions.ts, which says so plainly);
 * this one is. A chat forwarded weeks later carries a code that was spent the
 * first time its owner opened it.
 *
 * THE WINDOW IS LONGER AND SINGLE USE IS WHAT PAYS FOR IT. The "panel" link is
 * minutes because it is requested and opened in one motion. This one arrives
 * unprompted — a lead at 2am read at 8 — so minutes would deliver it dead.
 *
 * NOTHING SERVED OVER HTTP MAY CALL `mintAdminDeepLink`, on the same principle
 * as `issueAdminSession`: a surface that mints its own landing codes is one
 * that extends its own access. The callers are the lead notifier and the ops
 * CLI.
 */

/**
 * How long a landing code stays usable.
 *
 * A DAY, because the notification it rides on is read whenever the person next
 * picks up their phone, and a code that expired overnight is a notification
 * that silently became useless. Bounded anyway, because the alternative — a
 * code that works forever — is the durable credential this whole design
 * refuses to put in a chat.
 */
export const ADMIN_DEEP_LINK_TTL_HOURS = 24;

/** Where a landing code takes somebody, and who it belongs to. */
export interface AdminDeepLink {
  id: number;
  phone: string;
  /** The thread to open. NULL lands on the panel's front page. */
  conversation_key: string | null;
  agent_id: string | null;
  lead_id: number | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  session_id: number | null;
}

interface AdminDeepLinkRow extends AdminDeepLink {
  code_hash: string;
}

const SELECT_ALL = `SELECT id, code_hash, phone, conversation_key, agent_id, lead_id,
                           created_at, expires_at, used_at, session_id
                    FROM admin_deep_links`;

function toLink(row: AdminDeepLinkRow): AdminDeepLink {
  const { code_hash: _ignored, ...link } = row;
  return link;
}

/** A freshly minted landing code. The plaintext exists only here, once. */
export interface MintedDeepLink {
  link: AdminDeepLink;
  /** What goes in the template's `{{1}}`. 43 chars, base64url, URL-safe. */
  code: string;
}

/**
 * Mint a landing code. Returns the plaintext ONCE.
 *
 * The phone goes through `normalizePhone` — the same normalisation
 * `assignments` is keyed by — because the session this eventually mints is
 * attributed to it, and an un-normalised value would attribute an admin's
 * writes to a number no lookup can match.
 */
export function mintAdminDeepLink(
  db: DB,
  input: {
    phone: string;
    conversationKey?: string | null;
    agentId?: string | null;
    leadId?: number | null;
  },
): MintedDeepLink {
  const phone = normalizePhone(input.phone);
  if (phone.length === 0) {
    throw new Error(`"${input.phone}" contains no digits; a deep link needs a phone`);
  }
  // The same mint as every other credential here: 256 bits, base64url, so it
  // survives a URL path with no escaping. Sharing the mint rather than copying
  // four lines is what keeps the three token shapes from drifting apart.
  const code = mintAgentToken();
  const info = db
    .prepare(
      `INSERT INTO admin_deep_links
         (code_hash, phone, conversation_key, agent_id, lead_id, expires_at)
       VALUES (@code_hash, @phone, @conversation_key, @agent_id, @lead_id,
               datetime('now', @ttl))`,
    )
    .run({
      code_hash: hashAgentToken(code),
      phone,
      conversation_key: input.conversationKey ?? null,
      agent_id: input.agentId ?? null,
      lead_id: input.leadId ?? null,
      ttl: `+${ADMIN_DEEP_LINK_TTL_HOURS} hours`,
    });

  const row = db.prepare(`${SELECT_ALL} WHERE id = ?`).get(info.lastInsertRowid) as AdminDeepLinkRow;
  return { link: toLink(row), code };
}

/** What a successful landing produced. */
export interface RedeemedDeepLink {
  link: AdminDeepLink;
  session: AdminSession;
  /** The session's plaintext token, to hand to the page. Never logged, never stored. */
  token: string;
}

/**
 * Spend a landing code: mark it used and mint the session it promised.
 *
 * ONE IMMEDIATE TRANSACTION around the match, the claim and the session, and
 * the write lock is doing real work here rather than being defensive. A
 * WhatsApp link tapped twice in quick succession — the notification opened,
 * then the chat re-opened and tapped again — arrives as two concurrent
 * requests, and without the lock both would find `used_at` NULL and mint two
 * sessions for one code. Single use has to mean one session, or the word means
 * nothing.
 *
 * A SCAN with a constant-time compare per row, not a lookup by hash — the same
 * pattern as every other token in this codebase, and only over LIVE rows, so a
 * spent or expired code can never match at all.
 *
 * Returns null for anything that is not a live code: unknown, expired, already
 * spent. The caller must not distinguish them to the visitor — see the landing
 * page, which says one thing for all three.
 */
export function redeemAdminDeepLink(db: DB, code: string | undefined): RedeemedDeepLink | null {
  if (!code) return null;
  const presented = Buffer.from(hashAgentToken(code), "hex");

  const redeem = db.transaction((): RedeemedDeepLink | null => {
    const rows = db
      .prepare(`${SELECT_ALL} WHERE used_at IS NULL AND expires_at > datetime('now')`)
      .all() as AdminDeepLinkRow[];

    let found: AdminDeepLinkRow | null = null;
    for (const row of rows) {
      const stored = Buffer.from(row.code_hash, "hex");
      // Length-guard first: timingSafeEqual THROWS on a length mismatch, which
      // a truncated or hand-edited code_hash would turn into a 500 on a
      // landing page a customer-facing notification points at.
      if (stored.length !== presented.length) continue;
      // No early return: every row is compared, so the time this takes does not
      // depend on WHERE in the table the matching code sits.
      if (timingSafeEqual(stored, presented)) found = row;
    }
    if (!found) return null;

    const { session, token } = issueAdminSession(db, {
      phone: found.phone,
      issuedVia: "whatsapp",
    });
    db.prepare(
      `UPDATE admin_deep_links SET used_at = datetime('now'), session_id = @session_id
       WHERE id = @id`,
    ).run({ id: found.id, session_id: session.id });

    const link = toLink(
      db.prepare(`${SELECT_ALL} WHERE id = ?`).get(found.id) as AdminDeepLinkRow,
    );
    return { link, session, token };
  });

  return redeem.immediate();
}

/** Landing codes that could still be opened, newest first — for the ops tool. */
export function listLiveAdminDeepLinks(db: DB, limit = 50): AdminDeepLink[] {
  const rows = db
    .prepare(
      `${SELECT_ALL} WHERE used_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as AdminDeepLinkRow[];
  return rows.map(toLink);
}

/**
 * Drop landing codes long past their deadline. Returns the count.
 *
 * NOT ON EXPIRY, on expiry plus a grace period, and for a reason this table has
 * beyond the session one: a spent row is the record that a notification was
 * OPENED, and `session_id` is what connects it to whatever that session then
 * read. Sweeping eagerly would erase the first half of every audit trail.
 */
export function deleteStaleAdminDeepLinks(db: DB, olderThanDays = 30): number {
  return db
    .prepare(`DELETE FROM admin_deep_links WHERE expires_at < datetime('now', ?)`)
    .run(`-${olderThanDays} days`).changes;
}
