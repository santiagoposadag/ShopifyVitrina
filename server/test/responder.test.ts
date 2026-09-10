import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { Responders, type ConversationRecorder, type ResponderRecording } from "../src/egress/responder.js";
import { AgentReplies } from "../src/egress/agent-reply.js";
import { agentPrincipal, whatsappPrincipal } from "../src/inbox/envelope.js";
import type { WhatsAppChannel } from "../src/whatsapp/channel.js";

/**
 * Records the ADDRESS as well as the text. The address is the whole point of
 * this seam: a reply that reaches WhatsApp with the wrong `to` is delivered
 * successfully to a stranger, and nothing downstream can tell.
 *
 * Typed as the interface with no cast, like every other fake in this suite — if
 * the responder ever needs something provider-specific, the seam has leaked.
 */
function recordingChannel(sent: { to: string; body: string }[], fail?: Error): WhatsAppChannel {
  return {
    sendText: async (to, body) => {
      if (fail) throw fail;
      sent.push({ to, body });
    },
    downloadMedia: () => {
      throw new Error("a responder must not download media");
    },
  };
}

interface RecordedMessage {
  conversationKey: string;
  agentId: string;
  turnKey: string;
  body: string;
}

/** Records what Responders asked to be written to the conversation record. */
function recordingRecorder(records: RecordedMessage[], fail?: Error): ConversationRecorder {
  return {
    record: (input) => {
      if (fail) throw fail;
      records.push(input);
    },
  };
}

const silentLog = { error: () => undefined } as unknown as Pick<FastifyBaseLogger, "error">;

/** What every for() call needs to record a reply — never varies within these tests. */
const RECORDING: ResponderRecording = { agentId: "vitrina-ventas", turnKey: "turn-1" };

describe("Responder.for(principal)", () => {
  it("delivers a WhatsApp principal's reply to that principal's phone", async () => {
    const sent: { to: string; body: string }[] = [];
    const responders = new Responders({
      channel: recordingChannel(sent),
      recorder: recordingRecorder([]),
      log: silentLog,
    });

    await responders.for(whatsappPrincipal("573001112233"), RECORDING).deliver("Listo");

    expect(sent).toEqual([{ to: "573001112233", body: "Listo" }]);
  });

  // Two conversations run concurrently in this process (the queue serializes
  // per conversation, not globally), so a responder that remembered the last
  // principal instead of the one it was built for would cross the wires.
  it("binds each responder to its own principal", async () => {
    const sent: { to: string; body: string }[] = [];
    const responders = new Responders({
      channel: recordingChannel(sent),
      recorder: recordingRecorder([]),
      log: silentLog,
    });

    const first = responders.for(whatsappPrincipal("573001112233"), RECORDING);
    const second = responders.for(whatsappPrincipal("573009998877"), RECORDING);
    await second.deliver("para el segundo");
    await first.deliver("para el primero");

    expect(sent).toEqual([
      { to: "573009998877", body: "para el segundo" },
      { to: "573001112233", body: "para el primero" },
    ]);
  });

  // The send is inside the batch attempt: a transport failure has to reach the
  // batcher so the rows go back to 'pending' and the person eventually gets an
  // answer. Swallowing it here would settle the batch as done with nothing sent.
  it("propagates a transport failure instead of swallowing it", async () => {
    const records: RecordedMessage[] = [];
    const responders = new Responders({
      channel: recordingChannel([], new Error("bridge unreachable")),
      recorder: recordingRecorder(records),
      log: silentLog,
    });

    await expect(
      responders.for(whatsappPrincipal("573001112233"), RECORDING).deliver("Hola"),
    ).rejects.toThrow("bridge unreachable");
    // Nothing was ever delivered, so nothing should be recorded either.
    expect(records).toEqual([]);
  });

  // The agent door has no producer yet, so this branch is unreachable in this
  // build. It throws rather than returning a no-op responder: a seam that
  // accepts a reply and drops it is the failure this whole phase exists to make
  // impossible.
  it("refuses an agent principal loudly until the agent door exists", () => {
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder([]),
      log: silentLog,
    });

    expect(() =>
      responders.for(agentPrincipal("vitrina-ventas"), RECORDING, { conversationKey: "a2a:x:y:z" }),
    ).toThrow(/agent/i);
  });
});

/**
 * The agent branch, now that a door produces an agent principal.
 *
 * The property under test is the same one the WhatsApp branch has: a responder
 * is bound to WHO asked when it is created, and a failure to deliver reaches
 * the batcher instead of settling a batch as done with nothing delivered.
 */
