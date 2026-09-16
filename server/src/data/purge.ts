import { isAgentConversationKey } from "../a2a-protocol.js";
import type { Config } from "../config.js";
import { isOwner } from "../config.js";
import { AGENT_IDS } from "../router.js";
import { countAssignedOwners, roleForPhone } from "./assignments.js";
import type { DB } from "./db.js";
import {
  clearSessionId,
  deleteConversationMessages,
  deleteConversationToolCalls,
  listConversationKeysWithMessages,
  listSessions,
} from "./repo.js";
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
  /**
   * Owner sessions deliberately left alone — a phone that currently reads as
   * owner, OR a session recorded under the owner agent for a phone that no
   * longer does. See purgeCustomerSessions for why both count.
   */
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
  /**
   * Durable `conversation_tool_calls` rows deleted for purged customers.
   *
   * Counted separately from the messages rather than summed into them: this is
   * what the assistant DID on that customer's behalf, and an operator verifying
   * that a person was forgotten needs to see both numbers move. One message and
   * nine tool calls is a normal turn, so a single total would read as if far
   * more had been said than was.
   */
  purgedToolCalls: number;
  /**
   * Conversations whose words outlived their session row and that this run
   * reached anyway — the second pass below. Non-zero on the first run after
   * this pass existed (it clears a backlog no previous run could touch) and
   * normally zero afterwards.
   */
  purgedOrphanPairs: number;
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
 * A THIRD SOURCE ALSO SPARES A SESSION: its own agent_id. `sessions` is keyed
 * `(agent_id, conversation_key)`, so one phone can hold a row under BOTH
 * router.ts's AGENT_IDS at once — used the inventory agent, then got
 * demoted or reassigned, all while keeping the same conversation_key. The two
 * checks above answer "what is this phone NOW"; agent_id answers "what was
 * this conversation HAD as", and a demoted phone's owner-mode history is an
 * owner conversation regardless of what the phone reads as today. Same
 * conservative direction as above: this only ever widens what is spared.
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

  // A SESSION ROW'S agent_id RECORDS THE ROLE THAT CONVERSATION WAS HAD AS,
  // which is a different fact from isOwnerKey above (the phone's CURRENT
  // role). sessions is keyed (agent_id, conversation_key), so one phone can
  // hold a row under BOTH AGENT_IDS.owner and AGENT_IDS.customer — a phone
  // demoted after using the inventory agent, or promoted after starting as a
  // customer. isOwnerKey alone would judge the owner-agent row by the phone's
  // present role and delete it as a customer's. Sparing on EITHER signal only
  // ever widens what survives — it can turn a purge into a no-op for a
  // session, never turn a spared session into a purged one — which matches
  // the rest of this function's conservative-by-construction stance: a purge
  // that deletes too little costs an operator a second run, a purge that
  // deletes too much is unrecoverable.
  const isOwnerAgentSession = (agentId: string): boolean => agentId === AGENT_IDS.owner;

  const sessions = listSessions(db);
  const agents = sessions.filter((s) => isAgentConversationKey(s.conversation_key));
  const customers = sessions.filter(
    (s) =>
      !isAgentConversationKey(s.conversation_key) &&
      !isOwnerKey(s.conversation_key) &&
      !isOwnerAgentSession(s.agent_id),
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
  //
  // deleteConversationMessages is scoped to session.agent_id, not just the
  // conversation_key: a phone spared under one agent (above) can still have a
  // PURGED session under the other, on the SAME conversation_key. An unscoped
  // delete here would remove that spared session's messages out from under
  // it, even though its row and its transcript survive — a session with no
  // history is not what "spared" is supposed to mean.
  let purgedMessages = 0;
  let purgedToolCalls = 0;
  for (const session of customers) {
    purgedMessages += deleteConversationMessages(db, session.conversation_key, session.agent_id);
    // THE TOOL TRACE GOES WITH THE WORDS, always. It holds what the customer
    // asked about, whatever a save_lead captured of their name and note, and
    // the catalog operations performed on their behalf — so a purge that
    // removed the messages and left this behind would report a customer
    // forgotten while their data sat in a table the operator does not know to
    // look in. Scoped by agent for the identical reason the line above is.
    purgedToolCalls += deleteConversationToolCalls(db, session.conversation_key, session.agent_id);
    clearSessionId(db, session.agent_id, session.conversation_key);
    if (root) deleteTranscript(root, session.agent_session_id);
  }

  // THE SECOND PASS: conversations whose words outlived their session row.
  //
  // A conversation can hold `conversation_messages` rows with no `sessions` row
  // at all — the session expired and was swept, or an earlier purge cleared it
  // while the messages (which have no timer of their own, see db.ts) persisted.
  // The loop above is driven by listSessions, so every one of those was
  // invisible to it and survived every run of this tool. With retention
  // indefinite, "survived" meant undeletable rather than merely late.
  //
  // THE SAME THREE PREDICATES DECIDE, in the same conservative direction:
  // an agent-to-agent key is kept, a key that reads as an owner is kept, and a
  // pair recorded under the owner AGENT is kept whatever the phone reads as
  // now. A pair already handled above deletes nothing here — the DELETE is
  // idempotent and simply reports zero — so the two passes cannot double-count.
  //
  // Driven by (conversation_key, agent_id) PAIRS rather than keys, because that
  // is the scope deleteConversationMessages requires and for the reason it
  // documents: one phone can hold rows under both personas, and a key-only
  // sweep would take the spared persona's history with it.
  let purgedOrphanPairs = 0;
  for (const orphan of listConversationKeysWithMessages(db)) {
    if (isAgentConversationKey(orphan.conversation_key)) continue;
    if (isOwnerKey(orphan.conversation_key)) continue;
    if (isOwnerAgentSession(orphan.agent_id)) continue;
    const messages = deleteConversationMessages(db, orphan.conversation_key, orphan.agent_id);
    const toolCalls = deleteConversationToolCalls(db, orphan.conversation_key, orphan.agent_id);
    if (messages > 0 || toolCalls > 0) purgedOrphanPairs += 1;
    purgedMessages += messages;
    purgedToolCalls += toolCalls;
  }

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
    purgedToolCalls,
    purgedOrphanPairs,
    swept,
  };
}
