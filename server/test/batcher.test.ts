import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBatchText,
  InboxBatcher,
  type InboxBatcherDeps,
  type MessageKind,
} from "../src/batcher.js";
import { openDb, type DB } from "../src/db.js";
import { PerPhoneQueue } from "../src/queue.js";
import { getInboxRow, insertInboxMessage } from "../src/repo.js";
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
  /** One entry per agent turn: exactly what the agent was asked to answer. */
  turns: { phone: string; role: TurnContext["role"]; text: string }[];
}

function harness(overrides: Partial<InboxBatcherDeps> = {}): Harness {
  const db = openDb(":memory:");
  const turns: Harness["turns"] = [];
  const batcher = new InboxBatcher({
    db,
    queue: new PerPhoneQueue(),
    log: silentLog,
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    mediaDebounceMs: MEDIA_DEBOUNCE_MS,
    mediaMaxWaitMs: MEDIA_MAX_WAIT_MS,
    roleFor: () => "customer",
    onMessage: async (ctx, text) => {
      turns.push({ phone: ctx.phone, role: ctx.role, text });
    },
    ...overrides,
  });
  return { db, batcher, turns };
}

/** Persist an inbound message and hand it to the batcher, as the webhook does. */
function receive(h: Harness, phone: string, text: string, kind: MessageKind = "text"): number {
  const row = insertInboxMessage(h.db, {
    dedupe_key: `msg:${phone}:${Math.random()}`,
    phone,
    agent_text: text,
  });
  if (!row) throw new Error("insert failed");
  h.batcher.schedule(phone, kind);
  return row.id;
}

describe("buildBatchText", () => {
  it("joins a burst of text messages in arrival order", () => {
    expect(buildBatchText(["Hola", "busco apartamento", "en Belén"])).toBe(
      "Hola\nbusco apartamento\nen Belén",
    );
  });

  it("collapses repeated photo placeholders into one line with the count", () => {
    const texts = Array.from({ length: 10 }, () => PHOTO);
    expect(buildBatchText(texts)).toBe("(El usuario envió 10 fotos)");
  });

  it("keeps the singular wording for exactly one photo", () => {
    expect(buildBatchText([PHOTO])).toBe(PHOTO);
  });

  it("reports photo groups separately when text interrupts them", () => {
    expect(buildBatchText([PHOTO, PHOTO, "Es el 1912", PHOTO])).toBe(
      "(El usuario envió 2 fotos)\nEs el 1912\n(El usuario envió una foto)",
    );
  });

  it("drops rows with no agent-worthy text", () => {
    expect(buildBatchText(["", "   ", "Hola"])).toBe("Hola");
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

  it("marks every row in the batch failed when the agent throws", async () => {
    const h = harness({
      onMessage: async () => {
        throw new Error("agent exploded");
      },
    });
    const first = receive(h, "573001", "uno");
    const second = receive(h, "573001", "dos");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(getInboxRow(h.db, first)?.status).toBe("failed");
    expect(getInboxRow(h.db, second)?.status).toBe("failed");
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
