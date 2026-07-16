import { describe, expect, it } from "vitest";
import { PerPhoneQueue } from "../src/inbox/queue.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PerPhoneQueue", () => {
  it("processes messages from the same phone in order", async () => {
    const queue = new PerPhoneQueue();
    const order: number[] = [];

    // First job is slow; a strict FIFO must still keep 1 before 2 and 3.
    const p1 = queue.enqueue("A", async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = queue.enqueue("A", async () => {
      await delay(5);
      order.push(2);
    });
    const p3 = queue.enqueue("A", async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps ordering per phone even when one job rejects", async () => {
    const queue = new PerPhoneQueue();
    const order: string[] = [];

    const p1 = queue.enqueue("A", async () => {
      order.push("a1");
      throw new Error("boom");
    });
    const p2 = queue.enqueue("A", async () => {
      order.push("a2");
    });

    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(order).toEqual(["a1", "a2"]);
  });

  it("runs different phones concurrently", async () => {
    const queue = new PerPhoneQueue();
    const events: string[] = [];

    const a = queue.enqueue("A", async () => {
      await delay(20);
      events.push("A");
    });
    const b = queue.enqueue("B", async () => {
      events.push("B"); // faster; should finish first despite being enqueued second
    });

    await Promise.all([a, b]);
    expect(events[0]).toBe("B");
    expect(events).toContain("A");
  });

  it("clears its internal map once chains drain", async () => {
    const queue = new PerPhoneQueue();
    await queue.enqueue("A", async () => undefined);
    // Allow the cleanup microtask to run.
    await delay(1);
    expect(queue.activePhones).toBe(0);
  });
});
