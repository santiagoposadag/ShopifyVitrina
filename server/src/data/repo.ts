import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { DB } from "./db.js";
import type { Lead, LeadType, MessageKind } from "../types.js";

// The catalog is NOT here. Products, variants, prices, stock and photos live in
// Shopify (see ../shopify/), which is the source of truth for every one of
// them. This module owns only what Shopify has no place for: leads, contacts,
// agent sessions, the durable inbox, and inbound photos on their way to a
// product.

export interface LeadInput {
  phone: string;
  product_code?: string | null;
  type: LeadType;
  name?: string | null;
  note?: string | null;
  /**
   * WHERE THIS LEAD CAME FROM: the conversation, the persona and the exact turn.
   *
   * The phone alone says WHO but never WHICH EXCHANGE, so an operator holding a
   * lead could not find the conversation that produced it — the first thing
   * they want, and the thing that makes a lead actionable rather than a name
   * and a guess. Optional because a caller outside a turn (a test, a future
   * import) genuinely has none, and inventing one would point at a turn that
   * never happened.
   */
  conversation_key?: string | null;
  agent_id?: string | null;
  turn_key?: string | null;
}

/**
 * The lifecycle `status` was declared with and never given.
 *
 * The column has existed since the first schema, defaulting to 'new', and
 * nothing ever moved it — so an operator reading the list a second time could
 * not tell which ones they had already handled. These three are the whole
 * vocabulary, deliberately: a fourth state is a process decision nobody has
 * made, and one invented here would be that decision.
 *
 * NOT A CHECK CONSTRAINT, because SQLite cannot add one to the existing table
 * and the running pilot is not worth a rebuild for it. `setLeadStatus` is the
 * single writer and its parameter is this type, so the constraint lives in the
 * type system where every caller is checked against it.
 */
export type LeadStatus = "new" | "in_progress" | "closed";

export const LEAD_STATUSES: readonly LeadStatus[] = ["new", "in_progress", "closed"] as const;

/** Statuses that still owe somebody a contact. */
const OPEN_STATUSES: readonly LeadStatus[] = ["new", "in_progress"] as const;

export function insertLead(db: DB, input: LeadInput): Lead {
  const info = db
    .prepare(
      `INSERT INTO leads (phone, product_code, type, name, note,
                          conversation_key, agent_id, turn_key)
       VALUES (@phone, @product_code, @type, @name, @note,
               @conversation_key, @agent_id, @turn_key)`,
    )
    .run({
      phone: input.phone,
      product_code: input.product_code ?? null,
      type: input.type,
      name: input.name ?? null,
      note: input.note ?? null,
      conversation_key: input.conversation_key ?? null,
      agent_id: input.agent_id ?? null,
      turn_key: input.turn_key ?? null,
    });
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(Number(info.lastInsertRowid)) as Lead;
}

/**
 * The still-open lead this one would duplicate, or null.
 *
 * A customer who asks three times about the same sold-out item is ONE promise
 * to contact them, not three — and three rows make the list longer without
 * making it more informative, which is how a list stops being read. Matched on
 * (phone, type, product_code) because that tuple is what "the same ask" means
 * here: a different product, or wanting a follow-up rather than a restock
 * notice, is a different promise.
 *
 * ONLY OPEN LEADS MATCH. A closed one has been answered, so the customer asking
 * again is a NEW request and must produce a new row — collapsing onto a closed
 * lead would file today's ask under something already marked done.
 *
 * A NULL product_code matches only another NULL, which is what `IS` gives us
 * and `=` would not: a general "tell me when you have more" is one ask, and it
 * should not merge with one about a specific SKU.
 */
export function findOpenDuplicateLead(
  db: DB,
  input: { phone: string; type: LeadType; product_code?: string | null },
): Lead | null {
  const placeholders = OPEN_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT * FROM leads
       WHERE phone = ? AND type = ? AND product_code IS ?
         AND status IN (${placeholders})
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(input.phone, input.type, input.product_code ?? null, ...OPEN_STATUSES) as
    | Lead
    | undefined;
  return row ?? null;
}

/** One lead by id, or null. */
export function getLead(db: DB, id: number): Lead | null {
  return (db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as Lead | undefined) ?? null;
}

/**
 * Move a lead through its lifecycle. Returns the updated lead, or null when no
 * such lead exists.
 *
 * `claimed_by` is who is handling it — the admin phone behind the session. It
 * is CLEARED on a move back to 'new', because a lead nobody is handling must
 * not keep naming somebody: a list that shows an owner for an unattended lead
 * is how one sits untouched while everyone assumes the named person has it.
 */
export function setLeadStatus(
  db: DB,
  input: { id: number; status: LeadStatus; claimedBy?: string | null },
): Lead | null {
  const changed = db
    .prepare(
      `UPDATE leads
       SET status = @status,
           status_changed_at = datetime('now'),
           claimed_by = @claimed_by
       WHERE id = @id`,
    )
    .run({
      id: input.id,
      status: input.status,
      claimed_by: input.status === "new" ? null : (input.claimedBy ?? null),
    }).changes;
  if (changed === 0) return null;
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(input.id) as Lead;
}

/**
 * How many leads still owe somebody a contact. What a dashboard leads with, and
 * what the owner's notification counts against.
 */
export function countOpenLeads(db: DB): number {
  const placeholders = OPEN_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM leads WHERE status IN (${placeholders})`)
    .get(...OPEN_STATUSES) as { n: number };
  return row.n;
}

/**
 * Leads, newest first.
 *
 * `limit` IS NOT OPTIONAL IN EFFECT — it defaults, because the unbounded
 * version was reachable from the `list_leads` tool and put EVERY lead the store
 * has ever captured into the model's context, one line each, on a turn the
 * owner was waiting for. A default that grows without bound is a default that
 * eventually fails in production and nowhere else.
 */
export function listLeads(
  db: DB,
  options: { sinceDays?: number; status?: LeadStatus; openOnly?: boolean; limit?: number } = {},
): Lead[] {
  const { sinceDays, status, openOnly, limit = 100 } = options;
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (sinceDays !== undefined) {
    clauses.push(`created_at >= datetime('now', ?)`);
    params.push(`-${sinceDays} days`);
  }
  if (status !== undefined) {
    clauses.push(`status = ?`);
    params.push(status);
  } else if (openOnly) {
    clauses.push(`status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
    params.push(...OPEN_STATUSES);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM leads ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as Lead[];
}

// --- Contacts / sessions ------------------------------------------------------

export function upsertContact(
  db: DB,
  phone: string,
  role: string,
  name?: string | null,
): void {
  db.prepare(
    `INSERT INTO contacts (phone, name, role, last_seen_at)
     VALUES (@phone, @name, @role, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET
       role = excluded.role,
       last_seen_at = excluded.last_seen_at,
       name = COALESCE(excluded.name, contacts.name)`,
  ).run({ phone, name: name ?? null, role });
}

/**
 * Get the resumable agent session for one agent's conversation. When maxAgeDays
 * is given, sessions idle longer than that are treated as expired (returns
 * undefined) so long-lived contacts start a fresh conversation instead of
 * dragging months of history — and cost — into every turn.
 *
 * Keyed by BOTH parts. The same person talking to two assistants holds two
 * conversations, and answering one of them from the other's transcript is not
 * something either side can detect.
 */
