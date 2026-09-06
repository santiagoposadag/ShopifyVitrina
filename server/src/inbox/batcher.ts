import { unlink } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../data/db.js";
import type { PerConversationQueue } from "./queue.js";
import {
  addPendingMedia,
  claimInboxBatch,
  clearInboxMedia,
  listReplayableInbox,
  markInboxBatchDone,
  markInboxBatchFailed,
  markInboxBatchPending,
  setInboxAudioPath,
  setInboxTranscript,
  type InboxRow,
} from "../data/repo.js";
import type { MessageKind, Role, TurnContext } from "../types.js";
import { agentPrincipal, whatsappPrincipal, type Envelope } from "./envelope.js";

/**
 * Total processing attempts a batch's rows get before settling as 'failed'.
 * Counted via inbox.attempts, which claimInboxBatch increments — so attempts
 * survive restarts, and boot-replay of 'processing' rows counts against the
 * same cap (a poison message cannot crash-loop forever).
 */
export const MAX_BATCH_ATTEMPTS = 3;

/**
 * Fixed delay before a failed batch is retried. Deliberately a constant, not
 * config: with only 2 retries ever, backoff escalation buys nothing, and a new
 * env var is not worth its surface for a pilot. 30s is long enough to ride out
 * a transient API blip and short enough that the customer plausibly still cares.
 */
export const RETRY_DELAY_MS = 30_000;

/**
 * How an uncaptioned photo is announced to the agent, which never sees the image
 * itself. A burst of 10 would otherwise repeat this line 10 times — noise the
 * model tends to answer literally — so buildBatchText collapses runs into a
 * single counted line.
 */
export const PHOTO_PLACEHOLDER = "(El usuario envió una foto)";

function photoLine(count: number): string {
  return count === 1 ? PHOTO_PLACEHOLDER : `(El usuario envió ${count} fotos)`;
}

/** The fields buildBatchText needs from a claimed inbox row. */
export interface BatchRow {
  agent_text: string;
  kind: MessageKind;
}

/**
 * Join one phone's coalesced messages into a single prompt. Rows arrive in
 * arrival order; empty ones (non-media, non-text events) contribute nothing.
 *
 * Photos are recognised by their persisted `kind`, NEVER by their text. WhatsApp
 * stores a photo's caption as that message's text, so matching the placeholder
 * wording counted only uncaptioned photos: an owner who captioned every photo of
 * a listing produced a batch that read as plain chat, the agent was never told a
 * single image had arrived, and the files sat unattached in pending_media.
 */
export function buildBatchText(rows: BatchRow[]): string {
  const lines: string[] = [];
  let photos = 0;
  let captions: string[] = [];
  const flushPhotos = (): void => {
    if (photos > 0) lines.push(photoLine(photos), ...captions);
    photos = 0;
    captions = [];
  };

  for (const row of rows) {
    const trimmed = row.agent_text.trim();
    // Rows written before `kind` existed default to 'text' and carry the
    // placeholder as their wording; keep reading those as the photos they were.
    if (row.kind === "media" || trimmed === PHOTO_PLACEHOLDER) {
      photos += 1;
      // The caption describes the image ("Vestier alcoba principal") and is the
      // only thing the agent can learn from it — keep it, grouped with its run.
      if (trimmed.length > 0 && trimmed !== PHOTO_PLACEHOLDER) captions.push(trimmed);
      continue;
    }
    if (trimmed.length === 0) continue;
    flushPhotos();
    lines.push(trimmed);
  }
  flushPhotos();

  return lines.join("\n");
}

/**
 * What the agent reads when a voice note could not be turned into words —
 * because no provider is configured, the file was lost, or the API refused.
 *
 * A line rather than nothing, and this is the crux of the bug this feature
 * fixes: an empty batch is settled `done` WITHOUT running the agent, so an
 * untranscribable voice note would reproduce the original silence exactly. The
 * person gets an answer either way; only its usefulness varies.
 */
export const AUDIO_FALLBACK =
  "(El usuario envió una nota de voz que no se pudo transcribir. Pídele amablemente que escriba su mensaje.)";

export type { MessageKind };

/**
 * Fetching and storing one inbound file, as the batcher needs it.
 *
 * A narrow port rather than the WhatsAppChannel plus the Config, for the reason
 * the rest of this module takes plain functions: the whole resolve step is then
 * testable against an object literal, with no HTTP client, no paired device and
 * no casts. index.ts is the only place that knows which transport is behind it.
 */
