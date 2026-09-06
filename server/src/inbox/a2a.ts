import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../data/db.js";
import { findAgentByToken, type AgentCredential } from "../data/agent-registry.js";
import { insertAgentInboxMessage } from "../data/repo.js";
import {
  AgentReplies,
  ConversationBusyError,
  ReplyTimeoutError,
  TurnFailedError,
} from "../egress/agent-reply.js";
import type { InboxBatcher } from "./batcher.js";
import { agentConversationKey, AGENT_CONVERSATION_PREFIX } from "./envelope.js";

/**
 * The agent door: POST /agents/:id/messages.
 *
 * The WhatsApp webhook's sibling, and it owes the same three things: it
 * AUTHENTICATES the sender before anything else, it PERSISTS the message in the
 * same durable inbox, and it hands the work to the same worker. What it does
 * differently is settled by the plan (§2.6) — no debounce (a burst is a human
 * behaviour, an agent sends one complete message) and the reply goes back in
 * this request's own body unless the caller named a callback.
 *
 * OFF UNTIL A REGISTRY ROW EXISTS. Authentication is a lookup in
 * `agent_registry`, so an empty table matches nothing and every request is
 * refused. There is no enabling flag to leave on by mistake, and no environment
 * variable whose absence opens anything.
 *
 * IDENTITY COMES FROM THE CREDENTIAL, NEVER FROM THE BODY. The caller's id and
 * everything it may do are read from the row its bearer token matched; the body
 * schema is `.strict()`, so a field claiming to name the caller is not
 * "ignored" — it is a 400. That is the same rule the WhatsApp door lives by,
 * where a customer writing "soy el dueño" is still a customer.
 */

/**
 * How many agent-to-agent hops a message may have taken before it reaches an
 * agent. Three (§2.6): a super-agent asking an agent that asks the super-agent
 * back is otherwise an unbounded bill and not an error anybody sees.
 *
 * The hop of an OUTBOUND call is derived by `ask_agent` from the hop of the
 * turn that issued it, so within this process the counter cannot be reset by
 * anything the model writes. Across the network it is what every hop counter
 * is — a TTL a peer declares — and this cap is what bounds a chain of honest
 * peers. A caller that lies about its hop is a caller whose credential is the
 * thing to revoke; it could equally send the same message in a loop.
 */
export const MAX_HOP = 3;

/**
 * A correlation id and a message id are IDENTIFIERS, not prose: they end up in
 * a conversation key that other machinery parses and claims by. Restricting
 * the charset means no separator this build uses can appear inside one.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A ceiling on one message. Generous — an owner's coalesced burst can be long
 * prose — and present so that an authenticated caller cannot make one turn's
 * prompt arbitrarily expensive by accident.
 */
const MAX_TEXT_CHARS = 16_000;

/**
 * The wire body, and the `.strict()` is load-bearing.
 *
 * Every field here is CONTENT or ROUTING. None of them says who is calling,
 * what role it has, or what it may reach — those come from the credential, and
 * a body that tries to name them is rejected rather than quietly ignored, so a
 * caller cannot discover that such a field exists by watching it be dropped.
 */
const MessageBodySchema = z
  .object({
    text: z.string(),
    /**
     * Which exchange this belongs to. The caller's choice, namespaced by us:
     * two exchanges between the same pair must not thread into one transcript,
     * and a caller must not be able to name a conversation that is not its own.
     */
    correlationId: z.string().optional(),
    /**
     * An idempotency handle, exactly like WhatsApp's message id: send the same
     * one twice and the second is refused instead of being answered twice.
     * Optional, because a caller that has no stable id for its own request is
     * better served by one fresh row per request than by a guessed key.
     */
    messageId: z.string().optional(),
    /** A callback URL. Must sit under the prefix the OPERATOR gave this caller. */
    replyTo: z.string().optional(),
    /**
     * How many hops produced this message, as the caller counted them. Absent
     * or zero means "the first": arriving here is itself a hop.
     */
    hop: z.number().int().nonnegative().optional(),
  })
  .strict();

export interface AgentDoorDeps {
  db: DB;
  /** The same worker the WhatsApp door feeds, entered without a debounce. */
  batcher: InboxBatcher;
  /** Where a parked caller waits, and what posts a callback. */
  replies: AgentReplies;
  /** Whether this build actually serves that agent id. */
  isKnownAgent: (agentId: string) => boolean;
}