export function getSessionId(
  db: DB,
  agentId: string,
  conversationKey: string,
  maxAgeDays?: number,
): string | undefined {
  const row = (
    maxAgeDays !== undefined
      ? db
          .prepare(
            `SELECT agent_session_id FROM sessions
             WHERE agent_id = ? AND conversation_key = ? AND updated_at >= datetime('now', ?)`,
          )
          .get(agentId, conversationKey, `-${maxAgeDays} days`)
      : db
          .prepare(
            `SELECT agent_session_id FROM sessions WHERE agent_id = ? AND conversation_key = ?`,
          )
          .get(agentId, conversationKey)
  ) as { agent_session_id: string | null } | undefined;
  return row?.agent_session_id ?? undefined;
}

/**
 * Every stored session, regardless of age. Deliberately unfiltered, unlike
 * getSessionId: the callers are housekeeping and the purge tool, and a session
 * too old to RESUME still owns a transcript on disk that must not be swept as
 * an orphan until its row is actually gone.
 */
export function listSessions(
  db: DB,
): { agent_id: string; conversation_key: string; agent_session_id: string }[] {
  return db
    .prepare(
      `SELECT agent_id, conversation_key, agent_session_id
       FROM sessions WHERE agent_session_id IS NOT NULL`,
    )
    .all() as { agent_id: string; conversation_key: string; agent_session_id: string }[];
}

/**
 * Forget one conversation's stored session id. Used when the SDK cannot resume
 * it — the transcript is gone, so keeping the id only guarantees the next turn
 * fails the same way (a replayed inbox row would resume the same dead session).
 */
export function clearSessionId(db: DB, agentId: string, conversationKey: string): void {
  db.prepare(`DELETE FROM sessions WHERE agent_id = ? AND conversation_key = ?`).run(
    agentId,
    conversationKey,
  );
}

/**
 * Store the session id this turn produced, and refresh updated_at — which is
 * what makes the expiry window slide: a conversation expires after
 * SESSION_MAX_AGE_DAYS of SILENCE, not after that long in existence.
 */
export function setSessionId(
  db: DB,
  agentId: string,
  conversationKey: string,
  sessionId: string,
): void {
  db.prepare(
    `INSERT INTO sessions (agent_id, conversation_key, agent_session_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(agent_id, conversation_key) DO UPDATE SET
       agent_session_id = excluded.agent_session_id,
       updated_at = excluded.updated_at`,
  ).run(agentId, conversationKey, sessionId);
}

// --- Inbox (at-least-once message processing) --------------------------------

export type InboxStatus = "pending" | "processing" | "done" | "failed";

/**
 * What the worker must do with a row's media_ref. Explicit rather than derived
 * from `kind`: a voice note is persisted as kind='text' (see db.ts), so reading
 * intent off `kind` would couple this to a rule stated in another file.
 */
export type InboxMediaKind = "photo" | "audio";

/**
 * Which door authenticated this row's sender. Mirrors `Principal`'s own tags
 * (inbox/envelope.ts) rather than importing them, for the same reason
 * MessageKind lives in types.ts: this module must be able to type its columns
 * without importing a module that imports it back.
 */
export type PrincipalKind = "whatsapp" | "agent";

