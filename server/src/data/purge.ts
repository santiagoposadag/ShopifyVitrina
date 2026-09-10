import type { Config } from "../config.js";
import { isOwner } from "../config.js";
import { isAgentConversationKey } from "../inbox/envelope.js";
import { countAssignedOwners, roleForPhone } from "./assignments.js";
import type { DB } from "./db.js";
import { clearSessionId, deleteConversationMessages, listSessions } from "./repo.js";
import { deleteTranscript, sweepOrphanedTranscripts } from "./transcripts.js";

/**
 * Only what the purge actually reads — so the ops tool can run without
 * loadConfig's required secrets: deleting a session should not depend on a
 * WhatsApp credential being present.
 * The full Config satisfies this structurally.
 */
export type PurgeConfig = Pick<Config, "ownerPhoneNumbers" | "sessionMaxAgeDays">;

export interface PurgeResult {
  /** Customer sessions dropped. */
  purged: number;
  /** Owner sessions deliberately left alone. */
  kept: number;
  /** Agent-to-agent exchanges left alone. Reported, never silently skipped. */
  keptAgent: number;
  /**
   * Durable `conversation_messages` rows deleted for purged customers — both
   * directions, summed across every session purged this run. See the loop
   * below: this is the count that makes "purged" mean what it says, since the
   * session row alone is not where a customer's words live.
   */
  purgedMessages: number;
  /** Orphaned transcripts collected, or null when no root was configured. */
  swept: number | null;
}

/**
 * Drop every CUSTOMER conversation history — the session rows, the durable
 * `conversation_messages` behind them, and the transcripts behind THOSE —
 * then sweep orphans left by earlier resets.
 *
 * OWNER SESSIONS ARE PRESERVED: an owner mid-listing has a session that
 * upsert_product's merge semantics depend on, and dropping it loses in-progress
 * work. Role comes from the `assignments` table — what the ROUTER reads — plus
 * OWNER_PHONE_NUMBERS, and never from the contacts table, which only records
 * what we last saw.
 *
 * EITHER SOURCE SPARES A SESSION, deliberately, and the two can disagree in
 * exactly one direction: a phone the ops tool demoted while the variable still
 * names it. This tool then keeps a session the router would treat as a
 * customer's — the conservative error, and the only one available, because the
 * damage here is unrecoverable and the damage of keeping one history too many
 * is a history that expires on its own sliding window. Deciding it the other
 * way would mean a destructive tool acting on a disagreement it noticed.
 *
 * Both sources are consulted with the session's CONVERSATION KEY, which on the
 * WhatsApp door is the phone — so this decides exactly what it decided when
 * sessions were keyed by phone alone.
 *
 * AGENT-TO-AGENT EXCHANGES ARE KEPT, and that is this door's answer to the
 * question the phase before it left open. Their key is a correlation id, which
 * no allowlist can ever contain, so `isOwner` would read every one of them as a
 * customer's — a false negative by construction rather than a decision. And the
 * thing it would delete is not a customer's history: there is no person and no
 * personal data behind it, only a machine that may be mid-exchange, which is
 * the same in-progress work the owner exemption exists to protect. Same
 * reasoning as assertOwnerAllowlist below: where the allowlist cannot answer,
 * the destructive default is the wrong one. An operator who does want them gone
 * deletes the caller's registry row — the door closes, and the sessions expire
 * on their own sliding window.
 *
 * `root` is the transcript directory, or undefined to skip the disk half
 * entirely (see transcripts.ts for why it has no default). Dropping the row is
 * what makes a session unresumable, so a purge without a root still does the
 * user-visible job; it just leaves the files for a later sweep.
 */
