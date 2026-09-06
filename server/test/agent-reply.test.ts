import { describe, expect, it, vi } from "vitest";
import {
  AgentReplies,
  ConversationBusyError,
  ReplyTimeoutError,
  TurnFailedError,
} from "../src/egress/agent-reply.js";

/**
 * The rendezvous between an open request and the turn that answers it.
 *
 * Every failure here is silent by nature: a caller parked forever, an answer
 * delivered to the wrong exchange, or a reply produced for a caller that is
 * already gone. What this file pins is that each of those ends in something
 * observable — a rejection the door turns into a status, or a logged error.
 */

const KEY = "a2a:super:vitrina-inventario:corr-1";

function log(): { error: unknown[][]; warn: unknown[][]; sink: AgentRepliesLog } {
  const error: unknown[][] = [];
  const warn: unknown[][] = [];
  return {
    error,
    warn,
    sink: {
      error: (obj: object, msg: string) => error.push([obj, msg]),
      warn: (obj: object, msg: string) => warn.push([obj, msg]),
    },
  };
}

interface AgentRepliesLog {
  error: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

describe("parking a caller", () => {
  it("resolves the parked caller with the reply its turn produced", async () => {
    const replies = new AgentReplies({ log: log().sink });
    const parked = replies.register(KEY);

    await replies.deliver({ conversationKey: KEY }, "quedan 4");

    await expect(parked.reply).resolves.toBe("quedan 4");
  });

  // Two callers parked on one key cannot be told apart when the reply arrives:
  // the claim that produced it took every un-settled row of that conversation,
  // so "which of you asked this" has no answer.
  it("refuses a second caller on the same conversation", () => {
    const replies = new AgentReplies({ log: log().sink });
    replies.register(KEY);

    expect(() => replies.register(KEY)).toThrow(ConversationBusyError);
  });

  it("frees the conversation again once the caller releases it", () => {
    const replies = new AgentReplies({ log: log().sink });
    const parked = replies.register(KEY);

    parked.release();

    expect(replies.isParked(KEY)).toBe(false);
    expect(() => replies.register(KEY)).not.toThrow();
  });

  // A release from a caller that has already been superseded must not evict the
  // caller that replaced it — that would strand the new one for its whole wait.
  it("ignores a release from a caller that no longer holds the spot", () => {
    const replies = new AgentReplies({ log: log().sink });
    const first = replies.register(KEY);
    first.release();
    const second = replies.register(KEY);

    first.release();

    expect(replies.isParked(KEY)).toBe(true);
    void second;
  });

  it("delivers to the right conversation when several are parked", async () => {
    const replies = new AgentReplies({ log: log().sink });
    const one = replies.register(KEY);
    const two = replies.register("a2a:super:vitrina-ventas:corr-1");

    await replies.deliver({ conversationKey: "a2a:super:vitrina-ventas:corr-1" }, "para ventas");
    await replies.deliver({ conversationKey: KEY }, "para inventario");

    await expect(one.reply).resolves.toBe("para inventario");
    await expect(two.reply).resolves.toBe("para ventas");
  });
});

describe("when nothing comes back", () => {
  it("gives up on a parked caller after its wait runs out", async () => {
    vi.useFakeTimers();
    try {
      const replies = new AgentReplies({ log: log().sink, syncTimeoutMs: 1000 });
      const parked = replies.register(KEY);
      const settled = expect(parked.reply).rejects.toBeInstanceOf(ReplyTimeoutError);

      await vi.advanceTimersByTimeAsync(1001);
      await settled;

      // The spot is free again: a timed-out exchange must not lock the
      // conversation out for good.
      expect(replies.isParked(KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a parked caller outright when the turn is done retrying", async () => {
    const replies = new AgentReplies({ log: log().sink });
    const parked = replies.register(KEY);

    replies.fail(KEY, new Error("Shopify is down"));

    await expect(parked.reply).rejects.toBeInstanceOf(TurnFailedError);
  });

  it("does nothing when a failure names a conversation nobody is parked on", () => {
    const replies = new AgentReplies({ log: log().sink });

    expect(() => replies.fail(KEY, new Error("boom"))).not.toThrow();
  });

  // A replayed row answers into a process where nobody is waiting any more.
  // Retrying cannot conjure the caller back, so this is the one place the layer
  // does not throw — but it is logged at ERROR, because the other way to reach
  // it is a door wired up without its return path.
  it("logs at ERROR when a reply has nowhere to go", async () => {
    const logs = log();
    const replies = new AgentReplies({ log: logs.sink });

    await replies.deliver({ conversationKey: KEY }, "quedan 4");

    expect(logs.error).toHaveLength(1);
    expect(logs.error[0]![1]).toMatch(/nowhere/i);
  });
});

describe("the callback route", () => {
  it("posts the reply to the callback the door validated", async () => {
    const posted: { url: string; body: string | undefined }[] = [];
    const replies = new AgentReplies({
      log: log().sink,
      fetchImpl: async (url, init) => {
        posted.push({ url, body: init.body });
        return { ok: true, status: 200 };
      },
    });

    await replies.deliver(
      { conversationKey: KEY, replyTo: "https://super.internal/callbacks/7" },
      "quedan 4",
    );

    expect(posted).toEqual([
      {
        url: "https://super.internal/callbacks/7",
        body: JSON.stringify({ conversationKey: KEY, reply: "quedan 4" }),
      },
    ]);
  });

  // NO CREDENTIAL travels with a callback: the URL came out of a request body,
  // and the only tokens this process holds would let their bearer send WhatsApp
  // messages as the business or write to the store.
  it("attaches no credential of ours to the callback", async () => {
    let headers: Record<string, string> = {};
    const replies = new AgentReplies({
      log: log().sink,
      fetchImpl: async (_url, init) => {
        headers = init.headers;
        return { ok: true, status: 200 };
      },
    });

    await replies.deliver(
      { conversationKey: KEY, replyTo: "https://super.internal/callbacks/7" },
      "quedan 4",
    );

    expect(Object.keys(headers)).toEqual(["content-type"]);
  });

  // A parked caller wins: answering the request that is still open is the route
  // that cannot be lost.
  it("answers the open request rather than the callback when both exist", async () => {
    let posted = 0;
    const replies = new AgentReplies({
      log: log().sink,
      fetchImpl: async () => {
        posted += 1;
        return { ok: true, status: 200 };
      },
    });
    const parked = replies.register(KEY);

    await replies.deliver(
      { conversationKey: KEY, replyTo: "https://super.internal/callbacks/7" },
      "quedan 4",
    );

    await expect(parked.reply).resolves.toBe("quedan 4");
    expect(posted).toBe(0);
  });

  it("throws when the callback refuses, so the batch is retried", async () => {
    const replies = new AgentReplies({
      log: log().sink,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });

    await expect(
      replies.deliver(
        { conversationKey: KEY, replyTo: "https://super.internal/callbacks/7" },
        "quedan 4",
      ),
    ).rejects.toThrow(/503/);
  });

  // A deployment that accepted a replyTo and cannot deliver one is a wiring
  // mistake, and it is the caller's answer that is at stake.
  it("throws when no callback transport is configured at all", async () => {
    const replies = new AgentReplies({ log: log().sink });

    await expect(
      replies.deliver(
        { conversationKey: KEY, replyTo: "https://super.internal/callbacks/7" },
        "quedan 4",
      ),
    ).rejects.toThrow(/transport/i);
  });
});