export interface InboxRow {
  id: number;
  dedupe_key: string;
  /**
   * The WhatsApp sender. EMPTY STRING on an agent-door row: the column is NOT
   * NULL and predates the second door, and an agent caller has no phone. Empty
   * rather than the caller's id, deliberately — a phone column holding
   * "super-agent" could be handed to sendText, and the only thing worse than a
   * failed send is a successful one to a stranger.
   */
  phone: string;
  agent_text: string;
  /** What the event was, straight from the webhook — never re-derived from the text. */
  kind: MessageKind;
  /** Set while a voice note still needs transcribing; null once agent_text holds it. */
  audio_path: string | null;
  /**
   * The transport's reference to a file this message carried, while it is still
   * UNFETCHED. Null once the worker has downloaded it (or given up on it).
   *
   * Not the same state as audio_path, which means the bytes are already on our
   * disk. Collapsing the two would make a retried batch re-download a file it
   * already holds.
   */
  media_ref: string | null;
  /** 'photo' | 'audio' — what resolveMedia should do with media_ref. */
  media_kind: InboxMediaKind | null;
  media_mime: string | null;
  media_name: string | null;
  /** WhatsApp's send stamp (unix seconds), on its way to pending_media.sent_at. */
  media_sent_at: number | null;
  /** The TARGET agent. NULL on a WhatsApp row — resolved when the burst flushes. */
  agent_id: string | null;
  principal_kind: PrincipalKind;
  /** The phone, or the CALLING agent's id as its credential identified it. */
  principal_id: string | null;
  /**
   * What claimInboxBatch claims by: the phone, or an 'a2a:' correlation key.
   *
   * Typed non-null although the column is nullable. Nothing can write NULL —
   * the insert resolves it in SQL — and the boot backfill fills the rows
   * written before the column existed, so a NULL here would mean a row written
   * by a build that no longer exists.
   */
  conversation_key: string;
  /** A callback URL for a caller that cannot take the reply in its response. */
  reply_to: string | null;
  /** Agent-to-agent hops that produced this message; 0 from a human door. */
  hop: number;
  status: InboxStatus;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

/**
 * Persist an inbound message for processing. Returns the new row, or null when
 * the dedupe key was already recorded (a Kapso retry of a persisted event).
 *
 * `kind` defaults to "text" so callers that deal only in chat stay unchanged;
 * the webhook always passes what it parsed.
 */
export function insertInboxMessage(
  db: DB,
  input: {
    dedupe_key: string;
    phone: string;
    agent_text: string;
    kind?: MessageKind;
    audio_path?: string | null;
    /** An unfetched file reference; the worker resolves it (see batcher.resolveMedia). */
    media_ref?: string | null;
    media_kind?: InboxMediaKind | null;
    media_mime?: string | null;
    media_name?: string | null;
    media_sent_at?: number | null;
    /** The TARGET agent. Only the agent door knows it at insert time. */
    agent_id?: string | null;
    principal_kind?: PrincipalKind;
    /** The caller as its DOOR identified it. Defaults to the phone. */
    principal_id?: string | null;
    /**
     * Defaults to the phone, which is what it IS on the WhatsApp door — so
     * every caller written before a second door existed keeps working and keeps
     * meaning the same thing.
     */
    conversation_key?: string | null;
    reply_to?: string | null;
    hop?: number;
  },
): InboxRow | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO inbox
         (dedupe_key, phone, agent_text, kind, audio_path,
          media_ref, media_kind, media_mime, media_name, media_sent_at,
          agent_id, principal_kind, principal_id, conversation_key, reply_to, hop)
       VALUES
         (@dedupe_key, @phone, @agent_text, @kind, @audio_path,
          @media_ref, @media_kind, @media_mime, @media_name, @media_sent_at,
          @agent_id, @principal_kind, @principal_id,
          -- The phone IS the conversation on the WhatsApp door. Resolved in SQL
          -- so no caller can persist a row with no conversation at all: such a
          -- row can never be claimed, and never claimed means a message that is
          -- never answered and never reported.
          COALESCE(@conversation_key, @phone),
          @reply_to, @hop)`,
    )
    .run({
      kind: "text",
      audio_path: null,
      media_ref: null,
      media_kind: null,
      media_mime: null,
      media_name: null,
      media_sent_at: null,
      agent_id: null,
      principal_kind: "whatsapp",
      conversation_key: null,
      reply_to: null,
      hop: 0,
      ...input,
      // Defaulted from the phone rather than left null: on the WhatsApp door
      // the sender IS the principal, and an audit column that is empty for
      // every row written before a second door existed answers no question.
      principal_id: input.principal_id ?? input.phone,
    });
  if (info.changes === 0) return null;
  return getInboxRow(db, Number(info.lastInsertRowid));
}

/**
 * Persist an agent-door message, unless that conversation already has one in
 * flight.
 *
 * ONE EXCHANGE AT A TIME PER CONVERSATION, and this is where it is enforced.
 * `claimInboxBatch` takes every un-settled row of a conversation at once, so
 * two exchanges opened on one key would be answered by a single turn — and
 * "which of you asked this" then has no answer, because the reply is one string
 * and the two callers are two open requests. Refusing is something a caller can
 * act on; merging is how one agent receives another's answer.
 *
 * ONE IMMEDIATE TRANSACTION over the look and the write. A check followed by an
 * insert would let two simultaneous requests each find nothing and each insert;
 * taking the write lock up front makes the loser block and then re-read inside
 * the lock, where it sees the row the winner wrote. Same reasoning as the
 * sessions rebuild in data/db.ts.
 *
 * `busy` and a null `row` are different answers: busy means an exchange is
 * still running, null means this exact message id was already accepted (the
 * UNIQUE dedupe key absorbed it), and a caller acts differently on each.
 */
export function insertAgentInboxMessage(
  db: DB,
  input: Parameters<typeof insertInboxMessage>[1] & { conversation_key: string },
): { row: InboxRow | null; busy: boolean } {
  const inFlight = db.prepare(
    `SELECT 1 FROM inbox
     WHERE conversation_key = ? AND status IN ('pending','processing')
     LIMIT 1`,
  );
  const tx = db.transaction((): { row: InboxRow | null; busy: boolean } => {
    if (inFlight.get(input.conversation_key)) return { row: null, busy: true };
    return { row: insertInboxMessage(db, input), busy: false };
  });
  return tx.immediate();
}

/**
 * Record a voice note's transcript and retire its audio.
 *
 * Both fields move together, in one statement, because they are the same fact:
 * clearing audio_path is what marks the audio as already paid for. A batch that
 * fails downstream is retried, and without this every retry would re-upload and
 * re-bill the same seconds of speech.
 */
export function setInboxTranscript(db: DB, id: number, transcript: string): void {
  db.prepare(`UPDATE inbox SET agent_text = @transcript, audio_path = NULL WHERE id = @id`).run({
    id,
    transcript,
  });
}

/**
 * Record where a downloaded voice note landed, and retire its media reference.
 *
 * Both fields move in one statement because they are the same fact: the bytes
 * are now on our disk, so the reference that pointed at the transport is spent.
 * A batch that fails downstream is claimed again, and a lingering media_ref
 * would make the retry download the same file a second time — on the Cloud API
 * that is two more Graph round trips for a file we already have.
 */
export function setInboxAudioPath(db: DB, id: number, audioPath: string): void {
  db.prepare(`UPDATE inbox SET audio_path = @audioPath, media_ref = NULL WHERE id = @id`).run({
    id,
    audioPath,
  });
}

/**
 * Mark a row's media reference as spent without producing a file.
 *
 * Used for a photo that reached pending_media (the row itself needs no path)
 * and for a download that failed. Failure clears it too, deliberately: the
 * webhook never retried a lost photo either, and leaving the ref set would make
 * every one of the batch's remaining attempts re-attempt the same dead fetch
 * while the person waits for an answer the photo is not required for.
 */
export function clearInboxMedia(db: DB, id: number): void {
  db.prepare(`UPDATE inbox SET media_ref = NULL WHERE id = ?`).run(id);
}

export function getInboxRow(db: DB, id: number): InboxRow | null {
  const row = db.prepare(`SELECT * FROM inbox WHERE id = ?`).get(id) as InboxRow | undefined;
  return row ?? null;
}

/**
 * Claim every un-settled row of ONE CONVERSATION as a batch: 'pending' rows
 * plus 'processing' rows a previous process crashed on. Marking them in a
 * single transaction keeps at-least-once intact — a crash mid-batch leaves them
 * 'processing', so listReplayableInbox picks the whole burst up again on boot.
 *
 * Ordered by arrival (received_at is only second-resolution, so id breaks ties)
 * because the joined prompt has to read in the order the user typed it.
 *
 * BY CONVERSATION, NOT BY PHONE. On the WhatsApp door the two are the same
 * string and this behaves exactly as it always did; on the agent door the key
 * is a namespaced correlation id, and that namespace is what stops an agent's
 * exchange from claiming — answering, and settling — a person's pending
 * messages by naming their phone number as its correlation id.
 *
 * Callers MUST run this inside the conversation's queue: serialization is what
 * stops two batches from claiming the same rows.
 */
export function claimInboxBatch(db: DB, conversationKey: string): InboxRow[] {
  const select = db.prepare(
    `SELECT * FROM inbox
     WHERE conversation_key = ? AND status IN ('pending','processing')
     ORDER BY received_at ASC, id ASC`,
  );
  const claim = db.prepare(
    `UPDATE inbox SET status = 'processing', attempts = attempts + 1 WHERE id = ?`,
  );
  // Read and claim share one transaction, so the batch is atomic even if a
  // future caller ever violates the per-conversation-queue invariant above.
  const tx = db.transaction((): InboxRow[] => {
    const rows = select.all(conversationKey) as InboxRow[];
    for (const row of rows) claim.run(row.id);
    return rows.map((row) => ({ ...row, status: "processing" as const, attempts: row.attempts + 1 }));
  });
  return tx();
}

/** Settle a whole claimed batch. All-or-nothing: one agent turn, one outcome. */
export function markInboxBatchDone(db: DB, ids: number[]): void {
  const mark = db.prepare(
    `UPDATE inbox SET status = 'done', processed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) mark.run(id);
  });
  tx();
}

export function markInboxBatchFailed(db: DB, ids: number[]): void {
  const mark = db.prepare(
    `UPDATE inbox SET status = 'failed', processed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) mark.run(id);
  });
  tx();
}

/**
 * Return a claimed batch to 'pending' for a delayed retry. attempts is NOT
 * reset — it is the retry budget (see MAX_BATCH_ATTEMPTS in batcher.ts). The
 * rows are re-claimed by the next flush for that phone, together with any newer
 * messages, so a retried batch may grow; ordering holds because the old rows
 * keep their original received_at/id.
 */
export function markInboxBatchPending(db: DB, ids: number[]): void {
  const mark = db.prepare(`UPDATE inbox SET status = 'pending' WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const id of ids) mark.run(id);
  });
  tx();
}

/**
 * Rows a previous process accepted but never finished: 'pending' (crashed
 * before the queue ran it) or 'processing' (crashed mid agent turn). Ordered by
 * id so per-phone ordering is preserved when re-enqueued.
 */
export function listReplayableInbox(db: DB): InboxRow[] {
  return db
    .prepare(`SELECT * FROM inbox WHERE status IN ('pending','processing') ORDER BY id ASC`)
    .all() as InboxRow[];
}

