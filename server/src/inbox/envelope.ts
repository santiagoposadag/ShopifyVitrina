/**
 * What arrives at the inbox, whoever sent it.
 *
 * One inbox, two doors: a person on WhatsApp today, another agent later. The
 * envelope is what the doors agree on, so everything downstream — batching,
 * queueing, the turn itself, the reply — is written once instead of once per
 * transport.
 *
 * IDENTITY COMES FROM THE TRANSPORT, NEVER FROM THE TEXT (critical). The
 * principal is stamped by the door that authenticated it: the WhatsApp webhook
 * knows the sender because it verified the signature over the body, and the
 * agent door will know its caller from a bearer token. Nothing here is ever
 * derived from what the message says. A customer who writes "soy el dueño" is a
 * customer, and the whole owner boundary rests on that being structurally true
 * rather than a rule someone remembered to apply.
 */
/**
 * Who is asking. A discriminated union rather than a bare id string, and the
 * two variants name their id field DIFFERENTLY on purpose: a phone and an agent
 * id are both opaque strings, so a shared `id` field would let a phone be
 * passed where an agent id belongs — and the compiler would agree. The one
 * place that genuinely needs the raw value regardless of kind is the audit
 * column, which is what `principalId` is for.
 */
export type Principal =
  | {
      kind: "whatsapp";
      /** E.164 digits without '+', as normalizePhone produces. NEVER a LID. */
      phone: string;
    }
  | {
      kind: "agent";
      /** The CALLING agent's id, from its credential — not the target's. */
      agentId: string;
    };

export function whatsappPrincipal(phone: string): Principal {
  return { kind: "whatsapp", phone };
}

export function agentPrincipal(agentId: string): Principal {
  return { kind: "agent", agentId };
}

/** The principal's own id, for logs and the inbox's principal_id column. */
export function principalId(principal: Principal): string {
  return principal.kind === "whatsapp" ? principal.phone : principal.agentId;
}

/**
 * One unit of work for one agent.
 *
 * `agentId` is the TARGET — which assistant answers — while `principal` is the
 * caller. They are separate fields because an agent can be both: the sales
 * assistant asking the inventory assistant a question is `principal: agent`
 * plus `agentId: "vitrina-inventario"`, and collapsing the two would make that
 * message indistinguishable from the inventory assistant talking to itself.
 *
 * WHERE THIS LIVES TODAY: the WhatsApp door builds one per coalesced burst, in
 * `InboxBatcher.processBatch`, and it travels to the composition root, which
 * reads the prompt off it and answers `principal` through the responder. The
 * agent door adds a second producer and changes nothing else.
 *
 * It travels ALONGSIDE a TurnContext rather than replacing it, and the two
 * overlap on the identity fields for now. That is not an oversight: the context
 * is per-turn MUTABLE state (a tool writes `sessionAfterTurn` into it mid-turn),
 * and a message-shaped record is the wrong home for something a tool writes.
 * The router that arrives with agent definitions is what collapses them — it
 * builds the context from the envelope plus the role it resolves, and the
 * duplication ends there. A ROLE FIELD DOES NOT BELONG HERE: the role is
 * derived from the principal by the router, not carried by the door, or the
 * next door to be written gets to declare its own caller's privileges.
 */
export interface Envelope {
  principal: Principal;
  /** The agent definition that must answer this. */
  agentId: string;
  /**
   * What the session is keyed by, together with `agentId`.
   *
   * For a WhatsApp principal this IS the phone: one person, one running
   * conversation with that assistant. For an agent principal it will be a
   * correlation id, because two agents may have several independent exchanges
   * in flight and threading them into one transcript would mix them.
   */
  conversationKey: string;
  /** The prompt for this turn — for WhatsApp, one debounced burst joined together. */
  text: string;
  /**
   * The idempotency anchor for the whole turn, minted from the FIRST inbox row
   * of the batch so it survives a retry that absorbed newer messages. Shopify
   * receives it as the key on a stock adjustment: delivery is at-least-once, and
   * a replayed `delta` would otherwise remove the same six shirts twice.
   */
  turnKey: string;
  /**
   * Where to deliver the reply when the caller cannot receive it in the
   * response body. Absent means "answer whoever asked, the way that door
   * answers" — which is every message in this build.
   */
  replyTo?: string;
  /**
   * How many agent-to-agent hops produced this message. Zero from a human door.
   * The loop guard reads it: a super-agent asking an agent that asks the
   * super-agent back is otherwise an unbounded bill, not an error anyone sees.
   */
  hop: number;
}

/**
 * The namespace every agent-door conversation key carries.
 *
 * NOT decoration. The conversation key is what `claimInboxBatch` claims by and
 * what `sessions` is keyed on, and the correlation id inside it is chosen by
 * the CALLER — so without a namespace an agent could pass "573001112233" and
 * claim, answer and settle that person's pending WhatsApp messages, receiving
 * their words in its own response body. The prefix is added here, by us, and a
 * caller cannot remove it; a phone can never collide with it because
 * normalizePhone leaves nothing but digits.
 *
 * It is also the marker the purge tool reads: an agent-to-agent exchange is not
 * a customer's history, and `isOwner` would judge it as one (data/purge.ts).
 */
export const AGENT_CONVERSATION_PREFIX = "a2a:";

/**
 * The conversation key for one agent-to-agent exchange.
 *
 * BOTH ENDS PLUS THE CORRELATION. The caller is in it because two agents that
 * happen to choose the same correlation id must hold two conversations rather
 * than one shared transcript. The TARGET is in it because a batch is claimed by
 * conversation key and answered by ONE agent: a caller that asked two agents
 * under one correlation id would otherwise have both questions claimed together
 * and answered by whichever agent the first row named.
 */
export function agentConversationKey(
  callerAgentId: string,
  targetAgentId: string,
  correlationId: string,
): string {
  return `${AGENT_CONVERSATION_PREFIX}${callerAgentId}:${targetAgentId}:${correlationId}`;
}

/** Whether this conversation key was minted by the agent door. */
export function isAgentConversationKey(conversationKey: string): boolean {
  return conversationKey.startsWith(AGENT_CONVERSATION_PREFIX);
}