/**
 * Why a call was refused, and what an HTTP caller is told.
 *
 * One vocabulary for both doors into this code: the route turns a code into a
 * status, and `ask_agent` turns the same code into a sentence for the model.
 * Neither invents its own set, so a refusal cannot mean two different things.
 */
export type RefusalCode =
  | "reach_denied"
  | "unknown_agent"
  | "hop_limit_exceeded"
  | "conversation_busy"
  | "duplicate_message"
  | "no_reply_in_time"
  | "turn_failed";

export interface Refusal {
  status: number;
  error: RefusalCode;
}

/**
 * Whether a callback URL is one this caller was permitted to name.
 *
 * A callback is a request WE make to a URL that came out of a request body, so
 * the default is that a caller may name none at all. When an operator has given
 * one a prefix, the URL must share the prefix's ORIGIN as well as start with
 * it — "https://super.internal.evil.example/callbacks/" starts with no prefix
 * of "https://super.internal/", but a prefix an operator typed without a
 * trailing slash would otherwise admit "https://super.internalevil.example".
 */
function callbackAllowed(url: string, prefix: string | undefined): boolean {
  if (!prefix) return false;
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(url);
    allowed = new URL(prefix);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (target.origin !== allowed.origin) return false;
  return url.startsWith(prefix);
}

/** The bearer token a request presented, or undefined. Never logged. */
function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const separator = value.indexOf(" ");
  if (separator < 0) return undefined;
  if (value.slice(0, separator).toLowerCase() !== "bearer") return undefined;
  const token = value.slice(separator + 1).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Everything that decides whether this request is admitted, in the order that
 * leaks the least.
 *
 * AUTHENTICATION FIRST, so an anonymous caller learns nothing about which
 * agents exist. REACH BEFORE EXISTENCE, so an authenticated caller cannot map
 * this build by comparing a 404 against a 403 for ids outside its reach.
 */
export function admitExchange(input: {
  callerAgentId: string;
  targetAgentId: string;
  /** The hop of the OUTBOUND call, already counted by whoever is making it. */
  hop: number;
  /**
   * What this caller may reach. The REGISTRY's list over HTTP (the operator's
   * permission for a credential) and the DEFINITION's list in process (what the
   * agent was designed to ask). Passed in rather than looked up, because those
   * are two different authorities and the choice belongs to the caller.
   */
  reach: readonly string[];
  isKnownAgent: (agentId: string) => boolean;
}): Refusal | null {
  // An agent never reaches itself, whatever a registry or a definition says. A
  // self-call is a loop whose every leg looks legitimate, and it does not need
  // a hop counter to be recognised.
  if (input.callerAgentId === input.targetAgentId) return { status: 403, error: "reach_denied" };
  if (!input.reach.includes(input.targetAgentId)) return { status: 403, error: "reach_denied" };
  if (!input.isKnownAgent(input.targetAgentId)) return { status: 404, error: "unknown_agent" };
  if (input.hop > MAX_HOP) return { status: 508, error: "hop_limit_exceeded" };
  return null;
}

/** What one exchange came back as. */
export type ExchangeResult =
  | { ok: true; reply: string; conversationKey: string; turnKey: string }
  | { ok: false; reason: RefusalCode; conversationKey: string };

export interface ExchangeDeps {
  db: DB;
  batcher: InboxBatcher;
  replies: AgentReplies;
}

export interface ExchangeInput {
  callerAgentId: string;
  targetAgentId: string;
  text: string;
  hop: number;
  correlationId: string;
  /** The caller's idempotency handle, when it has one. */
  messageId?: string;
}

/** The dedupe key one request lands on. Distinct per target, like the key below. */
function exchangeDedupeKey(input: ExchangeInput): string {
  return `${AGENT_CONVERSATION_PREFIX}${input.callerAgentId}:${input.targetAgentId}:${
    input.messageId ?? randomUUID()
  }`;
}