/**
 * TTL cleanup for settled inbox rows. Done rows only serve dedupe, so a few
 * days beyond Kapso's retry window is plenty; failed rows are kept longer for
 * diagnosis. Returns the number of rows deleted.
 */
export function deleteStaleInboxRows(
  db: DB,
  doneOlderThanDays = 7,
  failedOlderThanDays = 30,
): number {
  const done = db
    .prepare(`DELETE FROM inbox WHERE status = 'done' AND processed_at < datetime('now', ?)`)
    .run(`-${doneOlderThanDays} days`);
  const failed = db
    .prepare(`DELETE FROM inbox WHERE status = 'failed' AND processed_at < datetime('now', ?)`)
    .run(`-${failedOlderThanDays} days`);
  return done.changes + failed.changes;
}


// --- Conversation record ------------------------------------------------------

// What was said, in both directions, kept beyond the queue that carried it.
//
// The inbox is a work queue: deleteStaleInboxRows above drops settled rows a
// week on, and outbound was never persisted anywhere at all. Everything in this
// section writes to `conversation_messages` instead, which that sweep does not
// touch — see the table's own comment in db.ts for why the two are separate.
//
// EVERY WRITE HERE IS IDEMPOTENT, because every caller is on a retry path.
// processBatch re-runs the same code over the same messages up to
// MAX_BATCH_ATTEMPTS times, and a reply can be delivered twice when a crash
// falls between the send and the batch settling. The two directions mint their
// dedupe keys differently and each function says why.

export type MessageDirection = "inbound" | "outbound";

export interface ConversationMessage {
  id: number;
  /** How this row is recognised as already written. See the two recorders. */
  dedupe_key: string;
  direction: MessageDirection;
  conversation_key: string;
  agent_id: string;
  /** The words: what the person sent, or what we delivered. */
  body: string;
  /** What the message was, as the door parsed it — never re-derived from body. */
  kind: MessageKind;
  /** Which turn this belongs to; every message answered together shares one. */
  turn_key: string;
  /**
   * The inbox row this came from, on inbound rows only.
   *
   * EXPECTED TO DANGLE. Not a foreign key (db.ts says why): the row it names is
   * deleted by the inbox TTL, and this record outliving that deletion is the
   * whole point of the table.
   */
  source_inbox_id: number | null;
  /** When it happened — arrival for inbound, delivery for outbound. */
  occurred_at: string;
  /** When we wrote it down. Differs from occurred_at on a replayed batch. */
  recorded_at: string;
  /**
   * The admin phone that sent this, or NULL when the assistant did.
   *
   * The one field that tells a human's words from a model's. Without it an
   * admin's reply and the bot's are the same row, which answers the single
   * question a handoff exists to make answerable.
   */
  sent_by: string | null;
}

/**
 * The fields the inbound recorder reads off a claimed inbox row.
 *
 * A structural subset rather than InboxRow itself, in the style of the
 * batcher's BatchRow: it states exactly what is read, and it lets this be
 * tested without building a whole row.
 */
export interface RecordableInboxRow {
  id: number;
  /**
   * Which conversation this message belongs to, as the door that authenticated
   * its sender wrote it. TAKEN FROM THE ROW rather than passed alongside it, on
   * the same principle processBatch applies to the rest of the envelope: the
   * row is the record of what was proven at the door, and a second source for
   * the same fact is a second thing that can be wrong. A caller that passed the
   * key separately could file one person's words under another's conversation,
   * and the dedupe key — the inbox id — would then make the mistake permanent,
   * since the correcting write is recognised as a duplicate and ignored.
   */
  conversation_key: string;
  agent_text: string;
  kind: MessageKind;
  received_at: string;
}

/**
 * Record one claimed batch's messages. Returns how many rows were newly
 * written — 0 on a retry that had already recorded them.
 *
 * ONE ROW PER MESSAGE. The coalesced prompt buildBatchText produces is a
 * derived artifact of the debounce window; the messages are the observable
 * fact. `turnKey` is carried on each of them, so which ones were answered
 * together is still visible.
 *
 * IDEMPOTENT PER SOURCE INBOX ROW, which is the only key that survives what
 * this retries against. A failed batch returns its rows to 'pending' and the
 * next flush claims them again — together with anything that arrived in the
 * meantime, so the batch itself is not stable between attempts and neither is
 * anything derived from the whole set. `inbox.id` is: the row keeps it across
 * every attempt, and because `inbox` is AUTOINCREMENT rather than a plain
 * rowid, SQLite never hands a deleted row's id to a new message — so a key
 * written today cannot be re-minted by a different message after the TTL sweep.
 *
 * CALL THIS AFTER MEDIA AND AUDIO ARE RESOLVED. The batcher mutates its row
 * objects in place, so a voice note's `agent_text` is its transcript only once
 * resolveAudio has run; recording earlier would store an empty body and never
 * correct it, since the retry that follows finds the key already written.
 *
 * One transaction: a batch is recorded whole or not at all, matching how the
 * batch itself is settled.
 */
export function recordInboundMessages(
  db: DB,
  input: {
    /** Which assistant answered. The rows cannot say: a WhatsApp row's agent_id
     * is NULL by design, resolved once per burst when it flushes. */
    agentId: string;
    turnKey: string;
    rows: readonly RecordableInboxRow[];
  },
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO conversation_messages
       (dedupe_key, direction, conversation_key, agent_id, body, kind,
        turn_key, source_inbox_id, occurred_at)
     VALUES
       (@dedupe_key, 'inbound', @conversation_key, @agent_id, @body, @kind,
        @turn_key, @source_inbox_id, @occurred_at)`,
  );
  const tx = db.transaction((): number => {
    let written = 0;
    for (const row of input.rows) {
      const info = insert.run({
        dedupe_key: inboundDedupeKey(row.id),
        conversation_key: row.conversation_key,
        agent_id: input.agentId,
        body: row.agent_text,
        kind: row.kind,
        turn_key: input.turnKey,
        source_inbox_id: row.id,
        // The row's OWN arrival stamp, not now(): a burst is recorded when the
        // debounce window closes, and stamping it then would collapse messages
        // typed a minute apart onto one instant.
        occurred_at: row.received_at,
      });
      written += info.changes;
    }
    return written;
  });
  return tx();
}

/**
 * Record a reply that was delivered. Returns false when this exact reply was
 * already recorded for this turn.
 *
 * MUST BE CALLED AFTER A SUCCESSFUL SEND, by the caller. Nothing here can check
 * that, and recording before would produce a record of a message the person
 * never received — the failure this record exists to make visible.
 *
 * THE KEY IS THE CONVERSATION, THE TURN AND THE WORDS, hashed together. The
 * turn alone is not enough and the reasoning cuts both ways:
 *
 *  - A crash between the send and markInboxBatchDone replays the batch, and the
 *    replayed turn keeps the SAME turn key (it is the first row's dedupe key,
 *    stable by construction). If it produces the same answer, the person was
 *    told the same thing twice by an at-least-once transport, and one row is
 *    the honest record of what was said.
 *  - If that replay answers DIFFERENTLY — the store changed, the model chose
 *    other words — the person received two different messages, and keying on
 *    the turn alone would hide the second. A record missing a message the
 *    person acted on is worse than a duplicate.
 *
 * Hashed rather than concatenated because a conversation key contains colons
 * ('a2a:caller:target:correlation'): concatenating three fields with a
 * separator that occurs inside one of them lets two different tuples produce
 * one string, and the collision would silently drop a real message.
 */
export function recordOutboundMessage(
  db: DB,
  input: {
    conversationKey: string;
    agentId: string;
    turnKey: string;
    body: string;
    /** Defaults to 'text'; nothing this build sends is anything else. */
    kind?: MessageKind;
    /**
     * When it was delivered, if the caller knows better than now() — a
     * transport's own stamp, or a replay reconstructing an earlier send.
     * Defaults to now(), which is what every current caller means.
     */
    occurredAt?: string;
    /**
     * The admin phone that sent this, when a HUMAN did.
     *
     * OMITTED MEANS THE ASSISTANT, which is every message this system sent
     * before an admin could reply into a conversation — so existing rows read
     * correctly with no backfill. It is part of the dedupe key below because
     * the same words from a human and from the agent are two different events,
     * and collapsing them would attribute one to whichever wrote first.
     */
    sentBy?: string;
  },
): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO conversation_messages
         (dedupe_key, direction, conversation_key, agent_id, body, kind,
          turn_key, source_inbox_id, occurred_at, sent_by)
       VALUES
         (@dedupe_key, 'outbound', @conversation_key, @agent_id, @body, @kind,
          @turn_key, NULL, COALESCE(@occurred_at, datetime('now')), @sent_by)`,
    )
    .run({
      dedupe_key: outboundDedupeKey(
        input.conversationKey,
        input.turnKey,
        input.body,
        input.sentBy ?? null,
      ),
      conversation_key: input.conversationKey,
      agent_id: input.agentId,
      body: input.body,
      kind: input.kind ?? "text",
      turn_key: input.turnKey,
      occurred_at: input.occurredAt ?? null,
      sent_by: input.sentBy ?? null,
    });
  return info.changes > 0;
}