/**
 * The condition under which this tool must not run at all.
 *
 * KNOWING NO OWNERS makes EVERY session look like a customer's, including the
 * owner's, which this must never touch. The server treats no-owners as a valid
 * deployment; a destructive tool cannot, because the likeliest cause is a
 * missing variable rather than a real intent — and the damage is silent and
 * unrecoverable. Refuse instead of guessing.
 *
 * WHAT "EMPTY" MEANS NOW. The router reads the `assignments` table, and
 * OWNER_PHONE_NUMBERS is only the seed that fills it. So this asks BOTH: a
 * deployment whose owners were assigned through the ops entry point, with the
 * variable never set, can tell an owner from a customer perfectly well, and
 * refusing it would be a guard firing on the wrong question. Only when neither
 * source names a single owner is the answer genuinely unknowable.
 *
 * `db` is optional because the check also runs where there is no database to
 * ask — before one is opened, and in a unit test. Without it the variable is
 * all there is, which is the strictly more conservative half: it can refuse a
 * deployment that would have been fine, never permit one that is not.
 */
export function assertOwnerAllowlist(config: PurgeConfig, db?: DB): void {
  if (config.ownerPhoneNumbers.size > 0) return;
  if (db && countAssignedOwners(db) > 0) return;
  throw new Error(
    "OWNER_PHONE_NUMBERS is empty and no owner is assigned in the assignments table — " +
      "refusing to purge, since every session would look like a customer's. Assign an owner " +
      "(role-assignments set <phone> owner) or set the allowlist, and retry.",
  );
}

export function purgeCustomerSessions(db: DB, config: PurgeConfig, root?: string): PurgeResult {
  // With the database in hand, so the refusal judges what the router judges.
  assertOwnerAllowlist(config, db);

  // The table first, the seed variable second, and EITHER answer spares the
  // session. See the header comment for why the disagreement resolves this way.
  const isOwnerKey = (key: string): boolean =>
    roleForPhone(db, key) === "owner" || isOwner(config, key);

  const sessions = listSessions(db);
  const agents = sessions.filter((s) => isAgentConversationKey(s.conversation_key));
  const customers = sessions.filter(
    (s) => !isAgentConversationKey(s.conversation_key) && !isOwnerKey(s.conversation_key),
  );

  // MESSAGES BEFORE THE SESSION ROW, deliberately, and not the other way round.
  // clearSessionId does not null a column, it DELETES the row — so once it has
  // run for this conversation_key, listSessions (which this loop is driven by)
  // can never surface that customer again. If deleteConversationMessages threw
  // AFTER clearSessionId, the durable words would be stranded forever: no
  // future purge run would ever revisit a conversation_key it no longer sees.
  // Deleting the messages first means a mid-loop failure here leaves the
  // session row untouched, so the NEXT purge run picks this customer back up
  // through listSessions and retries — deleteConversationMessages is a single
  // idempotent DELETE, safe to repeat, so a retry after a partial run costs
  // nothing on a conversation already cleared.
  let purgedMessages = 0;
  for (const session of customers) {
    purgedMessages += deleteConversationMessages(db, session.conversation_key);
    clearSessionId(db, session.agent_id, session.conversation_key);
    if (root) deleteTranscript(root, session.agent_session_id);
  }

  // KNOWN GAP, not silently patched: a conversation can hold
  // `conversation_messages` rows with no `sessions` row at all — the session
  // expired and was swept, or a purge from before this deletion existed
  // already cleared it while the messages (which have no timer of their own,
  // see db.ts) persisted. This loop is driven by listSessions, so such a
  // conversation is invisible to it and its messages survive every future run
  // of this tool. Closing that requires enumerating conversation_keys that
  // have messages independently of the sessions table — repo.ts has no such
  // function today, and reaching around it with raw SQL from here would break
  // the one seam every other caller of this table goes through. Reported
  // upstream rather than worked around.
  const swept = root
    ? sweepOrphanedTranscripts(
        root,
        listSessions(db).map((s) => s.agent_session_id),
        config.sessionMaxAgeDays,
      )
    : null;

  return {
    purged: customers.length,
    kept: sessions.length - customers.length - agents.length,
    keptAgent: agents.length,
    purgedMessages,
    swept,
  };
}
