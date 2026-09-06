/**
 * How an agent caller gets its answer.
 *
 * Two routes, and the plan settles which is default: the reply goes back in the
 * response body of the request that asked (§2.6 row 1), because an agent's
 * question is already a request-response; a `replyTo` callback is used only
 * when the caller sets one, since a callback is one more thing to lose.
 *
 * The body route needs a rendezvous, because the two halves live in different
 * places on purpose: the HTTP handler parks, and the REPLY is produced deep
 * inside the batch attempt, where a delivery failure still has to fail the
 * batch. That is what this class is — a parking spot keyed by conversation, not
 * a queue and not a mailbox.
 */

/** Where one turn's reply must go, as the door recorded it in the envelope. */
export interface ReplyRoute {
  /** Which parked caller is waiting, and which callback belongs to it. */
  conversationKey: string;
  /** A callback URL the door has already checked against the caller's prefix. */
  replyTo?: string;
}

/** Only what this module logs. Same shape Fastify's logger already satisfies. */
export interface ReplyLog {
  error: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** The one call this module makes to the outside world, injectable for tests. */
export type CallbackFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * A caller parked on the sync route. `reply` settles when the turn answers, or
 * rejects when the turn fails terminally or the wait runs out.
 */
export interface ParkedCaller {
  reply: Promise<string>;
  /** Give up the spot. MUST be called on every exit path, including timeouts. */
  release(): void;
}

/** A second exchange tried to open on a conversation that already has one. */
export class ConversationBusyError extends Error {
  constructor(conversationKey: string) {
    super(`an exchange is already in flight on ${conversationKey}`);
    this.name = "ConversationBusyError";
  }
}

/** The wait ran out before the turn produced anything. */
export class ReplyTimeoutError extends Error {
  constructor(conversationKey: string) {
    super(`no reply on ${conversationKey} before the wait ran out`);
    this.name = "ReplyTimeoutError";
  }
}

/** The turn failed for good; the caller is told rather than left to time out. */
export class TurnFailedError extends Error {
  constructor(conversationKey: string, readonly reason: unknown) {
    super(`the turn for ${conversationKey} failed`);
    this.name = "TurnFailedError";
  }
}

export interface AgentRepliesDeps {
  log: ReplyLog;
  /** Absent means callbacks cannot be delivered at all — see deliver(). */
  fetchImpl?: CallbackFetch;
  /** How long a parked caller waits before it is told nothing came. */
  syncTimeoutMs?: number;
  /** How long the callback POST may take. Bounded so a turn cannot hang here. */
  callbackTimeoutMs?: number;
}

/**
 * The default wait for a sync exchange.
 *
 * Bounded, and generously: a real turn has been measured at 52 seconds with
 * twelve tool calls, so a short ceiling would report failure for turns that are
 * about to succeed. It exists so a caller cannot be parked forever by a turn
 * that dies in a way nothing else notices — the row keeps its own retry story
 * whatever this does.
 */
export const SYNC_REPLY_TIMEOUT_MS = 120_000;

/** A callback POST is one hop to a service the operator named. */
export const CALLBACK_TIMEOUT_MS = 10_000;

interface Waiter {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentReplies {
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly deps: AgentRepliesDeps) {}

  /**
   * Park the caller of one exchange until its turn answers.
   *
   * ONE waiter per conversation, and a second attempt is refused rather than
   * queued. Two exchanges parked on one key cannot be told apart when the reply
   * arrives: the claim that produces it takes every un-settled row of that
   * conversation, so "which of you asked this" has no answer. Refusing is the
   * version the caller can act on; guessing is the version where an agent gets
   * somebody else's answer.
   */
  register(conversationKey: string): ParkedCaller {
    if (this.waiters.has(conversationKey)) throw new ConversationBusyError(conversationKey);

    let waiter!: Waiter;
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(conversationKey);
        reject(new ReplyTimeoutError(conversationKey));
      }, this.deps.syncTimeoutMs ?? SYNC_REPLY_TIMEOUT_MS);
      // The wait must never be a reason the process stays alive on shutdown.
      timer.unref?.();
      waiter = { resolve, reject, timer };
    });
    this.waiters.set(conversationKey, waiter);

    return {
      reply,
      release: () => {
        const current = this.waiters.get(conversationKey);
        if (current !== waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(conversationKey);
      },
    };
  }

  /**
   * Deliver one turn's reply to whoever is owed it.
   *
   * Order matters: a parked caller wins over a callback. A caller that set
   * `replyTo` is answered through it and is never parked, so the two cannot
   * both be true for one exchange — but if they ever were, answering the open
   * request is the route that cannot be lost.
   *
   * THROWS on a failed callback, deliberately: that is a transport failure, and
   * the responder contract is that those reach the batcher so the rows go back
   * to 'pending' and the answer is retried.
   */
  async deliver(route: ReplyRoute, reply: string): Promise<void> {
    const waiter = this.waiters.get(route.conversationKey);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(route.conversationKey);
      waiter.resolve(reply);
      return;
    }

    if (route.replyTo) {
      await this.postCallback(route.replyTo, route.conversationKey, reply);
      return;
    }

    // Nobody is owed this, and nobody ever will be. THE ONE PLACE THIS LAYER
    // DOES NOT THROW, and the exception is argued rather than convenient: the
    // destination was an in-memory parking spot in a process that has since
    // restarted (a replayed row), or a caller that gave up and disconnected.
    // Retrying cannot conjure it back, so a throw would buy nothing but two
    // more agent turns and then a 'failed' row. Logged at ERROR because the
    // OTHER way to reach this line is a door wired up without its return path,
    // and that must not read as a quiet success.
    this.deps.log.error(
      { conversationKey: route.conversationKey, replyChars: reply.length },
      "an agent turn produced a reply with nowhere to send it; the caller is gone",
    );
  }

  /**
   * Fail a parked caller instead of making it wait out the timeout.
   *
   * Called when a batch settles as terminally failed: the retry budget is
   * spent, so nothing is coming, and a caller that knows that now can say so to
   * its own user instead of holding a request open for two more minutes.
   */
  fail(conversationKey: string, cause: unknown): void {
    const waiter = this.waiters.get(conversationKey);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(conversationKey);
    waiter.reject(new TurnFailedError(conversationKey, cause));
  }

  /** Whether anyone is parked. Exposed for the door's busy check and for tests. */
  isParked(conversationKey: string): boolean {
    return this.waiters.has(conversationKey);
  }

  private async postCallback(url: string, conversationKey: string, reply: string): Promise<void> {
    const send = this.deps.fetchImpl;
    if (!send) {
      // A deployment that accepted a replyTo and cannot deliver one is a wiring
      // mistake, and it is the caller's answer that is at stake — fail the
      // batch rather than swallow it.
      throw new Error("no callback transport is configured; cannot deliver a replyTo reply");
    }
    // NO CREDENTIAL IS ATTACHED. The URL came out of a request body, and the
    // only tokens this process holds would let their bearer send WhatsApp
    // messages as the business or write to the store. The receiver
    // authenticates the message by the correlation it is already tracking.
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationKey, reply }),
      signal: AbortSignal.timeout(this.deps.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`callback ${url} answered ${response.status}`);
    }
  }
}