/**
 * One conversation's messages, oldest first, both directions interleaved.
 *
 * Ordered by occurred_at with id as the tie-break, because occurred_at has
 * second resolution everywhere in this schema: a reply sent in the same second
 * as the question would otherwise be free to sort ahead of it, and a transcript
 * where the answer precedes the question is worse than no transcript.
 *
 * `limit` takes the MOST RECENT n and hands them back oldest-first. Taking the
 * first n would answer "how did this start" to a caller asking what just
 * happened — and with no retention policy in place (see db.ts) a conversation
 * has no bound on how long it can get, so the unbounded read is the one that
 * needs a caller to think.
 */
export function listConversationMessages(
  db: DB,
  conversationKey: string,
  options: {
    limit?: number;
    /**
     * Narrow to ONE persona's side of this key.
     *
     * OMITTED MEANS BOTH, which is what every caller before the admin console
     * wanted and what the purge tests assert on. A phone holds a separate
     * conversation with each agent — that is the whole point of the session key
     * — so a READER rendering a thread must pass this or it interleaves the
     * owner's stock edits with the same person's customer-side messages into
     * one conversation that never happened. A caller COUNTING or PURGING
     * usually wants both, and deleteConversationMessages requires its own scope
     * separately for a reason documented on it.
     */
    agentId?: string;
  } = {},
): ConversationMessage[] {
  const { limit, agentId } = options;
  // Built rather than branched, so the agent scope and the limit compose: the
  // four combinations were two nested ifs and a duplicated SELECT before.
  const where = agentId === undefined ? `conversation_key = ?` : `conversation_key = ? AND agent_id = ?`;
  const params: (string | number)[] = agentId === undefined ? [conversationKey] : [conversationKey, agentId];

  if (limit === undefined) {
    return db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE ${where}
         ORDER BY occurred_at ASC, id ASC`,
      )
      .all(...params) as ConversationMessage[];
  }
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM conversation_messages
         WHERE ${where}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?
       ) ORDER BY occurred_at ASC, id ASC`,
    )
    .all(...params, limit) as ConversationMessage[];
}

/**
 * Forget one conversation's record entirely. Returns the number of rows
 * deleted.
 *
 * The ops lever, for the purge tool — NOT a TTL, and nothing calls it on a
 * timer. It deletes both directions, because half a conversation is a worse
 * record than none: an outbound row with nothing that prompted it reads as the
 * assistant messaging someone unbidden.
 *
 * The key becomes writable again afterwards, which is correct: a purged
 * conversation that starts talking is a new conversation, and the inbox rows
 * that could have re-minted the old keys are long gone by then.
 */
/**
 * `agentId` is REQUIRED, not optional with a "delete everything" default: one
 * conversation_key (a phone) can hold a row under EACH agent — router.ts's
 * AGENT_IDS map one phone to two possible personas — and an unscoped DELETE
 * over conversation_key alone would remove one agent's messages while purging
 * the other's session, which is exactly the data loss purge.ts's
 * purgeCustomerSessions was found to have caused. Making the scope mandatory
 * means that mistake cannot be reintroduced by a future caller forgetting an
 * optional argument; there is no unscoped form left to fall back to.
 */
export function deleteConversationMessages(
  db: DB,
  conversationKey: string,
  agentId: string,
): number {
  return db
    .prepare(`DELETE FROM conversation_messages WHERE conversation_key = ? AND agent_id = ?`)
    .run(conversationKey, agentId).changes;
}

/** An inbound message is identified by the inbox row it came from. */
function inboundDedupeKey(inboxId: number): string {
  return `in:${inboxId}`;
}

/**
 * An outbound message is identified by what was said, to whom, on which turn.
 * JSON.stringify over an array, so no field's own punctuation can shift a
 * boundary; the 'out:' prefix keeps the two directions' key spaces apart.
 */
function outboundDedupeKey(
  conversationKey: string,
  turnKey: string,
  body: string,
  sentBy: string | null,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([conversationKey, turnKey, body, sentBy]))
    .digest("hex");
  return `out:${digest}`;
}

/**
 * Every conversation_key that has messages, regardless of whether a `sessions`
 * row still points at it.
 *
 * THE POINT IS THE INDEPENDENCE FROM `sessions`. purgeCustomerSessions is
 * driven by listSessions, which filters `agent_session_id IS NOT NULL` — so a
 * conversation whose session expired and was swept keeps its words through
 * every future purge run, undeletable rather than merely late (DEUDA #8, raised
 * to High by the indefinite retention in #7). This is what that loop unions
 * against, and it is here rather than as raw SQL inside purge.ts so the table
 * keeps the single seam every other caller goes through.
 *
 * The agent id comes back WITH the key, not separately: deleteConversationMessages
 * requires a scope for a reason that is documented at length on it — one phone
 * can hold rows under both personas, and an unscoped delete removes the spared
 * one's history. A caller handed only keys would have to invent that scope.
 */