export interface InboundMediaStore {
  /** Fetch the bytes a transport reference points at. */
  download(ref: string): Promise<Buffer>;
  /** Persist an owner's product photo where attach_pending_photos will find it. */
  savePhoto(
    buffer: Buffer,
    opts: { mimeType?: string; suggestedName?: string },
  ): Promise<{ filePath: string; publicPath: string }>;
  /** Persist a voice note OUTSIDE the publicly served media directory. */
  saveAudio(buffer: Buffer, opts: { suggestedName?: string }): Promise<{ filePath: string }>;
  /** Ceiling above which a voice note is dropped rather than sent for transcription. */
  maxAudioBytes: number;
}

export interface InboxBatcherDeps {
  db: DB;
  queue: PerConversationQueue;
  /** Only the level the batcher uses — a failed batch is already handled. */
  log: Pick<FastifyBaseLogger, "error" | "info">;
  /** Silence, in ms, that ends a text-only burst. Every message resets it. */
  debounceMs: number;
  /** Ceiling, in ms, from the first un-flushed message. Rescues a non-stop talker. */
  maxWaitMs: number;
  /** Silence that ends a burst containing media. See PhoneBurst.hasMedia. */
  mediaDebounceMs: number;
  /** Ceiling for a burst containing media. */
  mediaMaxWaitMs: number;
  /**
   * Async worker invoked once per coalesced burst.
   *
   * Two arguments, and they are not the same thing. The ENVELOPE is what the
   * door produced: who is asking, which agent must answer, which conversation,
   * what they said, and the turn key — all of it immutable, and all of it the
   * only identity a caller may act on. The CONTEXT is the per-turn scratch space
   * the runtime and its tools share, and it is MUTABLE by design:
   * `sessionAfterTurn` is written by a tool mid-turn and read after it, so it is
   * turn state and not envelope data, and folding it into the envelope would
   * make a message-shaped record something a tool writes into.
   *
   * They overlap on the identity fields today, deliberately: the runtime still
   * takes a TurnContext. The router that arrives with agent definitions is what
   * collapses the two — it will build the context FROM the envelope plus the
   * role it resolves, and this pair becomes one argument and one derivation.
   */
  onMessage: (envelope: Envelope, ctx: TurnContext) => Promise<void>;
  /**
   * phone → role → which agent answers, in ONE call (router.ts).
   *
   * One dependency rather than two, because the two halves are one decision:
   * a caller that could supply a role and a mapping separately could make them
   * disagree, and the disagreement would be a person routed to the assistant
   * their role does not belong to.
   *
   * Asked about a PHONE and nothing else: an agent caller has none, and its
   * target agent is stamped on the row by the door that authenticated it (see
   * identify below, and TurnContext for why its role is absent, not defaulted).
   */
  route: (phone: string) => { role: Role; agentId: string };
  /**
   * Turn a stored voice note into words. Optional: with no transcription
   * provider configured, audio rows fall back to a reply asking for text.
   *
   * Lives here rather than in the webhook because the bridge's outbox is
   * strictly sequential — a speech API call in the handler stalls every message
   * queued behind it. Returning null means "could not", and the caller must
   * still produce SOMETHING for the agent to answer.
   */
  transcribeAudio?: (filePath: string) => Promise<string | null>;
  /**
   * Fetches the files the webhook only made a note of. Optional so a caller with
   * no media concern (and every test that has none) needs nothing; rows carrying
   * a media_ref simply keep it, and the agent answers without the attachment.
   */
  media?: InboundMediaStore;
  /**
   * Invoked after a batch attempt fails, on EVERY attempt. `final` is true when
   * the batch just settled as 'failed' (retry budget exhausted) — user-facing
   * side effects like an apology belong behind `final`; monitoring (failure
   * streak alerting) may count every attempt. Optional so tests and callers
   * without side effects need nothing. Awaited, but never allowed to throw.
   */
  onBatchFailure?: (
    ctx: TurnContext,
    info: { final: boolean; attempts: number; error: unknown },
  ) => Promise<void>;
}

interface PhoneBurst {
  silence: ReturnType<typeof setTimeout>;
  cap: ReturnType<typeof setTimeout>;
  /**
   * Sticky for the life of the burst: WhatsApp delivers a photo set in waves,
   * and a text message landing between two waves must not shrink the window
   * back down and split the upload in half.
   */
  hasMedia: boolean;
  /** When this burst opened. The cap is measured from here, even after an upgrade. */
  startedAt: number;
}

