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
}

export function insertLead(db: DB, input: LeadInput): Lead {
  const info = db
    .prepare(
      `INSERT INTO leads (phone, product_code, type, name, note)
       VALUES (@phone, @product_code, @type, @name, @note)`,
    )
    .run({
      phone: input.phone,
      product_code: input.product_code ?? null,
      type: input.type,
      name: input.name ?? null,
      note: input.note ?? null,
    });
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(Number(info.lastInsertRowid)) as Lead;
}

export function listLeads(db: DB, sinceDays?: number): Lead[] {
  if (sinceDays !== undefined) {
    return db
      .prepare(
        `SELECT * FROM leads WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC`,
      )
      .all(`-${sinceDays} days`) as Lead[];
  }
  return db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all() as Lead[];
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
 * Get the resumable agent session for a phone. When maxAgeDays is given,
 * sessions idle longer than that are treated as expired (returns undefined) so
 * long-lived contacts start a fresh conversation instead of dragging months of
 * history — and cost — into every turn.
 */
export function getSessionId(db: DB, phone: string, maxAgeDays?: number): string | undefined {
  const row = (
    maxAgeDays !== undefined
      ? db
          .prepare(
            `SELECT agent_session_id FROM sessions
             WHERE phone = ? AND updated_at >= datetime('now', ?)`,
          )
          .get(phone, `-${maxAgeDays} days`)
      : db.prepare(`SELECT agent_session_id FROM sessions WHERE phone = ?`).get(phone)
  ) as { agent_session_id: string | null } | undefined;
  return row?.agent_session_id ?? undefined;
}

/**
 * Every stored session, regardless of age. Deliberately unfiltered, unlike
 * getSessionId: the callers are housekeeping and the purge tool, and a session
 * too old to RESUME still owns a transcript on disk that must not be swept as
 * an orphan until its row is actually gone.
 */
export function listSessions(db: DB): { phone: string; agent_session_id: string }[] {
  return db
    .prepare(
      `SELECT phone, agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL`,
    )
    .all() as { phone: string; agent_session_id: string }[];
}

/**
 * Forget a phone's stored session id. Used when the SDK cannot resume it — the
 * transcript is gone, so keeping the id only guarantees the next turn fails the
 * same way (a replayed inbox row would resume the same dead session).
 */
export function clearSessionId(db: DB, phone: string): void {
  db.prepare(`DELETE FROM sessions WHERE phone = ?`).run(phone);
}

export function setSessionId(db: DB, phone: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (phone, agent_session_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET
       agent_session_id = excluded.agent_session_id,
       updated_at = excluded.updated_at`,
  ).run(phone, sessionId);
}

// --- Inbox (at-least-once message processing) --------------------------------

export type InboxStatus = "pending" | "processing" | "done" | "failed";

/**
 * What the worker must do with a row's media_ref. Explicit rather than derived
 * from `kind`: a voice note is persisted as kind='text' (see db.ts), so reading
 * intent off `kind` would couple this to a rule stated in another file.
 */
export type InboxMediaKind = "photo" | "audio";

export interface InboxRow {
  id: number;
  dedupe_key: string;
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
  },
): InboxRow | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO inbox
         (dedupe_key, phone, agent_text, kind, audio_path,
          media_ref, media_kind, media_mime, media_name, media_sent_at)
       VALUES
         (@dedupe_key, @phone, @agent_text, @kind, @audio_path,
          @media_ref, @media_kind, @media_mime, @media_name, @media_sent_at)`,
    )
    .run({
      kind: "text",
      audio_path: null,
      media_ref: null,
      media_kind: null,
      media_mime: null,
      media_name: null,
      media_sent_at: null,
      ...input,
    });
  if (info.changes === 0) return null;
  return getInboxRow(db, Number(info.lastInsertRowid));
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
 * Claim every un-settled row for a phone as ONE batch: 'pending' rows plus
 * 'processing' rows a previous process crashed on. Marking them in a single
 * transaction keeps at-least-once intact — a crash mid-batch leaves them
 * 'processing', so listReplayableInbox picks the whole burst up again on boot.
 *
 * Ordered by arrival (received_at is only second-resolution, so id breaks ties)
 * because the joined prompt has to read in the order the user typed it.
 *
 * Callers MUST run this inside the phone's queue: serialization is what stops
 * two batches from claiming the same rows.
 */
export function claimInboxBatch(db: DB, phone: string): InboxRow[] {
  const select = db.prepare(
    `SELECT * FROM inbox
     WHERE phone = ? AND status IN ('pending','processing')
     ORDER BY received_at ASC, id ASC`,
  );
  const claim = db.prepare(
    `UPDATE inbox SET status = 'processing', attempts = attempts + 1 WHERE id = ?`,
  );
  // Read and claim share one transaction, so the batch is atomic even if a
  // future caller ever violates the per-phone-queue invariant above.
  const tx = db.transaction((): InboxRow[] => {
    const rows = select.all(phone) as InboxRow[];
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