export function listConversationKeysWithMessages(
  db: DB,
): { conversation_key: string; agent_id: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT conversation_key, agent_id FROM conversation_messages
       ORDER BY conversation_key, agent_id`,
    )
    .all() as { conversation_key: string; agent_id: string }[];
}

/** One conversation as the admin console's index lists them. */
export interface ConversationSummary {
  conversation_key: string;
  agent_id: string;
  message_count: number;
  inbound_count: number;
  /** Newest first is what the index sorts by; this is that value. */
  last_occurred_at: string;
  first_occurred_at: string;
  /** The most recent message's direction and words, for the index's preview line. */
  last_direction: MessageDirection;
  last_body: string;
}

/**
 * Every conversation, newest activity first.
 *
 * GROUPED BY (conversation_key, agent_id), not by key alone. One phone holds a
 * separate conversation with each persona — that is the whole point of the
 * session key — and collapsing them would interleave an owner's stock edits
 * with the same person's customer-side test messages into one thread that never
 * happened.
 *
 * The preview comes from a CORRELATED SUBQUERY rather than an aggregate over
 * the group: SQLite's bare-column-with-max() would pick the row matching
 * max(occurred_at), but occurred_at has second resolution here and ties are
 * broken by id everywhere else in this file — so the aggregate form would show
 * a different "last message" than opening the thread does, which reads as a
 * bug in whichever of the two the reader believes.
 *
 * NO SEARCH PARAMETER, deliberately. A LIKE over `body` is the obvious next
 * feature and it is also the one that would make this query scan every stored
 * word on every page load; the index serves the grouping and nothing else.
 * When it is wanted, it wants FTS5 like the knowledge index, not a LIKE bolted
 * on here.
 */
export function listConversations(
  db: DB,
  options: { limit: number; offset?: number } = { limit: 50 },
): ConversationSummary[] {
  return db
    .prepare(
      `SELECT
         conversation_key,
         agent_id,
         COUNT(*) AS message_count,
         SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
         MAX(occurred_at) AS last_occurred_at,
         MIN(occurred_at) AS first_occurred_at,
         (SELECT direction FROM conversation_messages m
           WHERE m.conversation_key = c.conversation_key AND m.agent_id = c.agent_id
           ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1) AS last_direction,
         (SELECT body FROM conversation_messages m
           WHERE m.conversation_key = c.conversation_key AND m.agent_id = c.agent_id
           ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1) AS last_body
       FROM conversation_messages c
       GROUP BY conversation_key, agent_id
       ORDER BY last_occurred_at DESC, conversation_key ASC
       LIMIT ? OFFSET ?`,
    )
    .all(options.limit, options.offset ?? 0) as ConversationSummary[];
}

/** How many conversations exist, so a reader knows whether a page is the last one. */
export function countConversations(db: DB): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM
         (SELECT 1 FROM conversation_messages GROUP BY conversation_key, agent_id)`,
    )
    .get() as { n: number };
  return row.n;
}

// --- Tool trace ---------------------------------------------------------------

// What the assistant DID, beside what it said. See the conversation_tool_calls
// block in db.ts for why this is its own table rather than a third direction on
// conversation_messages.
//
// The writer here is wrapped around every tool handler in one place
// (tools/registry.ts buildToolServer), so a tool added to a pack is traced
// without anything remembering to trace it.

export type ToolOutcome = "ok" | "error";

export interface ToolCall {
  id: number;
  dedupe_key: string;
  conversation_key: string;
  agent_id: string;
  turn_key: string;
  /** Position in the turn's call sequence, from 1. See db.ts on why not time. */
  ordinal: number;
  tool_name: string;
  /** The arguments as JSON text, capped — see MAX_TOOL_INPUT_CHARS. */
  input: string;
  /** What the model was handed back, capped — see MAX_TOOL_RESULT_CHARS. */
  result: string;
  /** 'error' means the handler THREW. A business refusal is 'ok' with the refusal in `result`. */
  outcome: ToolOutcome;
  duration_ms: number;
  occurred_at: string;
}

/**
 * How much of a tool result is kept.
 *
 * GENEROUS ON PURPOSE. The whole reason this trace exists is to answer "where
 * did that number come from", and a cap that routinely cut the answer in half
 * would leave a trace that looks complete and is not. The largest thing any
 * shipped tool returns is a catalog search or a product listing, both of which
 * sit comfortably under this — so in normal operation nothing is cut at all,
 * and the cap is a bound against a pathological result rather than a budget.
 *
 * The input cap is smaller because the largest input is a create_product
 * payload, which is an order of magnitude smaller than a listing.
 */
const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 4_000;

/**
 * Cut to a cap, leaving a MARKER saying it was cut.
 *
 * A silent truncation is the failure mode worth spending a line on: a trace
 * that ends mid-sentence reads as a tool that returned less than it did, and
 * the person reading it is by definition trying to find out what the tool
 * returned. The marker names how much is missing, so the reader knows whether
 * they are looking at a rounding error or at most of the answer.
 */
function cap(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const dropped = value.length - limit;
  return `${value.slice(0, limit)}\n… [truncado: ${dropped} caracteres más]`;
}

/**
 * Serialise a tool's arguments without letting a bad value lose the call.
 *
 * JSON.stringify throws on a circular structure and returns undefined for a
 * bare function or symbol. Neither should reach here — every tool's input is
 * JSON off the wire — but this runs inside the wrapper around a live tool call,
 * and a trace writer that can throw would turn an observability feature into a
 * way to fail a turn. The failure is recorded as itself instead.
 */
function serialiseToolInput(input: unknown): string {
  try {
    return cap(JSON.stringify(input) ?? String(input), MAX_TOOL_INPUT_CHARS);
  } catch (err) {
    return `[no serializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * Record one tool call. Returns false when this exact call was already recorded.
 *
 * IDEMPOTENT ON (conversation, turn, ordinal, name, input, result), hashed —
 * the same shape and the same reasoning as recordOutboundMessage, because it
 * retries against the same thing. A failed batch re-runs the whole turn under
 * the SAME turn key (it is minted from the first inbox row, stable by
 * construction), so:
 *
 *  - A replay that calls the same tools with the same arguments and gets the
 *    same answers collapses onto the rows already written. The work really was
 *    the same work, and one row is the honest record of it.
 *  - A replay that DIVERGES — the store changed between attempts, the model
 *    chose different arguments — writes new rows from the point of divergence.
 *    That divergence is the single most valuable thing this table can show, and
 *    keying on (turn, ordinal) alone would hide it behind the first attempt.
 *
 * THE AGENT IS PART OF THE KEY, even though a turn key is unique enough on its
 * own today (it is minted from an inbox row id, and no two agents share one).
 * "Unique enough today" is the property that quietly stops holding: one
 * conversation_key legitimately holds rows under BOTH personas everywhere else
 * in this schema, and every other scope over this data is mandatory-by-agent
 * for that reason. A key that omitted it would file the second persona's
 * identical call as a duplicate of the first and drop it from the trace, with
 * nothing to show it had.
 *
 * Hashed rather than concatenated for the reason spelled out on
 * outboundDedupeKey: a conversation key contains colons, so a separator that
 * occurs inside a field lets two different tuples collide — and here a
 * collision silently drops a real call from the trace.
 */
export function recordToolCall(
  db: DB,
  input: {
    conversationKey: string;
    agentId: string;
    turnKey: string;
    ordinal: number;
    toolName: string;
    /** The raw arguments; serialised and capped here, not by the caller. */
    toolInput: unknown;
    result: string;
    outcome: ToolOutcome;
    durationMs: number;
  },
): boolean {
  const serialisedInput = serialiseToolInput(input.toolInput);
  const cappedResult = cap(input.result, MAX_TOOL_RESULT_CHARS);
  const dedupeKey = `tool:${createHash("sha256")
    .update(
      JSON.stringify([
        input.conversationKey,
        input.agentId,
        input.turnKey,
        input.ordinal,
        input.toolName,
        serialisedInput,
        cappedResult,
      ]),
    )
    .digest("hex")}`;

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO conversation_tool_calls
         (dedupe_key, conversation_key, agent_id, turn_key, ordinal,
          tool_name, input, result, outcome, duration_ms)
       VALUES
         (@dedupe_key, @conversation_key, @agent_id, @turn_key, @ordinal,
          @tool_name, @input, @result, @outcome, @duration_ms)`,
    )
    .run({
      dedupe_key: dedupeKey,
      conversation_key: input.conversationKey,
      agent_id: input.agentId,
      turn_key: input.turnKey,
      ordinal: input.ordinal,
      tool_name: input.toolName,
      input: serialisedInput,
      result: cappedResult,
      outcome: input.outcome,
      // Rounded, because the column is an INTEGER and a fractional millisecond
      // from performance.now() would otherwise be stored by SQLite's own
      // coercion rather than by a decision here.
      duration_ms: Math.round(input.durationMs),
    });
  return info.changes > 0;
}

