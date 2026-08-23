import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_FALLBACK,
  buildBatchText,
  InboxBatcher,
  MAX_BATCH_ATTEMPTS,
  RETRY_DELAY_MS,
  type BatchRow,
  type InboxBatcherDeps,
  type MessageKind,
} from "../src/inbox/batcher.js";
import { openDb, type DB } from "../src/data/db.js";
import { PerPhoneQueue } from "../src/inbox/queue.js";
import { getInboxRow, insertInboxMessage } from "../src/data/repo.js";
import type { TurnContext } from "../src/types.js";

const DEBOUNCE_MS = 8000;
const MAX_WAIT_MS = 45000;
const MEDIA_DEBOUNCE_MS = 45000;
const MEDIA_MAX_WAIT_MS = 120000;

const PHOTO = "(El usuario envió una foto)";

const silentLog = { error: () => undefined, info: () => undefined } as unknown as FastifyBaseLogger;

interface Harness {
  db: DB;
  batcher: InboxBatcher;
  /** Exposed so a test can wait for the flush chain to actually drain. */
  queue: PerPhoneQueue;
  /** One entry per agent turn: exactly what the agent was asked to answer. */
  turns: { phone: string; role: TurnContext["role"]; text: string }[];
  /** One entry per failed attempt, in order — final marks the terminal one. */
  failures: { phone: string; final: boolean; attempts: number }[];
}

function harness(overrides: Partial<InboxBatcherDeps> = {}): Harness {
  const db = openDb(":memory:");
  const turns: Harness["turns"] = [];
  const failures: Harness["failures"] = [];
  const queue = new PerPhoneQueue();
  const batcher = new InboxBatcher({
    db,
    queue,
    log: silentLog,
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    mediaDebounceMs: MEDIA_DEBOUNCE_MS,
    mediaMaxWaitMs: MEDIA_MAX_WAIT_MS,
    roleFor: () => "customer",
    onMessage: async (ctx, text) => {
      turns.push({ phone: ctx.phone, role: ctx.role, text });
    },
    onBatchFailure: async (ctx, { final, attempts }) => {
      failures.push({ phone: ctx.phone, final, attempts });
    },
    ...overrides,
  });
  return { db, batcher, queue, turns, failures };
}

/**
 * A real event-loop turn, captured at module load — BEFORE any test installs
 * fake timers, so this stays the genuine setImmediate whatever vi.useFakeTimers
 * replaces later. Needed to wait on actual filesystem I/O inside a flush.
 */
const realSetTimeout = setTimeout;
const realEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, 1);
  });

/** Persist an inbound message and hand it to the batcher, as the webhook does. */
function receive(h: Harness, phone: string, text: string, kind: MessageKind = "text"): number {
  const row = insertInboxMessage(h.db, {
    dedupe_key: `msg:${phone}:${Math.random()}`,
    phone,
    agent_text: text,
    kind,
  });
  if (!row) throw new Error("insert failed");
  h.batcher.schedule(phone, kind);
  return row.id;
}

/** A text message, as the webhook persists it. */
const txt = (agent_text: string): BatchRow => ({ agent_text, kind: "text" });
/** A photo, with an optional caption — the webhook stores the caption as the text. */
const pic = (agent_text = ""): BatchRow => ({ agent_text, kind: "media" });

