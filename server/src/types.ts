import type { Principal } from "./inbox/envelope.js";

export type Role = "owner" | "customer";

/**
 * What a captured lead is for.
 *
 * Retail-shaped, unlike the real-estate build's visit requests: the three
 * things a customer wants when they do not buy right now are to be told when
 * something returns, to ask about something we do not carry, or to be called
 * back. Mirrored in the leads table's CHECK constraint (data/db.ts).
 */
export type LeadType = "inquiry" | "back_in_stock" | "follow_up";

/**
 * Whether an inbound message carried media. The webhook knows this from the
 * event it parsed, so it is PERSISTED with the row rather than re-derived from
 * agent_text later: a photo's caption is stored as its text, so any attempt to
 * recognise a photo by its wording silently misses every captioned one.
 * Lives here, not in the batcher, so data/repo.ts can type the column without
 * importing back from a module that already imports it.
 */
export type MessageKind = "text" | "media";

export interface Lead {
  id: number;
  phone: string;
  /** The SKU or handle the lead is about — free text, see data/db.ts. */
  product_code: string | null;
  type: LeadType;
  name: string | null;
  note: string | null;
  status: string;
  created_at: string;
}

/**
 * One inbound WhatsApp message, parsed out of the bridge's wire format.
 *
 * Lives here rather than next to the parser so the webhook route and the parser
 * can both name it without importing each other.
 */
export interface InboundMessage {
  from: string;
  /**
   * "audio" is a voice note or an attached audio file, which the bridge treats
   * identically. It carries NO text of its own — WhatsApp has no caption field
   * for audio — so the pipeline has to keep it alive on its media alone until
   * the worker transcribes it.
   */
  kind: "text" | "image" | "audio" | "interactive" | "other";
  /** WhatsApp message id, used for dedupe. */
  id?: string;
  /**
   * `ref` rather than `url`: it is a path in the bridge's staging directory,
   * resolvable only by the channel that produced it (see whatsapp/channel.ts).
   */
  agentText: string;
  media?: { ref: string; filename?: string; contentType?: string };
  /**
   * When WhatsApp says the person sent this, in unix seconds.
   *
   * Only the Cloud API provides it, and it exists for one reason: Meta does NOT
   * guarantee webhook ordering, while the bridge's outbox did. Arrival order is
   * listing order for a photo burst — the first photo becomes the product's
   * cover — so on that provider the order has to be reconstructed from what
   * WhatsApp stamped rather than from when we happened to receive it.
   *
   * Second resolution, so photos shot in the same second still tie; the
   * pending_media query falls back to arrival order for those (data/repo.ts).
   */
  sentAt?: number;
}

/** Context bound to the tools for a single inbound message turn. */
export interface TurnContext {
  /**
   * WHO is asking, as the door that authenticated them stamped it.
   *
   * The authority for the two fields below: `phone` and `role` are conveniences
   * derived from a WhatsApp principal and are ABSENT for any other kind, so a
   * consumer that branches on the principal reads the same truth the envelope
   * carries, while one that reaches for a phone finds `undefined` and has to
   * say what it means. That is deliberate — a rate limiter keyed on an absent
   * phone throttles every agent caller at once, and it does it silently.
   */
  principal: Principal;
  /**
   * Where a reply goes on the WhatsApp door, and the number the owner allowlist
   * judges. ABSENT for a principal that has none: an agent caller has an id and
   * a credential, and inventing a phone-shaped string for it is how one ends up
   * in `contacts`, or on the receiving end of a send.
   */
  phone?: string;
  /**
   * The WhatsApp allowlist role. ABSENT for an agent caller, and that is not a
   * gap to be filled in: no allowlist entry can name an agent, so there is
   * nothing for `isOwner` to answer. An agent caller's privileges are the
   * TARGET definition's `tools[]` plus the registry's `reach` — both
   * server-side, both data, neither derived from a role. Defaulting this to
   * "customer" would put an authenticated internal caller behind a kill switch
   * and a per-phone rate limiter written for people; defaulting it to "owner"
   * would hand it the store. So it is absent, and every consumer says which it
   * meant.
   */
  role?: Role;
  /**
   * Which agent answers this turn — the persona, and half of the session key.
   *
   * Derived from the role today (see router.ts) and from an agent definition
   * later. Kept beside `role` rather than instead of it because the role still
   * selects the prompt and the tool set; when those move into definitions, the
   * agent id is what remains.
   */
  agentId: string;
  /**
   * Which conversation this turn belongs to: the other half of the session key,
   * and what the work queue serializes on.
   *
   * For a WhatsApp principal this IS `phone`, and the duplication is
   * deliberate — `phone` is an ADDRESS (where a reply goes, who the allowlist
   * judges) and this is an IDENTITY of a running conversation. A door whose
   * caller has no phone still has conversations, and collapsing the two fields
   * is what forces such a door to invent a fake phone number.
   */
  conversationKey: string;
  /**
   * A stable identifier for the batch of messages that triggered this turn,
   * derived from the inbox rows being processed.
   *
   * This is what makes a stock adjustment safe to retry. Delivery is
   * at-least-once by design — rows are replayed on boot and a failed batch is
   * retried — so a `delta` mutation would otherwise be applied twice and remove
   * six shirts where the owner sold three, with nothing anywhere recording that
   * it happened. Passed to Shopify as the idempotency key (see
   * shopify/catalog.ts adjustInventory).
   */
  turnKey: string;
  /**
   * How many agent-to-agent hops produced this turn. Zero from a human door.
   *
   * REQUIRED, and read by `ask_agent` to derive the hop of the call it makes:
   * the outbound hop is this + 1, computed by the tool from the turn rather
   * than taken from anything the model wrote. A caller that could set its own
   * hop could reset it to zero on every call, and the loop guard would then be
   * only as good as the politeness of the thing it guards against.
   */
  hop: number;
  /**
   * Set by a tool to change what happens to the stored agent session AFTER
   * this turn completes. "reset" clears it instead of persisting the new id,
   * so the next message starts a fresh conversation. This mutable field is the
   * only in-process channel from a tool back to runAgentTurn.
   */
  sessionAfterTurn?: "reset";
}