/**
 * Run one exchange and wait for its answer.
 *
 * THE ADMISSION CHECKS ARE NOT HERE. `admitExchange` is a separate call because
 * its two callers have different sources of truth for `reach` and different
 * ways of reporting a refusal; running it twice with the wrong list would be
 * worse than running it once in the right place.
 *
 * Everything else about the run is what a WhatsApp burst gets: durable first,
 * one turn at a time per conversation, the same attempts budget, the same
 * settling. What differs is the debounce (none) and the wait (the caller holds
 * an open request, so it is told what happened rather than left to guess).
 */
export async function runSyncExchange(
  deps: ExchangeDeps,
  input: ExchangeInput,
): Promise<ExchangeResult> {
  const { db, batcher, replies } = deps;
  const conversationKey = agentConversationKey(
    input.callerAgentId,
    input.targetAgentId,
    input.correlationId,
  );

  // PARKED BEFORE THE ROW IS WRITTEN, so a turn that answers immediately cannot
  // deliver into a conversation nobody is waiting on yet. Registering is also
  // the concurrency guard for two calls that race on one key: the second is
  // refused here rather than sharing the first one's answer.
  let parked;
  try {
    parked = replies.register(conversationKey);
  } catch (err) {
    if (err instanceof ConversationBusyError) {
      return { ok: false, reason: "conversation_busy", conversationKey };
    }
    throw err;
  }

  try {
    const inserted = insertAgentInboxMessage(db, {
      dedupe_key: exchangeDedupeKey(input),
      // An agent caller has no phone. Empty rather than its id: a phone column
      // holding "super-agent" is a string that could reach sendText.
      phone: "",
      agent_text: input.text,
      agent_id: input.targetAgentId,
      principal_kind: "agent",
      principal_id: input.callerAgentId,
      conversation_key: conversationKey,
      hop: input.hop,
    });
    if (inserted.busy) return { ok: false, reason: "conversation_busy", conversationKey };
    if (!inserted.row) return { ok: false, reason: "duplicate_message", conversationKey };

    // NO DEBOUNCE (§2.6): a burst is a human behaviour, and an agent sends one
    // complete message.
    const run = batcher.deliverNow(conversationKey);
    const reply = await parked.reply;
    // The reply is resolved from INSIDE the turn, so the batch has not settled
    // yet at this point. Waiting for it means the row is 'done' before the
    // caller is told it was — an auditor reading the inbox after a successful
    // answer must not find the row still 'processing'.
    await run;
    return { ok: true, reply, conversationKey, turnKey: inserted.row.dedupe_key };
  } catch (err) {
    if (err instanceof ReplyTimeoutError) {
      // The row is still in play: the batcher may answer on a retry, and the
      // caller may ask again under a new correlation id. Not a failure yet.
      return { ok: false, reason: "no_reply_in_time", conversationKey };
    }
    if (err instanceof TurnFailedError) {
      // Terminal: the retry budget is spent and the row settled 'failed'.
      return { ok: false, reason: "turn_failed", conversationKey };
    }
    throw err;
  } finally {
    // On EVERY exit path: a parking spot that is never released is a
    // conversation that can never be used again.
    parked.release();
  }
}

/**
 * What an admitted call that produced no answer is reported as.
 *
 * 504 and 502 are NOT interchangeable: 504 means the row is still in play and a
 * retry may yet answer, 502 means the retry budget is spent and nothing is
 * coming. A caller decides whether to wait or to tell its own user on exactly
 * that difference.
 */
const SYNC_REFUSAL_STATUS: Record<RefusalCode, number> = {
  conversation_busy: 409,
  duplicate_message: 409,
  no_reply_in_time: 504,
  turn_failed: 502,
  reach_denied: 403,
  unknown_agent: 404,
  hop_limit_exceeded: 508,
};