describe("buildBatchText", () => {
  it("joins a burst of text messages in arrival order", () => {
    expect(buildBatchText([txt("Hola"), txt("busco apartamento"), txt("en Belén")])).toBe(
      "Hola\nbusco apartamento\nen Belén",
    );
  });

  it("collapses a run of photos into one line with the count", () => {
    expect(buildBatchText(Array.from({ length: 10 }, () => pic()))).toBe(
      "(El usuario envió 10 fotos)",
    );
  });

  it("keeps the singular wording for exactly one photo", () => {
    expect(buildBatchText([pic()])).toBe(PHOTO);
  });

  it("reports photo groups separately when text interrupts them", () => {
    expect(buildBatchText([pic(), pic(), txt("Es el 1912"), pic()])).toBe(
      "(El usuario envió 2 fotos)\nEs el 1912\n(El usuario envió una foto)",
    );
  });

  it("drops rows with no agent-worthy text", () => {
    expect(buildBatchText([txt(""), txt("   "), txt("Hola")])).toBe("Hola");
  });

  // A photo's caption is stored AS its agent_text, so counting photos by
  // matching the placeholder string missed every captioned one: the agent was
  // told nothing had arrived and never called attach_pending_photos, while the
  // files sat in pending_media. The kind comes from the parsed event, not the text.
  it("counts a captioned photo as a photo and keeps its caption", () => {
    expect(buildBatchText([pic("Vestier alcoba principal")])).toBe(
      "(El usuario envió una foto)\nVestier alcoba principal",
    );
  });

  it("counts photos whether or not they carry a caption", () => {
    expect(buildBatchText([pic("Zona de ropas"), pic(), pic("Baño alcoba principal")])).toBe(
      "(El usuario envió 3 fotos)\nZona de ropas\nBaño alcoba principal",
    );
  });

  // The real burst that motivated this: every photo carried a caption, so the
  // old placeholder match counted zero and the whole listing read as plain chat.
  it("reports a fully captioned listing burst as photos, not as chat", () => {
    const rows = [
      pic("Salón comedor + balcón grande"),
      pic("Barra cocina con campana extractora"),
      pic("Alcoba 1: principal con baño y vestier"),
      txt("Está en \n630.000.000\nNegociables"),
    ];
    expect(buildBatchText(rows)).toBe(
      "(El usuario envió 3 fotos)\n" +
        "Salón comedor + balcón grande\n" +
        "Barra cocina con campana extractora\n" +
        "Alcoba 1: principal con baño y vestier\n" +
        "Está en \n630.000.000\nNegociables",
    );
  });

  // Legacy rows written before `kind` existed carry the placeholder as their
  // text and default to kind 'text'. They must still read as a photo, not as
  // someone literally typing that sentence.
  it("still recognises a legacy placeholder row stored as text", () => {
    expect(buildBatchText([txt(PHOTO), txt(PHOTO)])).toBe("(El usuario envió 2 fotos)");
  });
});