/**
 * One conversation's tool calls, in the order they ran.
 *
 * Ordered by time FIRST and then by (turn, ordinal), which is what makes the
 * sequence read correctly at both scales. Time alone is not enough: occurred_at
 * has second resolution, several calls of one turn routinely land inside one
 * second, and a trace where a write precedes the read it was based on is worse
 * than no trace — so the ordinal breaks those ties and restores the order the
 * model issued them in. Conversations are serialized per key
 * (`PerConversationQueue`), so two turns cannot interleave in time here and the
 * turn-level order is unambiguous.
 *
 * Scoped by agent as well as by conversation, matching listConversations: the
 * two personas on one phone are two threads and their traces must not merge.
 */
export function listConversationToolCalls(
  db: DB,
  conversationKey: string,
  agentId: string,
): ToolCall[] {
  return db
    .prepare(
      `SELECT * FROM conversation_tool_calls
       WHERE conversation_key = ? AND agent_id = ?
       ORDER BY occurred_at ASC, turn_key ASC, ordinal ASC, id ASC`,
    )
    .all(conversationKey, agentId) as ToolCall[];
}

/**
 * Forget one conversation's tool trace. Returns the number of rows deleted.
 *
 * SCOPED BY AGENT AND MANDATORY, for the identical reason
 * deleteConversationMessages is: one conversation_key can hold rows under both
 * personas, and an unscoped delete would take the spared one's trace with it.
 * There is no unscoped form to fall back to.
 *
 * This MUST be called wherever deleteConversationMessages is. A purge that
 * removed a customer's words and left the tool calls behind would leave their
 * product questions, their name and whatever a save_lead captured sitting in a
 * table the operator believes they cleared — the failure that matters most
 * here, since these are third parties under Ley 1581 (DEUDA #7).
 */
export function deleteConversationToolCalls(
  db: DB,
  conversationKey: string,
  agentId: string,
): number {
  return db
    .prepare(`DELETE FROM conversation_tool_calls WHERE conversation_key = ? AND agent_id = ?`)
    .run(conversationKey, agentId).changes;
}

// --- Handoff ------------------------------------------------------------------

// When a human has taken over a conversation and the agent must be silent.
//
// The sales agent captures a lead, tells the customer a team member will follow
// up, and then keeps answering — because nothing told it to stop. These are
// what tell it. See the conversation_handoff block in db.ts for why the state
// is a row with a lifetime rather than a boolean column.

export interface Handoff {
  id: number;
  conversation_key: string;
  agent_id: string;
  paused_at: string;
  /** The phone behind the admin session that paused it. Attribution, not authorisation. */
  paused_by: string;
  reason: string | null;
  /**
   * The lead whose takeover caused this pause, or NULL when a human paused the
   * conversation directly.
   *
   * This is the ONLY thing that distinguishes the two, and the distinction is
   * what lets handing a lead back hand its conversation back without also
   * undoing a pause somebody set by hand for a reason no lead knows about.
   */
  lead_id: number | null;
  released_at: string | null;
  released_by: string | null;
}

/**
 * Is this conversation currently handled by a human?
 *
 * CALLED ON EVERY INBOUND BATCH, before the turn — so it is the hottest read in
 * this module after the claim itself, and `idx_conversation_handoff_live` is
 * what makes it an index lookup rather than a scan of every handoff ever.
 *
 * Scoped by agent like everything else over a conversation: pausing somebody's
 * sales thread must not silence the same person's owner thread.
 */
export function isConversationPaused(db: DB, conversationKey: string, agentId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM conversation_handoff
       WHERE conversation_key = ? AND agent_id = ? AND released_at IS NULL
       LIMIT 1`,
    )
    .get(conversationKey, agentId);
  return row !== undefined;
}

/**
 * Hand a conversation to a human. Returns the live handoff — the existing one
 * when it was already paused.
 *
 * IDEMPOTENT, and that is not a convenience. Two admins opening the same thread
 * and both hitting pause is ordinary, and a second row would make "released"
 * ambiguous: releasing would close one and leave the conversation paused by the
 * other, with the console showing it as live. One immediate transaction so the
 * check and the insert see one state — the same reasoning as every other
 * read-then-write in this codebase.
 *
 * `leadId` NAMES THE CAUSE, and the idempotency above means it is recorded only
 * when this call is the one that creates the pause. Taking a lead over a
 * conversation a human already paused by hand keeps that pause exactly as it
 * was, NULL cause included — so handing the lead back later will not release
 * something the lead never caused.
 */
export function pauseConversation(
  db: DB,
  input: {
    conversationKey: string;
    agentId: string;
    pausedBy: string;
    reason?: string;
    leadId?: number | null;
  },
): Handoff {
  const pause = db.transaction((): Handoff => {
    const existing = db
      .prepare(
        `SELECT * FROM conversation_handoff
         WHERE conversation_key = ? AND agent_id = ? AND released_at IS NULL
         ORDER BY id ASC LIMIT 1`,
      )
      .get(input.conversationKey, input.agentId) as Handoff | undefined;
    if (existing) return existing;

    const info = db
      .prepare(
        `INSERT INTO conversation_handoff (conversation_key, agent_id, paused_by, reason, lead_id)
         VALUES (@conversation_key, @agent_id, @paused_by, @reason, @lead_id)`,
      )
      .run({
        conversation_key: input.conversationKey,
        agent_id: input.agentId,
        paused_by: input.pausedBy,
        reason: input.reason ?? null,
        lead_id: input.leadId ?? null,
      });
    return db
      .prepare(`SELECT * FROM conversation_handoff WHERE id = ?`)
      .get(info.lastInsertRowid) as Handoff;
  });
  return pause.immediate();
}

/**
 * Give the conversation back to the agent. Returns how many handoffs closed —
 * 0 when it was not paused.
 *
 * Closes EVERY live row for the pair, not just the newest. A second row should
 * be impossible (pauseConversation is idempotent), but if one ever exists,
 * leaving it open would mean a release that reports success and changes
 * nothing — the agent still silent, the console showing it live, and nobody
 * able to tell why.
 */
export function releaseConversation(
  db: DB,
  input: { conversationKey: string; agentId: string; releasedBy: string },
): number {
  return db
    .prepare(
      `UPDATE conversation_handoff
       SET released_at = datetime('now'), released_by = @released_by
       WHERE conversation_key = @conversation_key AND agent_id = @agent_id
         AND released_at IS NULL`,
    )
    .run({
      conversation_key: input.conversationKey,
      agent_id: input.agentId,
      released_by: input.releasedBy,
    }).changes;
}

/**
 * The live handoff for one conversation, or null.
 *
 * `isConversationPaused` answers the hot yes/no on every inbound batch; this
 * one is for the caller that needs to know WHY it is paused — specifically
 * whether a lead caused it — before deciding to release it.
 */
export function getLiveHandoff(db: DB, conversationKey: string, agentId: string): Handoff | null {
  const row = db
    .prepare(
      `SELECT * FROM conversation_handoff
       WHERE conversation_key = ? AND agent_id = ? AND released_at IS NULL
       ORDER BY id ASC LIMIT 1`,
    )
    .get(conversationKey, agentId) as Handoff | undefined;
  return row ?? null;
}

/**
 * How many leads from this conversation a human is still holding.
 *
 * LEADS ARE NOT ONE-TO-ONE WITH CONVERSATIONS. One exchange routinely produces
 * several — a restock notice and a follow-up, or three products in one chat —
 * so handing ONE of them back says nothing about whether the agent may have the
 * conversation. This is the question that does, and `excludeLeadId` takes the
 * lead being moved out of its own count: the caller asks it AFTER the status
 * write, so without the exclusion a lead being closed would still be counted
 * against itself only when the write happened to leave it in_progress.
 */
export function countLeadsHolding(
  db: DB,
  input: { conversationKey: string; agentId: string; excludeLeadId?: number },
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM leads
       WHERE conversation_key = ? AND agent_id = ? AND status = 'in_progress' AND id IS NOT ?`,
    )
    .get(input.conversationKey, input.agentId, input.excludeLeadId ?? null) as { n: number };
  return row.n;
}

