import type { Principal } from "../inbox/envelope.js";
import type { WhatsAppChannel } from "../whatsapp/channel.js";

/**
 * Where a turn's reply goes.
 *
 * The runtime used to send the reply itself, straight to a phone. That made the
 * destination a property of the agent loop: there was exactly one kind of
 * caller it could ever answer, and no way to run a turn in a test without a
 * transport. Now the turn RETURNS its reply and this decides who receives it,
 * chosen by the principal that asked — which is the only thing that knows.
 */

/** One bound destination: the principal was fixed when this was created. */
export interface Responder {
  /**
   * Deliver one turn's reply.
   *
   * MUST NOT swallow a transport failure. The send happens inside the inbox
   * batch attempt, so a throw returns the rows to 'pending' and the burst is
   * retried; a caught error would settle the batch as done with nothing
   * delivered — the person waits forever for a message that no longer exists
   * anywhere. Costing a duplicate agent turn on retry is the cheaper mistake,
   * and the turn key is what keeps that retry safe on the Shopify side.
   */
  deliver(reply: string): Promise<void>;
}

/** Picks the delivery route for a principal. One implementation per door. */
export interface ResponderFactory {
  for(principal: Principal): Responder;
}

/**
 * The only factory in this build: everything that can currently ask a question
 * came in through WhatsApp, so everything is answered there.
 *
 * The agent branch throws instead of returning a responder that quietly drops
 * the reply — no producer of an agent principal exists yet, so reaching it
 * means a door was wired up without its return path, and that is precisely the
 * failure this seam exists to prevent. It surfaces as a failed batch (retried,
 * then an apology) rather than as a silent success.
 */
export class Responders implements ResponderFactory {
  constructor(private readonly channel: WhatsAppChannel) {}

  for(principal: Principal): Responder {
    switch (principal.kind) {
      case "whatsapp": {
        // The phone is captured HERE, not read at deliver() time: conversations
        // run concurrently in this process, and a responder that resolved its
        // address later could answer the wrong person.
        const { phone } = principal;
        return { deliver: (reply: string) => this.channel.sendText(phone, reply) };
      }
      case "agent":
        throw new Error(
          `no reply route for agent principal ${principal.agentId}: the agent door has no responder yet`,
        );
    }
  }
}