describe("InboxBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into exactly ONE agent turn", async () => {
    const h = harness();
    receive(h, "573001", "Hola");
    receive(h, "573001", "vendo apartamento");
    receive(h, "573001", "en Laureles");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]?.text).toBe("Hola\nvendo apartamento\nen Laureles");
    h.db.close();
  });

  it("does not flush before the debounce window elapses", async () => {
    const h = harness();
    receive(h, "573001", "Hola");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);

    expect(h.turns).toHaveLength(0);
    h.db.close();
  });

  it("restarts the silence window on every new message", async () => {
    const h = harness();
    receive(h, "573001", "uno");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1000);
    receive(h, "573001", "dos"); // resets the timer: no flush at the original deadline
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.turns).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1000);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]?.text).toBe("uno\ndos");
    h.db.close();
  });

  it("flushes at the hard cap when the owner never stops typing", async () => {
    const h = harness();
    receive(h, "573001", "msg 0");
    // A message every 4s never lets the 8s silence timer fire, so only the cap
    // can rescue the reply.
    for (let i = 1; i <= 20; i += 1) {
      await vi.advanceTimersByTimeAsync(4000);
      if (h.turns.length > 0) break;
      receive(h, "573001", `msg ${i}`);
    }

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]?.text.startsWith("msg 0\nmsg 1")).toBe(true);
    h.db.close();
  });

  it("starts a new batch for messages that arrive after a flush", async () => {
    const h = harness();
    receive(h, "573001", "primero");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    receive(h, "573001", "segundo");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns.map((t) => t.text)).toEqual(["primero", "segundo"]);
    h.db.close();
  });

  it("keeps phones isolated: one phone's batch never swallows another's", async () => {
    const h = harness({ roleFor: (phone) => (phone === "573001" ? "owner" : "customer") });
    receive(h, "573001", "soy el dueño");
    receive(h, "573002", "soy cliente");
    receive(h, "573001", "publica el 1912");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(2);
    const owner = h.turns.find((t) => t.phone === "573001");
    const customer = h.turns.find((t) => t.phone === "573002");
    expect(owner?.text).toBe("soy el dueño\npublica el 1912");
    expect(owner?.role).toBe("owner");
    expect(customer?.text).toBe("soy cliente");
    h.db.close();
  });

  it("marks every row in the batch done on success", async () => {
    const h = harness();
    const first = receive(h, "573001", "uno");
    const second = receive(h, "573001", "dos");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(getInboxRow(h.db, first)?.status).toBe("done");
    expect(getInboxRow(h.db, second)?.status).toBe("done");
    expect(getInboxRow(h.db, first)?.attempts).toBe(1);
    h.db.close();
  });

  it("marks every row in the batch failed once the retry budget is spent", async () => {
    let calls = 0;
    const h = harness({
      onMessage: async () => {
        calls += 1;
        throw new Error("agent exploded");
      },
    });
    const first = receive(h, "573001", "uno");
    const second = receive(h, "573001", "dos");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // attempt 1
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS); // attempt 2
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS); // attempt 3 — terminal

    expect(calls).toBe(MAX_BATCH_ATTEMPTS);
    expect(getInboxRow(h.db, first)?.status).toBe("failed");
    expect(getInboxRow(h.db, second)?.status).toBe("failed");
    expect(getInboxRow(h.db, first)?.attempts).toBe(MAX_BATCH_ATTEMPTS);

    // Terminal means terminal: nothing fires after settling.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    expect(calls).toBe(MAX_BATCH_ATTEMPTS);
    h.db.close();
  });

  it("returns a failed batch to pending and succeeds on the retry", async () => {
    let failuresLeft = 1;
    const texts: string[] = [];
    const h = harness({
      onMessage: async (_ctx, text) => {
        texts.push(text);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("transient blip");
        }
      },
    });
    const id = receive(h, "573001", "uno");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(getInboxRow(h.db, id)?.status).toBe("pending"); // returned for retry, not failed
    expect(getInboxRow(h.db, id)?.attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(getInboxRow(h.db, id)?.status).toBe("done");
    expect(texts).toEqual(["uno", "uno"]); // the retry re-runs the same batch text
    h.db.close();
  });

  it("does not retry before RETRY_DELAY_MS elapses", async () => {
    let calls = 0;
    const h = harness({
      onMessage: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    receive(h, "573001", "uno");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    h.db.close();
  });

  it("reports final=true exactly once, on the last attempt", async () => {
    const h = harness({
      onMessage: async () => {
        throw new Error("boom");
      },
    });
    receive(h, "573001", "uno");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    // One apology, not three: user-facing side effects hang off `final`.
    expect(h.failures.map((f) => f.final)).toEqual([false, false, true]);
    expect(h.failures.map((f) => f.attempts)).toEqual([1, 2, 3]);
    h.db.close();
  });

  it("a retried batch absorbs messages that arrived while waiting", async () => {
    let failuresLeft = 1;
    const texts: string[] = [];
    const h = harness({
      onMessage: async (_ctx, text) => {
        texts.push(text);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("transient blip");
        }
      },
    });
    const a = receive(h, "573001", "uno");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // attempt 1 fails; retry armed

    // A new message during the backoff opens a burst whose flush (8s < 30s)
    // claims the pending retry row together with the new one.
    const b = receive(h, "573001", "dos");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(texts).toEqual(["uno", "uno\ndos"]);
    expect(getInboxRow(h.db, a)?.status).toBe("done");
    expect(getInboxRow(h.db, b)?.status).toBe("done");

    // The retry timer still fires later and must be a no-op.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(texts).toHaveLength(2);
    h.db.close();
  });

  it("stop() cancels a pending retry and leaves the rows replayable", async () => {
    const h = harness({
      onMessage: async () => {
        throw new Error("boom");
      },
    });
    const id = receive(h, "573001", "uno");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // attempt 1 fails, retry armed

    h.batcher.stop();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 3);

    expect(h.failures).toHaveLength(1); // no retry ever ran
    expect(getInboxRow(h.db, id)?.status).toBe("pending"); // replayed on next boot
    h.db.close();
  });

  it("boot replay of a poison message settles as failed at the cap instead of looping", async () => {
    const h = harness();
    const row = insertInboxMessage(h.db, { dedupe_key: "k1", phone: "573001", agent_text: "veneno" });
    if (!row) throw new Error("insert failed");
    // Three earlier processes each claimed this row and crashed mid-turn: the
    // budget is spent, so this boot must give up rather than crash-loop again.
    h.db.prepare(`UPDATE inbox SET status = 'processing', attempts = ? WHERE id = ?`).run(
      MAX_BATCH_ATTEMPTS,
      row.id,
    );

    h.batcher.replayPending();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(0); // the agent never runs
    expect(getInboxRow(h.db, row.id)?.status).toBe("failed");
    expect(h.failures).toEqual([
      { phone: "573001", final: true, attempts: MAX_BATCH_ATTEMPTS + 1 },
    ]);
    h.db.close();
  });

  it("leaves rows replayable while the batch is still in flight", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      onMessage: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const id = receive(h, "573001", "uno");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Mid-batch: a crash here must leave the row for replayPending() on boot.
    expect(getInboxRow(h.db, id)?.status).toBe("processing");
    release?.();
    h.db.close();
  });

  it("clears per-phone timer state once a batch flushes", async () => {
    const h = harness();
    receive(h, "573001", "uno");
    expect(h.batcher.pendingPhones).toBe(1);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.batcher.pendingPhones).toBe(0);
    h.db.close();
  });

  it("coalesces replayed rows on boot instead of one turn per row", async () => {
    const h = harness();
    // Rows a previous process accepted but never finished: 'pending' (crashed
    // before the agent ran) and 'processing' (crashed mid turn).
    const a = insertInboxMessage(h.db, { dedupe_key: "k1", phone: "573001", agent_text: "uno" });
    const b = insertInboxMessage(h.db, { dedupe_key: "k2", phone: "573001", agent_text: "dos" });
    const c = insertInboxMessage(h.db, { dedupe_key: "k3", phone: "573002", agent_text: "otro" });
    if (!a || !b || !c) throw new Error("insert failed");
    h.db.prepare(`UPDATE inbox SET status = 'processing' WHERE id = ?`).run(a.id);

    expect(h.batcher.replayPending()).toBe(3);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(2); // one per phone, NOT one per row
    expect(h.turns.find((t) => t.phone === "573001")?.text).toBe("uno\ndos");
    expect(getInboxRow(h.db, b.id)?.status).toBe("done");
    h.db.close();
  });

  it("keeps the 8s window for a text-only burst", async () => {
    const h = harness();
    receive(h, "573001", "hola", "text");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(1); // text is fast; no reason to make it wait
    h.db.close();
  });

  it("waits the longer media window once a burst contains a photo", async () => {
    const h = harness();
    receive(h, "573001", PHOTO, "media");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.turns).toHaveLength(0); // the text window must NOT flush a photo burst

    await vi.advanceTimersByTimeAsync(MEDIA_DEBOUNCE_MS - DEBOUNCE_MS);
    expect(h.turns).toHaveLength(1);
    h.db.close();
  });

  it("upgrades a text burst to the media window when a photo joins it", async () => {
    const h = harness();
    receive(h, "573001", "Casa en Llanogrande", "text");
    await vi.advanceTimersByTimeAsync(1000);
    receive(h, "573001", PHOTO, "media"); // the owner starts uploading

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(0); // must not flush on the old short window
    await vi.advanceTimersByTimeAsync(MEDIA_DEBOUNCE_MS);
    expect(h.turns[0]?.text).toBe("Casa en Llanogrande\n(El usuario envió una foto)");
    h.db.close();
  });

  it("keeps the media window when a text message arrives after the photos", async () => {
    const h = harness();
    receive(h, "573001", PHOTO, "media");
    await vi.advanceTimersByTimeAsync(1000);
    receive(h, "573001", "ese es el 0195", "text"); // must NOT shrink the window back

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.turns).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MEDIA_DEBOUNCE_MS);
    expect(h.turns).toHaveLength(1);
    h.db.close();
  });

  it("starts a fresh burst at the text window after a media burst flushes", async () => {
    const h = harness();
    receive(h, "573001", PHOTO, "media");
    await vi.advanceTimersByTimeAsync(MEDIA_DEBOUNCE_MS);
    expect(h.turns).toHaveLength(1);

    receive(h, "573001", "hola", "text");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(h.turns).toHaveLength(2); // media-ness does not leak into the next burst
    h.db.close();
  });

  it("enforces the media hard cap during a nonstop photo stream", async () => {
    const h = harness();
    receive(h, "573001", PHOTO, "media");
    // A photo every 20s never lets the 45s silence timer fire.
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(20000);
      if (h.turns.length > 0) break;
      receive(h, "573001", PHOTO, "media");
    }

    expect(h.turns).toHaveLength(1); // the cap rescued the reply
    h.db.close();
  });

  it("extends the cap to the media cap when a photo joins a text burst", async () => {
    const h = harness();
    receive(h, "573001", "Casa en Llanogrande", "text"); // text cap: 45s from here
    await vi.advanceTimersByTimeAsync(1000);
    receive(h, "573001", PHOTO, "media"); // upgrades the cap to 120s from the FIRST message

    // Keep the silence timer alive so only a cap can flush this.
    for (let t = 1000; t < MEDIA_MAX_WAIT_MS - 20000; t += 20000) {
      await vi.advanceTimersByTimeAsync(20000);
      if (t + 20000 < MAX_WAIT_MS) {
        expect(h.turns).toHaveLength(0); // the old 45s text cap must not fire
      }
      receive(h, "573001", PHOTO, "media");
    }
    await vi.advanceTimersByTimeAsync(MEDIA_MAX_WAIT_MS);

    expect(h.turns).toHaveLength(1);
    h.db.close();
  });

  // The burst that motivated all of this: ONE property (code 0195, 37 photos)
  // sent as ~30 messages. Offsets are the real inbox received_at values, with
  // t=0 as 22:04:28 — WhatsApp delivered the photos in two waves 32s apart.
  const REAL_BURST_OFFSETS_S = [0, 4, 36, 42]; // 22:04:28, :32, 22:05:04, :10

  it("keeps the real 22:04:28 → 22:05:10 photo burst in ONE batch", async () => {
    const h = harness();
    let elapsed = 0;
    for (const offset of REAL_BURST_OFFSETS_S) {
      await vi.advanceTimersByTimeAsync(offset * 1000 - elapsed);
      elapsed = offset * 1000;
      expect(h.turns).toHaveLength(0); // nothing may flush mid-burst
      receive(h, "573001", PHOTO, "media");
    }

    await vi.advanceTimersByTimeAsync(MEDIA_DEBOUNCE_MS);

    // One property, one reply — not the two the owner actually got.
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]?.text).toBe("(El usuario envió 4 fotos)");
    h.db.close();
  });

  it("would still split the real burst at a 30s media window — why the default is 45s", async () => {
    // The 32s gap between the two upload waves is longer than a 30s window, so
    // 30000 flushes 2s before the second wave lands. This pins the reasoning.
    const h = harness({ mediaDebounceMs: 30000 });
    let elapsed = 0;
    for (const offset of REAL_BURST_OFFSETS_S) {
      await vi.advanceTimersByTimeAsync(offset * 1000 - elapsed);
      elapsed = offset * 1000;
      receive(h, "573001", PHOTO, "media");
    }
    await vi.advanceTimersByTimeAsync(30000);

    expect(h.turns).toHaveLength(2); // the exact bug we are fixing
    h.db.close();
  });

  it("stop() cancels pending timers so shutdown leaves the rows replayable", async () => {
    const h = harness();
    const id = receive(h, "573001", "uno");
    h.batcher.stop();

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 2);

    expect(h.turns).toHaveLength(0);
    expect(h.batcher.pendingPhones).toBe(0);
    expect(getInboxRow(h.db, id)?.status).toBe("pending"); // replayed on next boot
    h.db.close();
  });
});