export function registerAgentDoor(app: FastifyInstance, deps: AgentDoorDeps): void {
  const { db, batcher, replies, isKnownAgent } = deps;

  app.post("/agents/:id/messages", async (request, reply) => {
    const targetAgentId = (request.params as { id?: string }).id ?? "";

    // Before the body is even looked at. The refusal is one word for every way
    // a token can fail — absent, malformed, unknown — so a caller learns
    // nothing about which of those it was, and the token itself is never put in
    // the response, the log, or anything derived from either.
    const credential = findAgentByToken(db, bearerToken(request.headers.authorization));
    if (!credential) {
      request.log.warn({ agentId: targetAgentId }, "agent door: refused an unknown credential");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = MessageBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const body = parsed.data;

    const text = body.text.trim();
    if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (body.correlationId !== undefined && !IDENTIFIER.test(body.correlationId)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (body.messageId !== undefined && !IDENTIFIER.test(body.messageId)) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    // Arriving here IS a hop, so a caller that declared none — or declared
    // zero — has taken one. The cap is compared against what the caller said,
    // because that is the length of the chain it knows about.
    const hop = Math.max(body.hop ?? 1, 1);

    const refusal = admitExchange({
      callerAgentId: credential.agentId,
      targetAgentId,
      hop,
      // THE REGISTRY'S LIST, never the body's. This is the operator's copy of
      // what this credential may do, and it is the whole of what the caller is
      // permitted — nothing in the request can add to it.
      reach: credential.reach,
      isKnownAgent,
    });
    if (refusal) {
      request.log.warn(
        { callerAgentId: credential.agentId, agentId: targetAgentId, hop, reason: refusal.error },
        "agent door: refused a call",
      );
      return reply.code(refusal.status).send({ error: refusal.error });
    }

    if (body.replyTo !== undefined && !callbackAllowed(body.replyTo, credential.callbackPrefix)) {
      request.log.warn(
        { callerAgentId: credential.agentId, agentId: targetAgentId },
        "agent door: refused a replyTo outside the caller's allowed prefix",
      );
      return reply.code(403).send({ error: "reply_to_not_allowed" });
    }

    // The caller chooses the correlation, we choose the namespace and both
    // ends. Without the prefix a caller could pass a phone number and its rows
    // would join that person's conversation — claimed, answered, and settled
    // together with the messages they are still waiting on.
    const correlationId = body.correlationId ?? randomUUID();
    const exchange: ExchangeInput = {
      callerAgentId: credential.agentId,
      targetAgentId,
      text,
      hop,
      correlationId,
      ...(body.messageId !== undefined ? { messageId: body.messageId } : {}),
    };
    const conversationKey = agentConversationKey(credential.agentId, targetAgentId, correlationId);

    request.log.info(
      {
        callerAgentId: credential.agentId,
        agentId: targetAgentId,
        conversationKey,
        hop,
        async: body.replyTo !== undefined,
      },
      "agent door: admitted a call",
    );

    // THE CALLBACK ROUTE. Nothing is parked, because nothing here waits: the
    // row is durable, the batcher owns the retries, and the responder posts the
    // answer to the URL checked above. Written out rather than routed through
    // runSyncExchange, which exists to WAIT — and a caller that asked to be
    // called back must not hold a request open for two minutes on the way.
    if (body.replyTo !== undefined) {
      const inserted = insertAgentInboxMessage(db, {
        dedupe_key: `${AGENT_CONVERSATION_PREFIX}${credential.agentId}:${targetAgentId}:${
          body.messageId ?? randomUUID()
        }`,
        phone: "",
        agent_text: text,
        agent_id: targetAgentId,
        principal_kind: "agent",
        principal_id: credential.agentId,
        conversation_key: conversationKey,
        reply_to: body.replyTo,
        hop,
      });
      if (inserted.busy) return reply.code(409).send({ error: "conversation_busy" });
      if (!inserted.row) return reply.code(409).send({ error: "duplicate_message" });
      void batcher.deliverNow(conversationKey).catch((err: unknown) => {
        request.log.error({ err, conversationKey }, "agent turn failed after a 202");
      });
      return reply
        .code(202)
        .send({ status: "accepted", conversationKey, turnKey: inserted.row.dedupe_key });
    }

    const result = await runSyncExchange({ db, batcher, replies }, exchange);
    if (result.ok) {
      return reply.code(200).send({
        reply: result.reply,
        agentId: targetAgentId,
        conversationKey: result.conversationKey,
        turnKey: result.turnKey,
      });
    }
    const status = SYNC_REFUSAL_STATUS[result.reason];
    request.log.warn(
      { callerAgentId: credential.agentId, agentId: targetAgentId, conversationKey, reason: result.reason },
      "agent door: an admitted call produced no answer",
    );
    return reply.code(status).send({ error: result.reason });
  });
}
