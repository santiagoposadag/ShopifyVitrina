import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../data/db.js";
import type { PerPhoneQueue } from "./queue.js";
import {
  claimInboxBatch,
  listReplayableInbox,
  markInboxBatchDone,
  markInboxBatchFailed,
  markInboxBatchPending,
} from "../data/repo.js";
import type { TurnContext } from "../types.js";

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
   * Arm a delayed re-flush for a phone whose batch just failed. When it fires,
   * an OPEN burst for the phone wins: its own flush will claim the pending
   * retry rows together with the new messages, and firing here too would steal
   * the burst's rows before its window closed. If the burst already flushed
   * everything, the claim below returns no rows and this is a no-op.
   */
  private armRetry(phone: string): void {
    if (this.retries.has(phone)) return; // defensive; the per-phone queue serializes failures
    this.retries.set(
      phone,
      setTimeout(() => {
        this.retries.delete(phone);
        if (this.timers.has(phone)) return;
        void this.deps.queue.enqueue(phone, () => this.processBatch(phone));
      }, RETRY_DELAY_MS),
    );
  }

  /** Best-effort: a failing hook must not break processBatch's never-throws contract. */
  private async notifyFailure(
    ctx: TurnContext,
    info: { final: boolean; attempts: number; error: unknown },
  ): Promise<void> {
    try {
      await this.deps.onBatchFailure?.(ctx, info);
    } catch (err) {
      this.deps.log.error({ err, phone: ctx.phone }, "onBatchFailure hook failed");
    }
  }

  /**
   * Run one coalesced burst through the agent. Never throws — a failed attempt
   * returns the rows to 'pending' and arms a delayed retry until the attempt
   * budget (MAX_BATCH_ATTEMPTS) is spent, then the batch settles as 'failed'.
   */
  private async processBatch(phone: string): Promise<void> {
    const { db, log, onMessage, roleFor } = this.deps;
    const rows = claimInboxBatch(db, phone);
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    const ctx: TurnContext = { phone, role: roleFor(phone) };
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
      log.error({ phone, inboxIds: ids, attempts }, "inbox batch exceeded attempt cap; giving up");
      await this.notifyFailure(ctx, {
        final: true,
        attempts,
        error: new Error("attempt cap exceeded"),
      });
      return;
    }

    const text = buildBatchText(rows.map((row) => row.agent_text));
    // Nothing for the agent to answer (e.g. only unsupported event kinds):
    // settle the rows rather than spending a turn on an empty prompt.
    if (text.length === 0) {
      markInboxBatchDone(db, ids);
      return;
    }

    try {
      await onMessage(ctx, text);
      markInboxBatchDone(db, ids);
    } catch (err) {
      const final = attempts >= MAX_BATCH_ATTEMPTS;
      if (final) {
        markInboxBatchFailed(db, ids);
      } else {
        markInboxBatchPending(db, ids);
        this.armRetry(phone);
      }
      log.error({ err, phone, inboxIds: ids, attempts, final }, "inbox batch failed");
      await this.notifyFailure(ctx, { final, attempts, error: err });
    }
  }
}