/**
 * Voice notes become words on the WORKER, not in the webhook: the bridge's
 * outbox is strictly sequential, so a speech API call in the handler stalls
 * every message queued behind it.
 */
describe("voice notes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Close the burst and let it finish.
   *
   * The extra turns are not padding. resolveAudio awaits a real
   * `unlink()` on the voice note's file — genuine libuv I/O, which fake timers
   * do not control and `advanceTimersByTimeAsync(0)` does not wait for: that
   * only drains microtasks. Whether the unlink had already settled therefore
   * depended on what else the runner happened to have in flight, which made
   * this whole group order-dependent — the same test passed alone and failed
   * after its neighbours. Yielding real event-loop turns is what actually waits
   * for it.
   */
  async function settle(h: Harness): Promise<void> {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await drain(h);
  }

  /**
   * Yield until the phone's flush chain has actually finished.
   *
   * Polling the queue rather than guessing a tick count: the chain contains
   * real I/O, so how long it takes is not a property of the fake clock. The
   * bound is generous because vitest runs test FILES in parallel workers and a
   * starved thread can take a while to get its I/O completion back.
   */
  async function drain(h: Harness): Promise<void> {
    for (let i = 0; i < 500 && h.queue.activePhones > 0; i++) {
      await realEventLoopTurn();
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  /** Persist a voice note the way the webhook does: no text, an audio path. */
  function receiveVoice(h: Harness, phone: string, audioPath: string): number {
    const row = insertInboxMessage(h.db, {
      dedupe_key: `msg:${phone}:${Math.random()}`,
      phone,
      agent_text: "",
      // 'text', not 'media' — a transcript is a spoken line, not a photo caption.
      kind: "text",
      audio_path: audioPath,
    });
    if (!row) throw new Error("insert failed");
    h.batcher.schedule(phone, "text");
    return row.id;
  }

  it("asks the agent the transcript, as if it had been typed", async () => {
    const h = harness({
      transcribeAudio: async () => "busco apartamento en Laureles",
    });
    receiveVoice(h, "573001", "/tmp/note.ogg");

    await settle(h);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.text).toBe("busco apartamento en Laureles");
  });

  // The crux of the original bug: an empty batch is settled `done` WITHOUT
  // running the agent, so an untranscribable voice note would reproduce the
  // silence this whole feature exists to end.
  it("still answers when transcription fails, instead of going silent", async () => {
    const h = harness({ transcribeAudio: async () => null });
    receiveVoice(h, "573001", "/tmp/note.ogg");

    await settle(h);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.text).toBe(AUDIO_FALLBACK);
  });

  it("answers even when the transcriber throws", async () => {
    const h = harness({
      transcribeAudio: async () => {
        throw new Error("provider down");
      },
    });
    receiveVoice(h, "573001", "/tmp/note.ogg");

    await settle(h);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.text).toBe(AUDIO_FALLBACK);
  });

  it("answers when no transcription provider is configured at all", async () => {
    const h = harness(); // no transcribeAudio dep
    receiveVoice(h, "573001", "/tmp/note.ogg");

    await settle(h);

    expect(h.turns[0]!.text).toBe(AUDIO_FALLBACK);
  });

  // Batches retry up to MAX_BATCH_ATTEMPTS. Without the write-back, every
  // attempt would re-upload and re-bill the same seconds of speech.
  it("does NOT re-transcribe when a failed batch is retried", async () => {
    let calls = 0;
    let failTurn = true;
    const h = harness({
      transcribeAudio: async () => {
        calls += 1;
        return "hola";
      },
      onMessage: async (ctx, text) => {
        h.turns.push({ phone: ctx.phone, role: ctx.role, text });
        if (failTurn) {
          failTurn = false;
          throw new Error("agent blew up");
        }
      },
    });
    receiveVoice(h, "573001", "/tmp/note.ogg");

    await settle(h);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + DEBOUNCE_MS);
    await drain(h);

    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.text).toBe("hola");
    expect(calls, "the retry paid to transcribe the same audio again").toBe(1);
  });

  it("persists the transcript so a replay after a crash reads words, not silence", async () => {
    const h = harness({ transcribeAudio: async () => "el código es 1912" });
    const id = receiveVoice(h, "573001", "/tmp/note.ogg");

    await settle(h);

    const row = h.db.prepare(`SELECT agent_text, audio_path FROM inbox WHERE id = ?`).get(id);
    expect(row).toEqual({ agent_text: "el código es 1912", audio_path: null });
  });

  it("reads a transcript as its own line when a burst also carries photos", () => {
    // A media row renders as a photo COUNT with its text treated as a caption
    // grouped underneath. A transcript is neither, which is why audio rows are
    // persisted as 'text'.
    expect(buildBatchText([pic(), txt("busco algo en Laureles"), pic()])).toBe(
      "(El usuario envió una foto)\nbusco algo en Laureles\n(El usuario envió una foto)",
    );
  });
});
