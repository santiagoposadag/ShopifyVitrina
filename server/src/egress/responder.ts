import type { AgentReplies, ReplyRoute } from "./agent-reply.js";
import type { Principal } from "../inbox/envelope.js";
import type { WhatsAppChannel } from "../whatsapp/channel.js";

export type { ReplyRoute } from "./agent-reply.js";

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
  /**
   * The PRINCIPAL says who is owed the reply; the ROUTE says how to reach a
   * caller that carries no address of its own. A phone IS an address, so the
   * WhatsApp branch needs nothing more. An agent is identified by a credential
   * and reached through the exchange it opened — which is the conversation key,
   * plus, when it set one, a callback URL the door has already validated.
   *
   * Optional, so every existing caller keeps compiling AND keeps meaning what
   * it meant: without a route an agent principal has no way home, and the
   * factory refuses rather than returning a responder that would drop the
   * reply.
   */
  for(principal: Principal, route?: ReplyRoute): Responder;
}

/**
 * The two ways a reply leaves this process: a WhatsApp message, or the answer
 * to an agent that asked.
 *
 * The agent branch still THROWS when this build wired no agent replies, or when
 * a caller arrives with no route — instead of returning a responder that
 * quietly drops the reply. Reaching either case means a door was wired up
 * without its return path, which is precisely the failure this seam exists to
 * prevent; it surfaces as a failed batch (retried, then an apology) rather than
 * as a silent success.
 */
export class Responders implements ResponderFactory {
  constructor(
    private readonly channel: WhatsAppChannel,
    /** Absent in a build with no agent door: the branch below then refuses. */
    private readonly agentReplies?: AgentReplies,
  ) {}

  for(principal: Principal, route?: ReplyRoute): Responder {
    switch (principal.kind) {
      case "whatsapp": {
        // The phone is captured HERE, not read at deliver() time: conversations
        // run concurrently in this process, and a responder that resolved its
        // address later could answer the wrong person.
        const { phone } = principal;
        return { deliver: (reply: string) => this.channel.sendText(phone, reply) };
      }
      case "agent": {
        const replies = this.agentReplies;
        if (!replies || !route) {
          throw new Error(
            `no reply route for agent principal ${principal.agentId}: the agent door has no responder here`,
          );
        }
        // Captured for the same reason the phone above is: this responder may
        // be held across an await while another conversation's turn runs.
        const bound: ReplyRoute = {
          conversationKey: route.conversationKey,
          ...(route.replyTo !== undefined ? { replyTo: route.replyTo } : {}),
        };
        return { deliver: (reply: string) => replies.deliver(bound, reply) };
      }
    }
  }
}
