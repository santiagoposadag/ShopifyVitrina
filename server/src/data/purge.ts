import type { Config } from "../config.js";
import { isOwner } from "../config.js";
import type { DB } from "./db.js";
import { clearSessionId, listSessions } from "./repo.js";
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
  /** Orphaned transcripts collected, or null when no root was configured. */
  swept: number | null;
}

/**
 * Drop every CUSTOMER conversation history — the session rows and the
 * transcripts behind them — then sweep orphans left by earlier resets.
 *
 * OWNER SESSIONS ARE PRESERVED: an owner mid-listing has a session that
 * upsert_product's merge semantics depend on, and dropping it loses in-progress
 * work. Role comes from the OWNER_PHONE_NUMBERS allowlist (config.isOwner) —
 * never from the contacts table, which only records what we last saw.
 *
 * The allowlist is consulted with the session's CONVERSATION KEY, which on the
 * WhatsApp door is the phone — so this decides exactly what it decided when
 * sessions were keyed by phone alone. It stays correct only while every stored
 * key is a phone. The moment a door stores something else (an agent-to-agent
 * correlation id), that key will not match any allowlist entry and its session
 * will be purged as a customer's; whoever adds that door has to decide what a
 * purge means for it rather than inheriting this rule by default.
 *
 * `root` is the transcript directory, or undefined to skip the disk half
 * entirely (see transcripts.ts for why it has no default). Dropping the row is
 * what makes a session unresumable, so a purge without a root still does the
 * user-visible job; it just leaves the files for a later sweep.
 */
/**
 * The condition under which this tool must not run at all.
 *
 * An empty allowlist makes EVERY phone a customer, including the owner's, whose
 * session this must never touch. The server treats no-owners as a valid
 * deployment; a destructive tool cannot, because the likeliest cause is a
 * missing variable rather than a real intent — and the damage is silent and
 * unrecoverable. Refuse instead of guessing.
 *
 * Exported because the check has to happen BEFORE the database is opened as
 * well as here: opening it runs the schema migration, which re-keys legacy
 * sessions using the same allowlist, so an empty one would file the owner's
 * session under the customer agent before this function ever sees it.
 */
export function assertOwnerAllowlist(config: PurgeConfig): void {
  if (config.ownerPhoneNumbers.size === 0) {
    throw new Error(
      "OWNER_PHONE_NUMBERS is empty — refusing to purge, since every session would look like a customer's. Set it to the owner allowlist and retry.",
    );
  }
}

export function purgeCustomerSessions(db: DB, config: PurgeConfig, root?: string): PurgeResult {
  assertOwnerAllowlist(config);

  const sessions = listSessions(db);
  const customers = sessions.filter((s) => !isOwner(config, s.conversation_key));

  for (const session of customers) {
    clearSessionId(db, session.agent_id, session.conversation_key);
    if (root) deleteTranscript(root, session.agent_session_id);
  }

  const swept = root
    ? sweepOrphanedTranscripts(
        root,
        listSessions(db).map((s) => s.agent_session_id),
        config.sessionMaxAgeDays,
      )
    : null;

  return { purged: customers.length, kept: sessions.length - customers.length, swept };
}
