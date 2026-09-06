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
 * WHERE THIS LIVES TODAY: with only the WhatsApp door built, the batcher
 * flattens these fields into a TurnContext plus the joined batch text at the
 * moment it claims a burst (inbox/batcher.ts). This interface is the contract
 * those fields have to keep — written down now so the second door adds a
 * producer rather than a change of shape, which would land on the runtime, the
 * session key and the responder at once.
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
