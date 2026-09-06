import { describe, expect, it } from "vitest";
import { Responders } from "../src/egress/responder.js";
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

describe("Responder.for(principal)", () => {
  it("delivers a WhatsApp principal's reply to that principal's phone", async () => {
    const sent: { to: string; body: string }[] = [];
    const responders = new Responders(recordingChannel(sent));

    await responders.for(whatsappPrincipal("573001112233")).deliver("Listo");

    expect(sent).toEqual([{ to: "573001112233", body: "Listo" }]);
  });

  // Two conversations run concurrently in this process (the queue serializes
  // per conversation, not globally), so a responder that remembered the last
  // principal instead of the one it was built for would cross the wires.
  it("binds each responder to its own principal", async () => {
    const sent: { to: string; body: string }[] = [];
    const responders = new Responders(recordingChannel(sent));

    const first = responders.for(whatsappPrincipal("573001112233"));
    const second = responders.for(whatsappPrincipal("573009998877"));
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
    const responders = new Responders(recordingChannel([], new Error("bridge unreachable")));

    await expect(responders.for(whatsappPrincipal("573001112233")).deliver("Hola")).rejects.toThrow(
      "bridge unreachable",
    );
  });

  // The agent door has no producer yet, so this branch is unreachable in this
  // build. It throws rather than returning a no-op responder: a seam that
  // accepts a reply and drops it is the failure this whole phase exists to make
  // impossible.
  it("refuses an agent principal loudly until the agent door exists", () => {
    const responders = new Responders(recordingChannel([]));

    expect(() => responders.for(agentPrincipal("vitrina-ventas"))).toThrow(/agent/i);
  });
});