describe("Responder.for(agent principal)", () => {
  function replies(): AgentReplies {
    return new AgentReplies({
      log: { error: () => undefined, warn: () => undefined },
      syncTimeoutMs: 1000,
    });
  }

  it("delivers to the caller parked on that conversation", async () => {
    const agentReplies = replies();
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder([]),
      log: silentLog,
      agentReplies,
    });
    const parked = agentReplies.register("a2a:super:target:corr-1");

    await responders
      .for(agentPrincipal("super"), RECORDING, { conversationKey: "a2a:super:target:corr-1" })
      .deliver("quedan 4");

    await expect(parked.reply).resolves.toBe("quedan 4");
  });

  // Two exchanges run concurrently in this process, so a responder that read
  // its route at deliver() time could answer the wrong caller.
  it("binds each responder to its own conversation", async () => {
    const agentReplies = replies();
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder([]),
      log: silentLog,
      agentReplies,
    });
    const first = agentReplies.register("a2a:super:target:corr-1");
    const second = agentReplies.register("a2a:super:target:corr-2");

    const one = responders.for(agentPrincipal("super"), RECORDING, {
      conversationKey: "a2a:super:target:corr-1",
    });
    const two = responders.for(agentPrincipal("super"), RECORDING, {
      conversationKey: "a2a:super:target:corr-2",
    });
    await two.deliver("para el segundo");
    await one.deliver("para el primero");

    await expect(first.reply).resolves.toBe("para el primero");
    await expect(second.reply).resolves.toBe("para el segundo");
  });

  it("refuses an agent principal with no route rather than dropping the reply", () => {
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder([]),
      log: silentLog,
      agentReplies: replies(),
    });

    expect(() => responders.for(agentPrincipal("super"), RECORDING)).toThrow(/agent/i);
  });

  it("propagates a callback failure instead of swallowing it", async () => {
    const agentReplies = new AgentReplies({
      log: { error: () => undefined, warn: () => undefined },
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder([]),
      log: silentLog,
      agentReplies,
    });

    await expect(
      responders
        .for(agentPrincipal("super"), RECORDING, {
          conversationKey: "a2a:super:target:corr-1",
          replyTo: "https://super.internal/callbacks/7",
        })
        .deliver("quedan 4"),
    ).rejects.toThrow(/500/);
  });
});

/**
 * The write half of both branches: Responders records every delivered reply
 * to the durable conversation record (repo.ts recordOutboundMessage), through
 * a narrow ConversationRecorder port rather than a real database — see that
 * interface's own doc comment for why a port and not a DB handle.
 */
describe("Responder recording", () => {
  it("records a WhatsApp reply only AFTER the send resolves", async () => {
    const sent: { to: string; body: string }[] = [];
    const records: RecordedMessage[] = [];
    const responders = new Responders({
      channel: recordingChannel(sent),
      recorder: recordingRecorder(records),
      log: silentLog,
    });

    await responders.for(whatsappPrincipal("573001112233"), RECORDING).deliver("Listo");

    // The phone IS the conversation key on this door (batcher.ts) — no route
    // object is needed to know it.
    expect(records).toEqual([
      { conversationKey: "573001112233", agentId: RECORDING.agentId, turnKey: RECORDING.turnKey, body: "Listo" },
    ]);
  });

  it("does not record when the WhatsApp send fails", async () => {
    const records: RecordedMessage[] = [];
    const responders = new Responders({
      channel: recordingChannel([], new Error("bridge unreachable")),
      recorder: recordingRecorder(records),
      log: silentLog,
    });

    await expect(
      responders.for(whatsappPrincipal("573001112233"), RECORDING).deliver("Hola"),
    ).rejects.toThrow("bridge unreachable");
    expect(records).toEqual([]);
  });

  // The person already has the message by the time recording runs. A thrown
  // recording failure reaching the caller here would look exactly like a
  // transport failure to whoever awaits deliver() — the batcher would return
  // the rows to 'pending' and resend a reply that was already delivered.
  it("a recording failure does not break a successful WhatsApp delivery, and is logged", async () => {
    const sent: { to: string; body: string }[] = [];
    const errors: unknown[] = [];
    const responders = new Responders({
      channel: recordingChannel(sent),
      recorder: recordingRecorder([], new Error("disk full")),
      log: { error: (obj: object) => errors.push(obj) } as unknown as Pick<FastifyBaseLogger, "error">,
    });

    await expect(
      responders.for(whatsappPrincipal("573001112233"), RECORDING).deliver("Listo"),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([{ to: "573001112233", body: "Listo" }]); // still delivered
    expect(errors).toHaveLength(1); // and the gap is not silent
  });

  it("records an agent reply only after it reaches the parked caller", async () => {
    const records: RecordedMessage[] = [];
    const agentReplies = new AgentReplies({ log: { error: () => undefined, warn: () => undefined } });
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder(records),
      log: silentLog,
      agentReplies,
    });
    const parked = agentReplies.register("a2a:super:target:corr-1");

    await responders
      .for(agentPrincipal("super"), RECORDING, { conversationKey: "a2a:super:target:corr-1" })
      .deliver("quedan 4");
    await parked.reply;

    expect(records).toEqual([
      {
        conversationKey: "a2a:super:target:corr-1",
        agentId: RECORDING.agentId,
        turnKey: RECORDING.turnKey,
        body: "quedan 4",
      },
    ]);
  });

  it("does not record when the agent callback fails", async () => {
    const records: RecordedMessage[] = [];
    const agentReplies = new AgentReplies({
      log: { error: () => undefined, warn: () => undefined },
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder(records),
      log: silentLog,
      agentReplies,
    });

    await expect(
      responders
        .for(agentPrincipal("super"), RECORDING, {
          conversationKey: "a2a:super:target:corr-1",
          replyTo: "https://super.internal/callbacks/7",
        })
        .deliver("quedan 4"),
    ).rejects.toThrow(/500/);
    expect(records).toEqual([]);
  });

  it("a recording failure does not break a successful agent delivery, and is logged", async () => {
    const errors: unknown[] = [];
    const agentReplies = new AgentReplies({ log: { error: () => undefined, warn: () => undefined } });
    const responders = new Responders({
      channel: recordingChannel([]),
      recorder: recordingRecorder([], new Error("disk full")),
      log: { error: (obj: object) => errors.push(obj) } as unknown as Pick<FastifyBaseLogger, "error">,
      agentReplies,
    });
    const parked = agentReplies.register("a2a:super:target:corr-1");

    await responders
      .for(agentPrincipal("super"), RECORDING, { conversationKey: "a2a:super:target:corr-1" })
      .deliver("quedan 4");

    await expect(parked.reply).resolves.toBe("quedan 4"); // still delivered
    expect(errors).toHaveLength(1);
  });
});
