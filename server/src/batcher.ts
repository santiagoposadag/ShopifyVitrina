import type { FastifyBaseLogger } from "fastify";
import type { DB } from "./db.js";
import type { PerPhoneQueue } from "./queue.js";
import {
  claimInboxBatch,
  listReplayableInbox,
  markInboxBatchDone,
  markInboxBatchFailed,
} from "./repo.js";
import type { TurnContext } from "./types.js";

/**
 * Placeholder text stored for an inbound photo with no caption. The agent never
 * sees the image itself, so a burst of 10 photos would otherwise repeat this
 * line 10 times — noise the model tends to answer literally. buildBatchText
 * collapses runs of it into a single counted line.
 */
export const PHOTO_PLACEHOLDER = "(El usuario envió una foto)";

function photoLine(count: number): string {
  return count === 1 ? PHOTO_PLACEHOLDER : `(El usuario envió ${count} fotos)`;
}

/**
 * Join one phone's coalesced messages into a single prompt. Rows arrive in
 * arrival order; empty ones (non-media, non-text events) contribute nothing.
 */
export function buildBatchText(texts: string[]): string {
  const lines: string[] = [];
  let photos = 0;
  const flushPhotos = (): void => {
    if (photos > 0) lines.push(photoLine(photos));
    photos = 0;
  };

  for (const raw of texts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === PHOTO_PLACEHOLDER) {
      photos += 1;
      continue;
    }
    flushPhotos();
    lines.push(trimmed);
  }
  flushPhotos();

  return lines.join("\n");
}

/**
 * Whether an inbound message carried media. The webhook already knows this from
 * the event it parsed, so the batcher is told rather than sniffing agent_text.
 */
export type MessageKind = "text" | "media";

export interface InboxBatcherDeps {
  db: DB;
  queue: PerPhoneQueue;
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
  /** Async worker invoked once per coalesced burst. */
  onMessage: (ctx: TurnContext, text: string) => Promise<void>;
  roleFor: (phone: string) => TurnContext["role"];
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
   * Re-enqueue rows a previous process accepted but never finished. Call once on
   * boot, BEFORE listening, so replayed messages enter each phone's queue ahead
   * of new webhook traffic and per-phone ordering holds. Rows coalesce per phone
   * exactly like live traffic. Returns the number of rows found.
   */
  replayPending(): number {
    const rows = listReplayableInbox(this.deps.db);
    // Scheduled as "text" even for photo bursts: these rows are ALREADY
    // persisted, so there is no upload wave still in flight to wait for. The
    // window only has to cover messages still arriving — and if more photos do
    // land, their schedule() call upgrades the burst.
    for (const phone of new Set(rows.map((row) => row.phone))) this.schedule(phone, "text");
    if (rows.length > 0) this.deps.log.info(`Replaying ${rows.length} unfinished inbox message(s)`);
    return rows.length;
  }

  /** Drop every pending timer. Un-flushed rows stay replayable on next boot. */
  stop(): void {
    for (const timers of this.timers.values()) {
      clearTimeout(timers.silence);
      clearTimeout(timers.cap);
    }
    this.timers.clear();
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
   * Close the burst and hand it to the phone's queue. Clearing the timer state
   * BEFORE enqueuing is what lets messages arriving during the agent turn open
   * the next burst instead of being swallowed by this one.
   */
  private flush(phone: string): void {
    const timers = this.timers.get(phone);
    if (!timers) return;
    clearTimeout(timers.silence);
    clearTimeout(timers.cap);
    this.timers.delete(phone);
    // Through the queue: batches for one phone must never overlap, and the
    // claim below relies on that serialization. Different phones stay concurrent.
    void this.deps.queue.enqueue(phone, () => this.processBatch(phone));
  }

  /**
   * Run one coalesced burst through the agent. Never throws — the batch settles
   * as 'failed' and is logged, matching the old per-row behaviour.
   */
  private async processBatch(phone: string): Promise<void> {
    const { db, log, onMessage, roleFor } = this.deps;
    const rows = claimInboxBatch(db, phone);
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    const text = buildBatchText(rows.map((row) => row.agent_text));
    // Nothing for the agent to answer (e.g. only unsupported event kinds):
    // settle the rows rather than spending a turn on an empty prompt.
    if (text.length === 0) {
      markInboxBatchDone(db, ids);
      return;
    }

    try {
      await onMessage({ phone, role: roleFor(phone) }, text);
      markInboxBatchDone(db, ids);
    } catch (err) {
      markInboxBatchFailed(db, ids);
      log.error({ err, phone, inboxIds: ids }, "inbox batch failed");
    }
  }
}
