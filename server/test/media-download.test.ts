import { describe, expect, it } from "vitest";
import { downloadInboundMedia, type MediaDownloadBudget } from "../src/inbox/media-download.js";

const BUDGET: MediaDownloadBudget = { totalMs: 300, perDownloadMs: 80 };

/**
 * A download that resolves after `ms`, or rejects when its signal aborts first.
 * Rejects immediately on an already-aborted signal, exactly as fetch does — once
 * the burst deadline has passed, every remaining item is handed a dead signal,
 * and a listener added to one never fires.
 */
function afterMs(ms: number, value: string): (item: string, signal: AbortSignal) => Promise<Buffer> {
  return (_item, signal) =>
    new Promise<Buffer>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
      const timer = setTimeout(() => resolve(Buffer.from(value)), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      });
    });
}

/** Dispatch per item name, so one burst can mix slow, fast, and failing files. */
function router(routes: Record<string, (item: string, signal: AbortSignal) => Promise<Buffer>>) {
  return (item: string, signal: AbortSignal) => routes[item]!(item, signal);
}

describe("downloadInboundMedia", () => {
  // THE bug: one AbortSignal.timeout was created per request and shared by every
  // sequential download. The first slow file burned the whole budget, and every
  // later download rejected instantly on the already-aborted signal — three
  // photos failed 2ms apart. A slow file must cost only itself.
  it("does not let a slow download starve the ones after it", async () => {
    const results = await downloadInboundMedia(
      ["slow", "fast-a", "fast-b"],
      router({
        slow: afterMs(10_000, "never"),
        "fast-a": afterMs(5, "a"),
        "fast-b": afterMs(5, "b"),
      }),
      BUDGET,
    );

    expect(results.map((r) => r.ok)).toEqual([false, true, true]);
    expect(results[1]).toMatchObject({ ok: true, buffer: Buffer.from("a") });
    expect(results[2]).toMatchObject({ ok: true, buffer: Buffer.from("b") });
  });

  // Photo order is the listing's order — the first photo is the cover on the
  // storefront. Results must come back in the order they were handed in.
  it("returns results in input order regardless of completion order", async () => {
    const results = await downloadInboundMedia(
      ["slowish", "instant"],
      router({ slowish: afterMs(40, "first"), instant: afterMs(1, "second") }),
      BUDGET,
    );

    expect(results.map((r) => (r.ok ? r.buffer.toString() : "ERR"))).toEqual(["first", "second"]);
  });

  it("caps a single download at perDownloadMs", async () => {
    const started = Date.now();
    const results = await downloadInboundMedia(
      ["slow"],
      router({ slow: afterMs(10_000, "never") }),
      BUDGET,
    );

    expect(results[0]!.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(BUDGET.totalMs);
  });

  // The Kapso webhook has a ~10s ACK deadline. However many photos arrive, the
  // whole batch must fit in the total budget or the ACK is lost and Kapso retries.
  it("never exceeds the total budget, however many photos arrive", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `slow-${i}`);
    const routes = Object.fromEntries(items.map((i) => [i, afterMs(10_000, "never")]));
    const started = Date.now();

    const results = await downloadInboundMedia(items, router(routes), BUDGET);

    expect(Date.now() - started).toBeLessThan(BUDGET.totalMs + 150);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results).toHaveLength(items.length);
  });

  it("reports a single failure without losing the rest of the burst", async () => {
    const results = await downloadInboundMedia(
      ["boom", "ok"],
      router({
        boom: () => Promise.reject(new Error("untrusted host")),
        ok: afterMs(5, "fine"),
      }),
      BUDGET,
    );

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.ok === false && (results[0]!.error as Error).message).toBe("untrusted host");
    expect(results[1]).toMatchObject({ ok: true });
  });

  it("handles an empty burst", async () => {
    expect(await downloadInboundMedia([], afterMs(1, "x"), BUDGET)).toEqual([]);
  });
});
