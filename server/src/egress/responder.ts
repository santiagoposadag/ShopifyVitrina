import type { FastifyBaseLogger } from "fastify";
import type { AgentReplies, ReplyRoute } from "./agent-reply.js";
import type { Principal } from "../inbox/envelope.js";
import type { MessageKind } from "../types.js";
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
   *
   * Once the send itself resolves, the reply is also recorded to the durable
   * conversation record — see ConversationRecorder and recordSafely below. A
   * failure THERE is a different kind of failure and must not surface here.
   */
  deliver(reply: string): Promise<void>;
}

/** Which assistant answered, and which turn produced the reply. */
export interface ResponderRecording {
  agentId: string;
  turnKey: string;
}

/** Picks the delivery route for a principal. One implementation per door. */
export interface ResponderFactory {
  /**
   * The PRINCIPAL says who is owed the reply; the RECORDING says what a
   * delivered reply must be written down under; the ROUTE says how to reach a
   * caller that carries no address of its own.
   *
   * `recording` is mandatory: both branches now record every delivered reply,
   * so both need to know which assistant answered and which turn produced it.
   * `route` stays optional and agent-only — a phone IS an address, so the
   * WhatsApp branch needs nothing more; an agent is reached through the
   * exchange it opened (the conversation key, plus, when it set one, a
   * callback URL the door has already validated), and the factory refuses
   * rather than returning a responder that would drop the reply when neither
   * exists.
   */
  for(principal: Principal, recording: ResponderRecording, route?: ReplyRoute): Responder;
}

/**
 * Writes a delivered reply to the durable conversation record.
 *
 * A narrow port, not a database handle: Responders' own job is delivery, and
 * the write itself belongs to recordOutboundMessage (data/repo.ts) — which is
 * idempotent per (conversation, turn, body) and MUST be called only after a
 * successful send, exactly as deliver()'s contract requires. Injected so this
 * module, and every test in responder.test.ts, stays free of a real DB — the
 * same reason WhatsAppChannel is an interface here rather than a concrete
 * transport.
 */
export interface ConversationRecorder {
  record(input: {
    conversationKey: string;
    agentId: string;
    turnKey: string;
    body: string;
    /** Defaults to 'text' on the writing side; nothing this build sends is anything else. */
    kind?: MessageKind;
  }): void;
}

export interface RespondersDeps {
  channel: WhatsAppChannel;
  recorder: ConversationRecorder;
  /** Only the level a recording failure is logged at — see recordSafely. */
  log: Pick<FastifyBaseLogger, "error">;
  /** Absent in a build with no agent door: the branch below then refuses. */
  agentReplies?: AgentReplies;
}

/**
 * The two ways a reply leaves this process: a WhatsApp message, or the answer
 * to an agent that asked. Both are now also a write to the conversation
 * record, once the send itself has actually happened.
 *
 * The agent branch still THROWS when this build wired no agent replies, or when
 * a caller arrives with no route — instead of returning a responder that
 * quietly drops the reply. Reaching either case means a door was wired up
 * without its return path, which is precisely the failure this seam exists to
 * prevent; it surfaces as a failed batch (retried, then an apology) rather than
 * as a silent success.
 */
export class Responders implements ResponderFactory {
  constructor(private readonly deps: RespondersDeps) {}

  for(principal: Principal, recording: ResponderRecording, route?: ReplyRoute): Responder {
    switch (principal.kind) {
      case "whatsapp": {
        // The phone is captured HERE, not read at deliver() time: conversations
        // run concurrently in this process, and a responder that resolved its
        // address later could answer the wrong person.
        const { phone } = principal;
        return {
          deliver: async (reply: string) => {
            await this.deps.channel.sendText(phone, reply);
            // The phone IS the conversation key on this door (batcher.ts) —
            // no route object is needed to know it, and none is required of
            // this branch's caller for that reason.
            this.recordSafely({
              conversationKey: phone,
              agentId: recording.agentId,
              turnKey: recording.turnKey,
              body: reply,
            });
          },
        };
      }
      case "agent": {
        const replies = this.deps.agentReplies;
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
        return {
          deliver: async (reply: string) => {
            await replies.deliver(bound, reply);
            this.recordSafely({
              conversationKey: bound.conversationKey,
              agentId: recording.agentId,
              turnKey: recording.turnKey,
              body: reply,
            });
          },
        };
      }
    }
  }

  /**
   * Record a delivered reply without letting a recording failure undo the
   * delivery.
   *
   * deliver()'s own contract is that a TRANSPORT failure propagates so a
   * failed batch retries. A failure to WRITE the record is a different kind of
   * problem: by the time this runs the person already has the message, so
   * throwing here would return the batch's rows to 'pending' and resend a
   * reply that was already delivered — worse than an unrecorded one (compare
   * recordOutboundMessage's own contract in repo.ts: under-counting the
   * record is the safe direction, inventing a second delivery is not).
   *
   * Logged at ERROR rather than swallowed quietly: a silent gap in the record
   * is exactly the failure this whole seam exists to catch.
   */
  private recordSafely(input: {
    conversationKey: string;
    agentId: string;
    turnKey: string;
    body: string;
  }): void {
    try {
      this.deps.recorder.record(input);
    } catch (err) {
      this.deps.log.error({ err, ...input }, "a delivered reply was not recorded");
    }
  }
}