/**
 * Coalesces a phone's inbound messages into ONE agent turn per conversational
 * burst. People type the way they talk — a listing arrives as a dozen separate
 * WhatsApp messages — and one turn per message meant a dozen sequential Claude
 * calls, each seeing only a fragment of what the owner was saying.
 *
 * Debouncing lives here, on the async worker path, NEVER in the HTTP handler:
 * Kapso's webhook has a 10s ACK deadline that an 8s wait would eat.
 *
 * The window is adaptive because text and photos arrive at different speeds. A
 * measured burst of one property (37 photos, ~30 messages) came in two waves 32
 * SECONDS apart while WhatsApp uploaded them — far past any window that keeps
 * chat feeling responsive — so it split into two batches and the owner got two
 * replies for one action. A burst carrying media therefore waits much longer.
 * The tradeoff is real and deliberate: an owner sending photos now waits up to
 * mediaDebounceMs of silence before any reply. That is the price of not
 * splitting one action into two conversations; text-only chat is unaffected.
 */
export class InboxBatcher {
  private readonly timers = new Map<string, PhoneBurst>();

  /**
   * Delayed re-flush timers for failed batches, one per phone — separate from
   * the burst timers because a retry must fire even though no burst is open.
   */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: InboxBatcherDeps) {}

  /**
   * Note that a phone has a new un-flushed message. Restarts its silence timer
   * and, on the first message of a burst, arms the hard cap. Cheap and
   * synchronous — safe to call from the webhook request path.
   */
  schedule(phone: string, kind: MessageKind = "text"): void {
    const existing = this.timers.get(phone);
    if (existing) {
      // The burst continues: the silence window always restarts. The cap does
      // not — except when media upgrades this burst to the longer budget.
      const upgraded = kind === "media" && !existing.hasMedia;
      if (upgraded) existing.hasMedia = true;
      clearTimeout(existing.silence);
      existing.silence = this.armSilence(phone, existing.hasMedia);
      if (upgraded) {
        clearTimeout(existing.cap);
        // Still measured from the burst's first message, not from now.
        const elapsed = Date.now() - existing.startedAt;
        existing.cap = this.armCap(phone, Math.max(0, this.deps.mediaMaxWaitMs - elapsed));
      }
      return;
    }
    const hasMedia = kind === "media";
    this.timers.set(phone, {
      silence: this.armSilence(phone, hasMedia),
      cap: this.armCap(phone, hasMedia ? this.deps.mediaMaxWaitMs : this.deps.maxWaitMs),
      hasMedia,
      startedAt: Date.now(),
    });
  }

  /**
   * Run one conversation's un-settled rows NOW, with no debounce, and resolve
   * when the turn has settled them.
   *
   * The agent door's entry point. Debouncing is a human behaviour — a person
   * types a listing as a dozen messages — and an agent sends one complete
   * message, so making it wait out a silence window would add seconds to every
   * call for nothing (§2.6). Everything else is unchanged: the row went through
   * the same inbox, this claim increments the same attempts counter, and the
   * batch settles done/failed exactly as a WhatsApp burst does.
   *
   * Through the SAME queue, so the one-turn-at-a-time invariant holds across
   * both doors: a replayed row and a live call for one conversation cannot
   * overlap, which is what claimInboxBatch depends on.
   */
  deliverNow(conversationKey: string): Promise<void> {
    return this.deps.queue.enqueue(conversationKey, () => this.processBatch(conversationKey));
  }

  /**
   * Re-enqueue rows a previous process accepted but never finished. Call once on
   * boot, BEFORE listening, so replayed messages enter each conversation's queue
   * ahead of new traffic and per-conversation ordering holds. Rows coalesce per
   * conversation exactly like live traffic. Returns the number of rows found.
   *
   * Two doors, two ways in, and the difference is the debounce: a WhatsApp
   * conversation opens a burst window (more of the person's messages may be on
   * their way), while an agent row is run immediately — nothing is following it,
   * and its caller is a request that has been waiting since before the crash.
   */
  replayPending(): number {
    const rows = listReplayableInbox(this.deps.db);
    const conversations = new Map<string, boolean>();
    for (const row of rows) {
      // Sticky per conversation: one agent-door row makes the whole
      // conversation immediate, and the two never mix (an 'a2a:' key cannot be
      // a phone).
      conversations.set(
        row.conversation_key,
        (conversations.get(row.conversation_key) ?? false) || row.principal_kind === "agent",
      );
    }
    for (const [conversationKey, immediate] of conversations) {
      // Scheduled as "text" even for photo bursts: these rows are ALREADY
      // persisted, so there is no upload wave still in flight to wait for. The
      // window only has to cover messages still arriving — and if more photos do
      // land, their schedule() call upgrades the burst.
      if (immediate) void this.deliverNow(conversationKey);
      else this.schedule(conversationKey, "text");
    }
    if (rows.length > 0) this.deps.log.info(`Replaying ${rows.length} unfinished inbox message(s)`);
    return rows.length;
  }

  /**
   * Drop every pending timer, retries included. Un-flushed and retry-pending
   * rows stay 'pending' and are replayed on next boot — which is exactly how
   * retries survive a restart.
   */
  stop(): void {
    for (const timers of this.timers.values()) {
      clearTimeout(timers.silence);
      clearTimeout(timers.cap);
    }
    this.timers.clear();
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
  }

  /** Phones with a burst waiting to flush. */
  get pendingPhones(): number {
    return this.timers.size;
  }

  private armSilence(phone: string, hasMedia: boolean): ReturnType<typeof setTimeout> {
    const ms = hasMedia ? this.deps.mediaDebounceMs : this.deps.debounceMs;
    return setTimeout(() => this.flush(phone), ms);
  }

  private armCap(phone: string, ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.flush(phone), ms);
  }

  /**
   * Fetch the files the webhook deliberately did not, and retire their refs.
   *
   * This is the whole point of media_ref. Downloading inside the request handler
   * put one or two network round trips per message between Meta and its 200 —
   * and one Cloud API POST can carry a whole photo burst, so an owner's listing
   * could hold the response open for minutes. Meta retries a slow webhook and
   * eventually disables the subscription; the bridge, whose outbox is strictly
   * sequential, simply stalls every message queued behind it. Here, on the
   * worker, the same fetch costs a burst nothing but the debounce window it was
   * already waiting out.
   *
   * Runs BEFORE resolveAudio: a voice note cannot be transcribed until its bytes
   * are on disk.
   *
   * Sequential, and that is load-bearing for photos. Arrival order is listing
   * order and the first photo becomes the product's cover, so a concurrent map
   * would upload the same set in a silently shuffled gallery — the same reason
   * uploadProductPhotos is sequential on the Shopify side.
   *
   * Never throws: a message still deserves an answer without its attachment,
   * which is exactly what the webhook did when it owned this work.
   */
  private async resolveMedia(rows: InboxRow[]): Promise<void> {
    const { db, log, media } = this.deps;
    if (!media) return;

    for (const row of rows) {
      if (!row.media_ref) continue;
      const ref = row.media_ref;
      try {
        const buffer = await media.download(ref);

        if (row.media_kind === "audio") {
          if (buffer.byteLength > media.maxAudioBytes) {
            log.error(
              { phone: row.phone, inboxId: row.id, bytes: buffer.byteLength },
              "inbound audio too large to transcribe; dropping the audio",
            );
            this.giveUpOnAudio(row);
            continue;
          }
          const saved = await media.saveAudio(buffer, {
            suggestedName: row.media_name ?? undefined,
          });
          // One statement: the bytes are ours now, so the transport reference is
          // spent. A retried batch must not fetch this file a second time.
          setInboxAudioPath(db, row.id, saved.filePath);
          // Mutated in place because resolveAudio reads these same row objects.
          row.audio_path = saved.filePath;
          row.media_ref = null;
          continue;
        }

        const saved = await media.savePhoto(buffer, {
          mimeType: row.media_mime ?? undefined,
          suggestedName: row.media_name ?? undefined,
        });
        addPendingMedia(db, {
          phone: row.phone,
          file_path: saved.filePath,
          public_path: saved.publicPath,
          // Only what the owner actually wrote about this photo, or nothing.
          caption: row.agent_text.trim() || null,
          // What orders the gallery when the transport does not order delivery.
          sent_at: row.media_sent_at,
        });
        clearInboxMedia(db, row.id);
        row.media_ref = null;
      } catch (err) {
        // The message still reaches the agent — it just arrives without its file.
        // The ref is cleared rather than left for the next attempt: the webhook
        // never retried a lost photo either, and a dead fetch re-attempted on
        // every remaining attempt only makes the person wait longer for an
        // answer the attachment was never required for.
        log.error({ err, phone: row.phone, inboxId: row.id }, "inbound media not stored");
        if (row.media_kind === "audio") this.giveUpOnAudio(row);
        else {
          clearInboxMedia(db, row.id);
          row.media_ref = null;
        }
      }
    }
  }

  /**
   * Settle a voice note whose words we are never going to get.
   *
   * The fallback LINE is the point, not the cleared reference. A voice note that
   * yields no audio and no transcript leaves a row with empty text, and
   * buildBatchText renders nothing for it — so a batch of one settles `done`
   * WITHOUT an agent turn and the person gets the exact silence AUDIO_FALLBACK
   * exists to prevent. An uncaptioned PHOTO has no such problem: it is kind
   * 'media', which buildBatchText always renders as a photo line.
   *
   * Written through setInboxTranscript because this IS the transcript as far as
   * the rest of the pipeline is concerned: the words we settled for. Clearing
   * media_ref in the same breath keeps a retried batch from re-fetching it.
   */
  private giveUpOnAudio(row: InboxRow): void {
    setInboxTranscript(this.deps.db, row.id, AUDIO_FALLBACK);
    clearInboxMedia(this.deps.db, row.id);
    // Mutated in place because buildBatchText reads these same row objects.
    row.agent_text = AUDIO_FALLBACK;
    row.audio_path = null;
    row.media_ref = null;
  }

  /**
   * Replace every claimed voice note with its transcript, in place.
   *
   * The transcript is written back to the row as it is produced, which is what
   * makes a retry cheap: a batch that fails downstream is claimed again, and
   * without the write-back every attempt would re-upload and re-bill the same
   * seconds of speech. Clearing audio_path in the same statement is the marker
   * that this audio has already been paid for.
   *
   * Sequential rather than concurrent. A burst of voice notes is rare, the
   * per-phone queue already serialises turns, and parallelism here could hit
   * provider rate limits during exactly the bursts that need to succeed.
   */
  private async resolveAudio(rows: InboxRow[]): Promise<void> {
    const { db, log, transcribeAudio } = this.deps;

    for (const row of rows) {
      if (!row.audio_path) continue;

      const path = row.audio_path;
      let transcript: string | null = null;
      try {
        transcript = transcribeAudio ? await transcribeAudio(path) : null;
      } catch (err) {
        // A failed transcription must never fail the batch: the message still
        // deserves an answer, and the fallback below is that answer.
        log.error({ err, phone: row.phone, inboxId: row.id }, "transcription failed");
      }

      const text = transcript?.trim() || AUDIO_FALLBACK;
      setInboxTranscript(db, row.id, text);
      // Mutated in place because buildBatchText reads these same row objects.
      row.agent_text = text;
      row.audio_path = null;

      if (transcript) {
        log.info(
          { phone: row.phone, inboxId: row.id, chars: text.length },
          "voice note transcribed",
        );
      }

      // Unlinked whether or not the words were recovered. Clearing audio_path
      // above already made this file unreachable — nothing will ever read it
      // again — so keeping it on failure would leak one file per failed voice
      // note, forever. Someone's speech is also not something to hoard.
      await unlink(path).catch(() => undefined);
    }
  }

  /**
   * Close the burst and hand it to the conversation's queue. Clearing the timer
   * state BEFORE enqueuing is what lets messages arriving during the agent turn
   * open the next burst instead of being swallowed by this one.
   *
   * The phone IS the conversation key on this door, so the queue key below is
   * the same string the debounce is tracked under. Debouncing stays per phone
   * on purpose — a burst is how a person types, not a property of the
   * conversation — and the queue is what must never let two batches of one
   * conversation overlap.
   */
  private flush(phone: string): void {
    const timers = this.timers.get(phone);
    if (!timers) return;
    clearTimeout(timers.silence);
    clearTimeout(timers.cap);
    this.timers.delete(phone);
    // Through the queue: batches for one conversation must never overlap, and
    // claimInboxBatch relies on exactly that. Others stay concurrent.
    void this.deps.queue.enqueue(phone, () => this.processBatch(phone));
  }

  /**
   * Arm a delayed re-flush for a conversation whose batch just failed. When it
   * fires, an OPEN burst for that conversation wins: its own flush will claim
   * the pending retry rows together with the new messages, and firing here too
   * would steal the burst's rows before its window closed. If the burst already
   * flushed everything, the claim returns no rows and this is a no-op. An agent
   * conversation never has a burst, so the retry always fires there.
   */
  private armRetry(conversationKey: string): void {
    // Defensive; the per-conversation queue serializes failures.
    if (this.retries.has(conversationKey)) return;
    this.retries.set(
      conversationKey,
      setTimeout(() => {
        this.retries.delete(conversationKey);
        if (this.timers.has(conversationKey)) return;
        void this.deliverNow(conversationKey);
      }, RETRY_DELAY_MS),
    );
  }

  /**
   * Who this batch is from, which agent must answer it, and how it is answered.
   *
   * Everything here is read from the CLAIMED ROWS, because the rows are what
   * the door persisted after authenticating the sender. Null means the rows
   * cannot be routed at all.
   */
  private identify(rows: InboxRow[]): {
    principal: Envelope["principal"];
    agentId: string;
    phone?: string;
    role?: Role;
    hop: number;
    replyTo?: string;
  } | null {
    const first = rows[0]!;
    if (first.principal_kind === "agent") {
      const callerId = first.principal_id;
      const agentId = first.agent_id;
      if (!callerId || !agentId) return null;
      // The most recent caller's callback wins. Normally there is exactly one
      // row here — the door refuses a second exchange while one is un-settled —
      // so this only decides a case that a future door might create.
      const callbacks = rows.filter((row) => row.reply_to);
      const replyTo = callbacks[callbacks.length - 1]?.reply_to ?? undefined;
      return {
        principal: agentPrincipal(callerId),
        agentId,
        // MAX, not the first row's: the hop bounds a forwarding chain, and a
        // batch that ever merged two messages must be bounded by the longest
        // chain that produced it, not by whichever arrived first. No phone and
        // no role — see TurnContext for why neither is defaulted.
        hop: Math.max(...rows.map((row) => row.hop)),
        ...(replyTo !== undefined ? { replyTo } : {}),
      };
    }
    // The WhatsApp door: the phone is the one the TRANSPORT authenticated,
    // never anything read out of the text, and the conversation key IS that
    // phone. That equality is why this module can go on debouncing per phone
    // while the queue serializes per conversation. Do not "simplify" the two
    // back into one field: a door whose caller has no phone still has
    // conversations.
    const phone = first.phone;
    // Resolved HERE, at flush time, from the phone the door authenticated —
    // never re-derived from anything in the text. The role and the agent come
    // back together so one burst cannot be judged one way and delivered the
    // other.
    const { role, agentId } = this.deps.route(phone);
    return {
      principal: whatsappPrincipal(phone),
      agentId,
      phone,
      role,
      hop: 0,
    };
  }

  /** Best-effort: a failing hook must not break processBatch's never-throws contract. */
  private async notifyFailure(
    ctx: TurnContext,
    info: { final: boolean; attempts: number; error: unknown },
  ): Promise<void> {
    try {
      await this.deps.onBatchFailure?.(ctx, info);
    } catch (err) {
      this.deps.log.error(
        { err, conversationKey: ctx.conversationKey },
        "onBatchFailure hook failed",
      );
    }
  }

  /**
   * Run one coalesced burst through the agent. Never throws — a failed attempt
   * returns the rows to 'pending' and arms a delayed retry until the attempt
   * budget (MAX_BATCH_ATTEMPTS) is spent, then the batch settles as 'failed'.
   */
  private async processBatch(conversationKey: string): Promise<void> {
    const { db, log, onMessage } = this.deps;
    const rows = claimInboxBatch(db, conversationKey);
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    // The FIRST row's dedupe key, not a hash of the whole batch: a retried
    // batch absorbs newer messages, so anything derived from the full set
    // changes between attempts — and the point of this key is to be the SAME
    // on a retry, so Shopify can recognise a replayed stock adjustment. Rows
    // are ordered by arrival and keep their ids, so the anchor holds.
    const turnKey = rows[0]!.dedupe_key;
    // The identity half of this batch, READ BACK OFF THE ROWS the door wrote.
    //
    // That is the whole reason those columns exist. The door is what
    // authenticated the sender — a signature over the raw body, or a bearer
    // token looked up in the registry — and by the time this runs, that proof
    // is gone: the request is over, and a row replayed after a crash has no
    // request at all. Re-deriving identity here from an allowlist or a registry
    // would let a row be answered as somebody it was not admitted as.
    //
    // A WhatsApp row is the exception, deliberately: its target agent is
    // resolved HERE, from the phone, because one burst is many rows and
    // freezing the agent per row would let a burst disagree with itself.
    const identity = this.identify(rows);
    if (!identity) {
      // A row that names an agent principal but no target agent. No door can
      // write one, so this is a hand-edited or corrupted row rather than a
      // transient failure — retrying it would fail identically on every
      // attempt until the cap, three agent-less turns later.
      markInboxBatchFailed(db, ids);
      log.error(
        { conversationKey, inboxIds: ids },
        "inbox batch has no target agent; settling it failed without a turn",
      );
      return;
    }
    const ctx: TurnContext = {
      principal: identity.principal,
      ...(identity.phone !== undefined ? { phone: identity.phone } : {}),
      ...(identity.role !== undefined ? { role: identity.role } : {}),
      agentId: identity.agentId,
      conversationKey,
      turnKey,
      hop: identity.hop,
    };
    // max, not min: a retried batch absorbs fresh rows (attempts = 1), and min
    // would let one poison row pin ever-growing batches forever. Consequence:
    // fresh messages that joined a terminally failing batch die with it —
    // all-or-nothing settling is already this module's contract.
    const attempts = Math.max(...rows.map((row) => row.attempts));
    // The claim above consumed an attempt, so > MAX means the budget was spent
    // by earlier processes that crashed mid-turn (boot-replay loops): settle as
    // failed WITHOUT running the agent, or a poison message would be retried on
    // every boot forever.
    if (attempts > MAX_BATCH_ATTEMPTS) {
      markInboxBatchFailed(db, ids);
      // Abandoning the batch abandons its audio: nothing will ever claim these
      // rows again, so an un-transcribed voice note here would sit on disk
      // forever. Not transcribed first — a poison batch should not be billed.
      await Promise.all(
        rows
          .filter((row) => row.audio_path)
          .map((row) => unlink(row.audio_path!).catch(() => undefined)),
      );
      log.error(
        { conversationKey, inboxIds: ids, attempts },
        "inbox batch exceeded attempt cap; giving up",
      );
      await this.notifyFailure(ctx, {
        final: true,
        attempts,
        error: new Error("attempt cap exceeded"),
      });
      return;
    }

    // Inbound files are fetched HERE, on the worker, not in the webhook — the
    // handler only recorded a reference to them. Before resolveAudio, which
    // needs the bytes on disk to transcribe.
    await this.resolveMedia(rows);

    // Voice notes become words HERE, on the worker, not in the webhook: this is
    // a network call, and the bridge's outbox is strictly sequential.
    await this.resolveAudio(rows);

    const text = buildBatchText(rows);
    // Nothing for the agent to answer (e.g. only unsupported event kinds):
    // settle the rows rather than spending a turn on an empty prompt.
    if (text.length === 0) {
      markInboxBatchDone(db, ids);
      return;
    }

    // The envelope is assembled HERE, at the point the prompt exists, and its
    // identity fields are read off the context so the two cannot drift into
    // disagreeing about who is asking.
    //
    // Identity is settled long before the text is: the attempt-cap branch above
    // abandons a batch that never produced a prompt at all, and it still has to
    // name the conversation it gave up on. So the context is built first and the
    // envelope second, which is the reverse of the order a door with a
    // single-message envelope will use — the agent door has its text from the
    // start and can build the envelope outright.
    const envelope: Envelope = {
      principal: ctx.principal,
      agentId: ctx.agentId,
      conversationKey: ctx.conversationKey,
      text,
      turnKey: ctx.turnKey,
      // Set by the door for an agent caller; a human door starts every chain,
      // so nothing forwarded that message and there is no loop to break yet.
      hop: ctx.hop,
      ...(identity.replyTo !== undefined ? { replyTo: identity.replyTo } : {}),
    };

    try {
      await onMessage(envelope, ctx);
      markInboxBatchDone(db, ids);
    } catch (err) {
      const final = attempts >= MAX_BATCH_ATTEMPTS;
      if (final) {
        markInboxBatchFailed(db, ids);
      } else {
        markInboxBatchPending(db, ids);
        this.armRetry(conversationKey);
      }
      log.error({ err, conversationKey, inboxIds: ids, attempts, final }, "inbox batch failed");
      await this.notifyFailure(ctx, { final, attempts, error: err });
    }
  }
}