/**
 * The same count for every conversation at once, keyed by `conversation_key`
 * and `agent_id` joined with a NUL — one query for a whole page of leads
 * instead of one per row.
 */
export function countLeadsHoldingByConversation(db: DB): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT conversation_key, agent_id, COUNT(*) AS n FROM leads
       WHERE status = 'in_progress' AND conversation_key IS NOT NULL AND agent_id IS NOT NULL
       GROUP BY conversation_key, agent_id`,
    )
    .all() as { conversation_key: string; agent_id: string; n: number }[];
  return new Map(rows.map((row) => [`${row.conversation_key}\u0000${row.agent_id}`, row.n]));
}

/** Every conversation a human currently holds, oldest pause first. */
export function listPausedConversations(db: DB): Handoff[] {
  return db
    .prepare(
      `SELECT * FROM conversation_handoff WHERE released_at IS NULL ORDER BY paused_at ASC`,
    )
    .all() as Handoff[];
}

/** One conversation's handoff history, newest first — the traceability an audit asks for. */
export function listConversationHandoffs(
  db: DB,
  conversationKey: string,
  agentId: string,
): Handoff[] {
  return db
    .prepare(
      `SELECT * FROM conversation_handoff
       WHERE conversation_key = ? AND agent_id = ?
       ORDER BY paused_at DESC, id DESC`,
    )
    .all(conversationKey, agentId) as Handoff[];
}

/**
 * Forget one conversation's handoff history. Returns the number of rows.
 *
 * Deleted with the words and the tool trace, for the same reason and at the
 * same call sites: `paused_by` and `reason` are notes a human wrote ABOUT a
 * named customer, so a purge that left them behind would report that person
 * forgotten while a record of them sat in a third table.
 */
export function deleteConversationHandoffs(
  db: DB,
  conversationKey: string,
  agentId: string,
): number {
  return db
    .prepare(`DELETE FROM conversation_handoff WHERE conversation_key = ? AND agent_id = ?`)
    .run(conversationKey, agentId).changes;
}

// --- Pending media ----------------------------------------------------------

export function addPendingMedia(
  db: DB,
  media: {
    phone: string;
    file_path: string;
    public_path: string;
    caption?: string | null;
    /** WhatsApp's own send timestamp (unix seconds), when the transport has one. */
    sent_at?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO pending_media (phone, file_path, public_path, caption, sent_at)
     VALUES (@phone, @file_path, @public_path, @caption, @sent_at)`,
  ).run({
    phone: media.phone,
    file_path: media.file_path,
    public_path: media.public_path,
    caption: media.caption ?? null,
    sent_at: media.sent_at ?? null,
  });
}

export interface PendingMedia {
  id: number;
  phone: string;
  file_path: string;
  public_path: string;
  caption: string | null;
}

/**
 * Delete un-uploaded pending media older than the given age, removing both the
 * DB rows and the files on disk. Keeps stored inbound media from growing without
 * bound. Returns the number of rows deleted.
 */
export function deleteStalePendingMedia(db: DB, olderThanHours: number): number {
  const rows = db
    .prepare(
      `SELECT id, file_path FROM pending_media
       WHERE attached_to IS NULL AND received_at < datetime('now', ?)`,
    )
    .all(`-${olderThanHours} hours`) as { id: number; file_path: string }[];
  if (rows.length === 0) return 0;

  for (const row of rows) {
    try {
      unlinkSync(row.file_path);
    } catch {
      // File may already be gone; deleting the row is what matters.
    }
  }
  const del = db.prepare(`DELETE FROM pending_media WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) del.run(row.id);
  });
  tx();
  return rows.length;
}

/**
 * This phone's photos that have not been uploaded to a product yet, oldest
 * first.
 *
 * Send order IS listing order — the first photo becomes the product's cover —
 * so the ordering here is load-bearing, and the two transports establish it
 * differently. The bridge's outbox delivers a burst strictly sequentially, so
 * arrival order (received_at, id) is send order. The Cloud API gives no
 * ordering guarantee at all: Meta may deliver a burst's webhooks concurrently
 * and out of order, so sent_at — WhatsApp's own stamp on the message — leads,
 * and arrival order only breaks its ties.
 *
 * COALESCE, not a branch: bridge rows carry no sent_at, so they all collapse to
 * 0 and sort exactly as they always did. That tie-break also carries the
 * Cloud API's weak spot — sent_at has second resolution, and photos shot inside
 * one second fall back to the order they happened to arrive in.
 *
 * Deliberately does NOT mark anything: the upload can fail halfway, and a row
 * claimed before the network call would leave photos that never reached Shopify
 * looking like they had. markPendingMediaAttached is called after, with only
 * the ids that actually landed.
 */
export function listPendingMedia(db: DB, phone: string): PendingMedia[] {
  return db
    .prepare(
      `SELECT id, phone, file_path, public_path, caption
       FROM pending_media
       WHERE phone = ? AND attached_to IS NULL
       ORDER BY COALESCE(sent_at, 0) ASC, received_at ASC, id ASC`,
    )
    .all(phone) as PendingMedia[];
}

/**
 * Record that these photos reached a Shopify product, so the housekeeping sweep
 * stops treating them as unclaimed and their files survive the TTL.
 */
export function markPendingMediaAttached(db: DB, ids: number[], productGid: string): void {
  const mark = db.prepare(
    `UPDATE pending_media SET attached_to = ?, attached_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) mark.run(productGid, id);
  });
  tx();
}
