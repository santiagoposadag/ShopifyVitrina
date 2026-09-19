import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isAgentConversationKey } from "../a2a-protocol.js";
import {
  authenticateAdminSession,
  countLiveAdminSessions,
  type AdminSession,
} from "../data/admin-sessions.js";
import type { DB } from "../data/db.js";
import {
  clearSessionId,
  countConversations,
  isConversationPaused,
  listConversationHandoffs,
  listConversations,
  listConversationMessages,
  listConversationToolCalls,
  listLeads,
  listPausedConversations,
  pauseConversation,
  recordOutboundMessage,
  releaseConversation,
  setLeadStatus,
  LEAD_STATUSES,
  type ConversationMessage,
  type LeadStatus,
  type MessageDirection,
  type ToolCall,
  type ToolOutcome,
} from "../data/repo.js";
import { AGENT_IDS } from "../router.js";
import type { WhatsAppChannel } from "../whatsapp/channel.js";

/**
 * The admin console: every conversation this deployment has held, what the
 * assistant DID inside each turn, the leads those turns captured — and the two
 * controls that let a human take one over.
 *
 * WHY IT EXISTS: the words alone do not answer the question an operator has
 * about an assistant that can reprice and delete products in a live store. A
 * reply saying "listo, quedó en $80.000" reads identically whether the write
 * succeeded, was refused by a business rule, or never happened.
 * `conversation_tool_calls` is where that difference lives, and this renders it
 * beside the message it explains.
 *
 * IT IS NO LONGER READ-ONLY, and that is a deliberate revision rather than
 * drift. The earlier version had no write route and said so as a structural
 * property. It gained three, because the thing it was built to reveal — a
 * customer escalated to a human — could be SEEN and not ACTED ON: the agent
 * kept answering over the person who was supposed to help them. The three are
 * narrow and each names one conversation or one lead: pause, release, and send
 * one message. There is still nothing here that touches the catalog, a role, or
 * a credential.
 *
 * EVERY HUMAN INTERVENTION SUSPENDS THE AGENT. Taking a lead and sending a
 * message both pause the conversation they touch, and the pause happens BEFORE
 * the message goes out — so there is no window in which an admin's words and
 * the agent's next reply interleave and the customer hears two voices answering
 * one question.
 *
 * AN EARLIER VERSION REFUSED INSTEAD, with a 409, on the reasoning that an
 * implicit takeover is one nobody remembers to undo. That reasoning was about
 * the RISK, not about correctness, and it paid for the risk with the very
 * confusion it meant to prevent: an admin marks a lead as theirs, starts
 * typing, and learns the rule from an error — while the assistant is still
 * answering that customer. The rule is now uniform and needs no explaining.
 *
 * What was traded away is the guarantee that every pause was deliberate, and
 * that cost is real: nothing auto-releases, so a conversation can be left
 * paused and answered by nobody. It is DEUDA #18, and the index carries a
 * banner naming how many are in that state, because a count in a status line
 * was missable and this failure is silent on both ends.
 *
 * AUTHENTICATION IS A SESSION, NOT A CREDENTIAL. An admin asks from their own
 * WhatsApp and is sent a link that dies on its own (see data/admin-sessions.ts
 * for the two deadlines and why the delivery channel forces them). A table with
 * no live session matches nothing and every path answers 404, so the surface is
 * shipped CLOSED with no second enabling flag — the same "off by default" story
 * as the agent door.
 *
 * WHAT IS EXPOSED IS LARGE: every customer's phone number, every message they
 * sent, and every catalog operation performed on their behalf. Those customers
 * are third parties under Ley 1581 (DEUDA #7 carries the retention decision
 * this sits on top of).
 */

/** The prefix every route lives under, so removal is one grep. */
const PREFIX = "/admin";

/**
 * How many conversations one page of the index may ask for.
 *
 * A CAP RATHER THAN A TRUSTED PARAMETER: the count comes off a query string, and
 * `listConversations` groups over the whole message table to answer it. An
 * unbounded limit would let one request render every conversation the store has
 * ever held into a single JSON document.
 */
const MAX_PAGE = 200;

/**
 * How many messages one thread renders, newest-last.
 *
 * `listConversationMessages` takes the MOST RECENT n when given a limit, so a
 * long conversation shows its recent end rather than its beginning. There is no
 * retention policy on that table (DEUDA #7), so a conversation has no bound on
 * how long it can get and the unbounded read is the one that needs a decision.
 */
const MAX_THREAD_MESSAGES = 500;

/**
 * How long one message an admin sends may be.
 *
 * WhatsApp's own limit is far higher; this is about what belongs in a chat
 * reply typed into a web form, and about not handing the transport a megabyte
 * because a paste went wrong.
 */
const MAX_ADMIN_MESSAGE_CHARS = 4096;

const IndexQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/**
 * A thread is named by BOTH halves of the session key.
 *
 * `agent` is required, not optional-with-a-default: one phone holds a separate
 * conversation with each persona, and a reader that omitted the scope would be
 * handed the two interleaved into a conversation that never happened.
 *
 * `.strict()` for the reason inbox/a2a.ts and the test console give: a silently
 * dropped field lets a caller believe such a field exists and might one day be
 * honoured.
 */
const ThreadQuerySchema = z.object({ key: z.string().min(1), agent: z.string().min(1) }).strict();

const PauseBodySchema = z
  .object({
    key: z.string().min(1),
    agent: z.string().min(1),
    reason: z.string().max(500).optional(),
  })
  .strict();

const ReleaseBodySchema = z.object({ key: z.string().min(1), agent: z.string().min(1) }).strict();

const MessageBodySchema = z
  .object({
    key: z.string().min(1),
    agent: z.string().min(1),
    body: z.string().trim().min(1).max(MAX_ADMIN_MESSAGE_CHARS),
  })
  .strict();

const LeadsQuerySchema = z
  .object({
    include_handled: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(100),
  })
  .strict();

const LeadStatusBodySchema = z
  .object({
    id: z.coerce.number().int().positive(),
    status: z.enum(LEAD_STATUSES as unknown as [LeadStatus, ...LeadStatus[]]),
  })
  .strict();

export interface AdminConsoleDeps {
  db: DB;
  /**
   * How an admin's reply reaches the person.
   *
   * The same seam every other send in this process goes through, so the console
   * is testable against a plain object — no HTTP client, no paired device. Its
   * absence is what a build with no transport would look like, and the send
   * route refuses rather than pretending.
   */
  channel: WhatsAppChannel;
}

/** The bearer token a request presented, or undefined. NEVER logged, never echoed. */
function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const separator = value.indexOf(" ");
  if (separator < 0) return undefined;
  if (value.slice(0, separator).toLowerCase() !== "bearer") return undefined;
  const token = value.slice(separator + 1).trim();
  return token.length > 0 ? token : undefined;
}
// Copied from the sibling doors rather than shared, on the same principle they
// copy it from each other: the credential surfaces stay disjoint, and a helper
// shared between them is the first thread tying them together.

/**
 * Headers every response here carries.
 *
 * `no-store` because the body is every customer's conversation and a cached
 * copy outlives the session that fetched it; `noindex` because the URL will be
 * pasted into a chat and chat clients fetch previews.
 */
function guardHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex");
}

/**
 * Who is asking, or a refusal already sent.
 *
 * TWO GATES, IN THIS ORDER. No live session is a CLOSED feature, so it answers
 * 404 on every path including the unauthenticated shell — "nobody has access"
 * must not be distinguishable from "not deployed". Only then is the token
 * looked at, and its refusal is one vocabulary for every way it can fail
 * (absent, malformed, unknown, expired, revoked) so a prober learns nothing
 * about which — in particular, not whether a token they hold is real but stale.
 */
function authenticate(
  db: DB,
  reply: FastifyReply,
  authorization: string | string[] | undefined,
): AdminSession | null {
  if (countLiveAdminSessions(db) === 0) {
    void guardHeaders(reply).code(404).send({ error: "not_found" });
    return null;
  }
  const session = authenticateAdminSession(db, bearerToken(authorization));
  if (!session) {
    void guardHeaders(reply).code(401).send({ error: "unauthorized" });
    return null;
  }
  return session;
}

/** Which assistant a stored agent id names, in the operator's words. */
function agentLabel(agentId: string): string {
  if (agentId === AGENT_IDS.owner) return "Inventario (dueño)";
  if (agentId === AGENT_IDS.customer) return "Ventas (cliente)";
  // An id from a build that served a third agent, or an a2a caller. Shown
  // verbatim rather than guessed at: a wrong label here would misattribute a
  // conversation to a persona that never held it.
  return agentId;
}

interface MessageView {
  direction: MessageDirection;
  body: string;
  kind: string;
  occurredAt: string;
  /** NULL when the assistant answered; the admin phone when a human did. */
  sentBy: string | null;
}

interface ToolCallView {
  ordinal: number;
  toolName: string;
  input: string;
  result: string;
  outcome: ToolOutcome;
  durationMs: number;
  occurredAt: string;
}

/**
 * One turn: what the person said, what the assistant did about it, and what was
 * answered.
 *
 * THE GROUPING IS turn_key, which both tables carry. That is what makes this
 * view possible at all: `conversation_messages` says one row per message rather
 * than one per coalesced prompt, and every message answered together shares a
 * turn key — so a burst of four photos and the one reply they produced belong
 * to one turn here, and the tool calls that ran in between sit between them.
 *
 * An admin's own messages arrive under their own synthetic turn keys, so each
 * appears as its own turn in the right chronological place rather than being
 * folded into whatever the agent was doing.
 */
interface TurnView {
  turnKey: string;
  occurredAt: string;
  messages: MessageView[];
  toolCalls: ToolCallView[];
}

/**
 * Interleave the two tables into turns, oldest first.
 *
 * ORDERED BY WHEN THE TURN STARTED, taken from its earliest row of either kind.
 * A turn with no messages at all is possible and is NOT dropped: a batch that
 * failed after its tools ran but before any reply was delivered leaves exactly
 * that shape, and it is the single most informative thing this console can show
 * — an assistant that wrote to the store and then went silent.
 *
 * Both inputs arrive already ordered by their own readers, so this preserves
 * insertion order within a turn rather than re-sorting.
 */
function toTurns(messages: ConversationMessage[], toolCalls: ToolCall[]): TurnView[] {
  const turns = new Map<string, TurnView>();

  const ensure = (turnKey: string, occurredAt: string): TurnView => {
    const existing = turns.get(turnKey);
    if (existing) {
      // The earliest stamp of either kind wins, so a turn whose tools ran
      // before its inbound row was stamped still sorts by when it began.
      if (occurredAt < existing.occurredAt) existing.occurredAt = occurredAt;
      return existing;
    }
    const created: TurnView = { turnKey, occurredAt, messages: [], toolCalls: [] };
    turns.set(turnKey, created);
    return created;
  };

  for (const message of messages) {
    ensure(message.turn_key, message.occurred_at).messages.push({
      direction: message.direction,
      body: message.body,
      kind: message.kind,
      occurredAt: message.occurred_at,
      sentBy: message.sent_by,
    });
  }
  for (const call of toolCalls) {
    ensure(call.turn_key, call.occurred_at).toolCalls.push({
      ordinal: call.ordinal,
      toolName: call.tool_name,
      input: call.input,
      result: call.result,
      outcome: call.outcome,
      durationMs: call.duration_ms,
      occurredAt: call.occurred_at,
    });
  }

  return [...turns.values()].sort((a, b) =>
    a.occurredAt === b.occurredAt
      ? a.turnKey.localeCompare(b.turnKey)
      : a.occurredAt < b.occurredAt
        ? -1
        : 1,
  );
}

/**
 * A turn key for a message a HUMAN sent.
 *
 * Synthetic because there is no inbox batch behind it — nothing was claimed,
 * nothing debounced. Namespaced `admin:` so it can never collide with a real
 * turn key (those are inbox dedupe keys) and so a reader can tell at a glance
 * that the turn had no agent in it. The session id plus the clock makes two
 * messages from one admin in one second distinct, which matters because the
 * outbound dedupe key includes the turn key: without it, an admin sending the
 * same word twice on purpose would record once.
 */
function adminTurnKey(sessionId: number): string {
  return `admin:${sessionId}:${Date.now()}`;
}

export function registerAdminConsole(app: FastifyInstance, deps: AdminConsoleDeps): void {
  const { db, channel } = deps;

  /**
   * The shell. UNAUTHENTICATED BECAUSE IT CANNOT BE AUTHENTICATED, and the
   * reason is the fragment: the token travels as `/admin#t=<token>`, and a
   * fragment is never sent to the server by any browser. The page reads
   * `location.hash` and puts the token in an `Authorization` header on the data
   * calls below.
   *
   * A QUERY-STRING TOKEN IS WHAT THIS AVOIDS. The server runs `logger: true`,
   * so `?t=<token>` would be written into the request log on every page load —
   * a live credential, at rest, in a file nobody thinks of as secret.
   */
  app.get(PREFIX, async (_request, reply) => {
    if (countLiveAdminSessions(db) === 0) {
      return guardHeaders(reply).code(404).send({ error: "not_found" });
    }
    return guardHeaders(reply).type("text/html; charset=utf-8").send(PAGE);
  });

  /** Every conversation, newest activity first, with paused ones marked. */
  app.get(`${PREFIX}/conversations`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = IndexQuerySchema.safeParse(request.query);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { limit, offset } = parsed.data;

    // One read for every paused pair, rather than a liveness query per row: the
    // page is 50 rows and the paused set is normally a handful, so this is one
    // small query instead of fifty index lookups.
    const paused = new Set(
      listPausedConversations(db).map((h) => `${h.conversation_key}\u0000${h.agent_id}`),
    );

    const conversations = listConversations(db, { limit, offset }).map((row) => ({
      conversationKey: row.conversation_key,
      agentId: row.agent_id,
      agentLabel: agentLabel(row.agent_id),
      messageCount: row.message_count,
      inboundCount: row.inbound_count,
      firstOccurredAt: row.first_occurred_at,
      lastOccurredAt: row.last_occurred_at,
      lastDirection: row.last_direction,
      lastBody: row.last_body,
      paused: paused.has(`${row.conversation_key}\u0000${row.agent_id}`),
    }));

    return guardHeaders(reply)
      .code(200)
      .send({ total: countConversations(db), limit, offset, pausedCount: paused.size, conversations });
  });

  /**
   * One conversation, as turns, plus its handoff state and history.
   *
   * The two reads are deliberately NOT one join in SQL. They are different
   * shapes — one row per message against one row per tool call — and a join
   * would multiply each message by that turn's tool count, leaving the
   * de-duplication to be done here anyway over a much larger result set.
   */
  app.get(`${PREFIX}/conversation`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = ThreadQuerySchema.safeParse(request.query);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { key, agent } = parsed.data;

    const messages = listConversationMessages(db, key, {
      limit: MAX_THREAD_MESSAGES,
      agentId: agent,
    });
    const toolCalls = listConversationToolCalls(db, key, agent);

    // An empty thread is a 404 rather than an empty 200: the pair naming it does
    // not exist, and answering 200 would make a mistyped key look like a
    // conversation somebody had and said nothing in.
    if (messages.length === 0 && toolCalls.length === 0) {
      return guardHeaders(reply).code(404).send({ error: "not_found" });
    }

    return guardHeaders(reply).code(200).send({
      conversationKey: key,
      agentId: agent,
      agentLabel: agentLabel(agent),
      // An agent-to-agent exchange has no person on the other end, so nothing
      // can be sent into it. Reported rather than discovered on a 400.
      replyable: !isAgentConversationKey(key),
      paused: isConversationPaused(db, key, agent),
      handoffs: listConversationHandoffs(db, key, agent),
      truncated: messages.length === MAX_THREAD_MESSAGES,
      turns: toTurns(messages, toolCalls),
    });
  });

  /**
   * Take a conversation over. The agent goes silent for it until released.
   *
   * Idempotent (see pauseConversation): two admins opening the same thread and
   * both hitting pause is ordinary, and it must not produce two handoffs that
   * a single release would only half close.
   */
  app.post(`${PREFIX}/conversation/pause`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = PauseBodySchema.safeParse(request.body);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { key, agent, reason } = parsed.data;

    const handoff = pauseConversation(db, {
      conversationKey: key,
      agentId: agent,
      pausedBy: session.phone,
      ...(reason !== undefined ? { reason } : {}),
    });
    request.log.warn(
      { conversationKey: key, agentId: agent, admin: session.phone, session: session.id },
      "admin console: a human took over a conversation; the agent is now silent for it",
    );
    return guardHeaders(reply).code(200).send({ paused: true, handoff });
  });

  /**
   * Give the conversation back to the agent.
   *
   * THE SESSION IS DROPPED, and that is the part worth explaining. While a
   * human held the conversation the agent ran no turns, so its transcript still
   * ends at the moment of the pause — and nothing the person or the admin said
   * in between is in it, because the SDK's transcript is written by turns and
   * there were none. Resuming that transcript would put the agent back into a
   * conversation that has moved on without it, confidently continuing from a
   * point everyone else has left: the customer writes "sí, como quedamos con
   * Santiago" and the agent answers about whatever it was doing an hour ago.
   *
   * Starting fresh loses context too, and says so instead of inventing it.
   * That is the same trade `sessionAfterTurn = "reset"` already makes on a
   * publish transition, and the same mechanism — the orphaned transcript is
   * collected by the housekeeping sweep.
   */
  app.post(`${PREFIX}/conversation/release`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = ReleaseBodySchema.safeParse(request.body);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { key, agent } = parsed.data;

    const closed = releaseConversation(db, {
      conversationKey: key,
      agentId: agent,
      releasedBy: session.phone,
    });
    // Only when something was actually released: a release that closed nothing
    // means the conversation was never paused, and dropping a live session
    // there would reset a conversation the agent is in the middle of.
    if (closed > 0) clearSessionId(db, agent, key);
    request.log.warn(
      { conversationKey: key, agentId: agent, admin: session.phone, closed },
      "admin console: a conversation was handed back to the agent",
    );
    return guardHeaders(reply).code(200).send({ paused: false, released: closed });
  });

  /**
   * Send one message into a conversation, as the business.
   *
   * REFUSED UNLESS THE CONVERSATION IS PAUSED. This is the invariant that makes
   * a handoff mean anything: without it the admin's message and the agent's
   * next reply interleave, and the customer gets two voices answering the same
   * question with neither aware of the other. The route refuses rather than
   * pausing on the admin's behalf, because an implicit takeover is one nobody
   * remembers to undo — and a conversation silently left paused is the failure
   * this whole surface exists to prevent, not one to introduce by convenience.
   *
   * RECORDED ONLY AFTER A SUCCESSFUL SEND, with `sent_by` naming the admin —
   * the same contract Responders.deliver keeps, for the same reason: a record
   * of a message the person never received is the failure the record exists to
   * make visible.
   */
  app.post(`${PREFIX}/conversation/message`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = MessageBodySchema.safeParse(request.body);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { key, agent, body } = parsed.data;

    // There is no person behind an a2a key — the conversation key is a
    // correlation id, and `sendText` would treat it as a phone number.
    if (isAgentConversationKey(key)) {
      return guardHeaders(reply).code(400).send({ error: "not_a_person" });
    }
    // ANY HUMAN INTERVENTION SUSPENDS THE AGENT, and sending is one — so this
    // pauses rather than refusing. An earlier version answered 409 and made the
    // admin pause first, on the reasoning that an implicit takeover is one
    // nobody remembers to undo. That reasoning was about the RISK, not about
    // correctness, and it bought the risk at the price of the confusion it was
    // meant to prevent: an admin typing a reply into a conversation the bot was
    // still answering, discovering the rule only from an error.
    //
    // The safety property is unchanged, because the pause happens BEFORE the
    // send, in the same request: there is still no window in which a human
    // message and an agent reply interleave. What is traded away is the
    // guarantee that every pause was deliberate — and that cost is DEUDA #18,
    // a conversation left paused and forgotten.
    if (!isConversationPaused(db, key, agent)) {
      pauseConversation(db, {
        conversationKey: key,
        agentId: agent,
        pausedBy: session.phone,
        reason: "respuesta directa desde el panel",
      });
      request.log.warn(
        { conversationKey: key, agentId: agent, admin: session.phone },
        "admin console: replying took the conversation over; the agent is now silent for it",
      );
    }

    const turnKey = adminTurnKey(session.id);
    try {
      await channel.sendText(key, body);
    } catch (err) {
      // Reported, never recorded: nothing was delivered. Logged with the error
      // because the admin is looking at a form and "no se pudo enviar" alone
      // does not tell an operator whether the transport is down.
      request.log.error(
        { err, conversationKey: key, admin: session.phone },
        "admin console: sending a message into a conversation failed",
      );
      // The pause above STAYS. A failed send is a human mid-reply, not a human
      // who changed their mind — resuming the agent here would put it back in
      // front of somebody who is still typing to them.
      return guardHeaders(reply).code(502).send({ error: "send_failed" });
    }

    recordOutboundMessage(db, {
      conversationKey: key,
      agentId: agent,
      turnKey,
      body,
      sentBy: session.phone,
    });
    return guardHeaders(reply).code(200).send({ sent: true, turnKey });
  });

  /** The leads panel: what the assistant escalated, and where each one came from. */
  app.get(`${PREFIX}/leads`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = LeadsQuerySchema.safeParse(request.query);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { include_handled, limit } = parsed.data;

    const leads = listLeads(db, { openOnly: include_handled !== true, limit }).map((lead) => ({
      id: lead.id,
      phone: lead.phone,
      type: lead.type,
      status: lead.status,
      name: lead.name,
      note: lead.note,
      productCode: lead.product_code,
      createdAt: lead.created_at,
      statusChangedAt: lead.status_changed_at,
      claimedBy: lead.claimed_by,
      // The link back to the exchange that produced it. NULL on a lead captured
      // before leads carried a provenance — an honest gap, not an invented one.
      conversationKey: lead.conversation_key,
      agentId: lead.agent_id,
      turnKey: lead.turn_key,
    }));

    return guardHeaders(reply).code(200).send({ leads });
  });

  /**
   * Move a lead through its lifecycle — and, on taking it, SUSPEND THE AGENT
   * for the conversation behind it.
   *
   * TAKING A LEAD IS A HUMAN INTERVENTION, and every human intervention
   * suspends the agent. Marking a lead as yours and then discovering the bot is
   * still answering that customer is the confusion this rule exists to remove:
   * the person is told a team member will follow up, a team member picks it up,
   * and the assistant keeps talking over them in between.
   *
   * CLOSING DOES NOT RELEASE, deliberately. "I am done with this lead" and "the
   * assistant may have this conversation back" are different statements —
   * somebody can close a lead and still be mid-exchange with the person. An
   * auto-release here would resume the agent mid-sentence, which is exactly
   * what `Nothing auto-releases a handoff` refuses to do.
   *
   * A lead from before leads carried a provenance has no conversation to pause,
   * and one whose conversation is an agent-to-agent key has no person behind
   * it. Both are reported as `paused: false` rather than failing: the lead's
   * status is the thing being changed, and it changed.
   */
  app.post(`${PREFIX}/lead/status`, async (request, reply) => {
    const session = authenticate(db, reply, request.headers.authorization);
    if (!session) return reply;

    const parsed = LeadStatusBodySchema.safeParse(request.body);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { id, status } = parsed.data;

    const lead = setLeadStatus(db, { id, status, claimedBy: session.phone });
    if (!lead) return guardHeaders(reply).code(404).send({ error: "not_found" });

    let paused = false;
    if (
      status === "in_progress" &&
      lead.conversation_key !== null &&
      lead.agent_id !== null &&
      !isAgentConversationKey(lead.conversation_key)
    ) {
      // Idempotent, so taking a lead whose conversation somebody else already
      // holds does not produce a second handoff (see pauseConversation).
      pauseConversation(db, {
        conversationKey: lead.conversation_key,
        agentId: lead.agent_id,
        pausedBy: session.phone,
        reason: `lead #${lead.id} tomado desde el panel`,
      });
      paused = true;
      request.log.warn(
        {
          leadId: lead.id,
          conversationKey: lead.conversation_key,
          agentId: lead.agent_id,
          admin: session.phone,
        },
        "admin console: a lead was taken; the agent is now silent for its conversation",
      );
    }

    // `paused` and the conversation are reported so the page can go straight
    // there — taking a lead and then hunting for its conversation is the
    // three-click path this replaces.
    return guardHeaders(reply).code(200).send({
      lead,
      paused,
      conversationKey: lead.conversation_key,
      agentId: lead.agent_id,
    });
  });
}

/**
 * The page. ONE template literal, no framework, no build step, no static file —
 * the same shape as the test console, for the same reason.
 *
 * THERE IS NO MARKUP-PARSING ASSIGNMENT IN THIS DOCUMENT. Every value rendered
 * here is untrusted in the strict sense: a customer's own words, a note an
 * admin typed, a tool result assembled from Shopify data. All of it is assigned
 * with `textContent` or inserted with `createTextNode`, which is a mechanism
 * rather than a rule someone has to remember. Its test pins that.
 *
 * User-visible copy is SPANISH. Everything else in this file is English.
 */
const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Panel de administración</title>
<style>
  :root { color-scheme: light dark; --line: #d1d5db; --dim: #6b7280; --warn: #b45309; --bad: #b91c1c; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 64px;
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 880px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); font-size: 14px; margin: 0 0 16px; }
  button, textarea, input { font: inherit; }
  button { cursor: pointer; }
  nav { display: flex; gap: 8px; margin-bottom: 18px; }
  nav button {
    border: 1px solid var(--line); background: transparent; color: inherit;
    border-radius: 999px; padding: 7px 16px;
  }
  nav button[aria-selected="true"] { border-color: currentColor; font-weight: 600; }
  .back { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 10px; padding: 8px 14px; margin-bottom: 16px; }
  .card, .convo {
    display: block; width: 100%; text-align: left;
    border: 1px solid var(--line); border-radius: 12px;
    padding: 12px 14px; margin-bottom: 10px; background: transparent; color: inherit;
  }
  .convo .top { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; }
  .meta { color: var(--dim); font-size: 13px; margin-top: 2px; }
  .preview { color: var(--dim); font-size: 14px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { display: inline-block; border: 1px solid currentColor; border-radius: 999px; font-size: 12px; padding: 1px 9px; margin-left: 6px; }
  .pill.paused { color: var(--warn); }
  .pill.new { color: #1d4ed8; }
  .pill.in_progress { color: var(--warn); }
  .pill.closed { color: var(--dim); }
  .turn { border-left: 3px solid var(--line); padding-left: 14px; margin: 0 0 22px; }
  .turn .when { color: var(--dim); font-size: 12px; margin-bottom: 8px; }
  .msg { border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; white-space: pre-wrap; }
  .msg.inbound { background: rgba(127,127,127,.14); }
  .msg.outbound { background: rgba(37,99,235,.14); }
  .msg.human { background: rgba(180,83,9,.16); }
  .msg .who { font-size: 12px; color: var(--dim); margin-bottom: 4px; }
  details.tool { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; font-size: 14px; }
  details.tool.error { border-color: var(--bad); }
  details.tool summary { cursor: pointer; font-weight: 600; }
  details.tool .badge { font-weight: 400; color: var(--dim); font-size: 13px; }
  details.tool .badge.error { color: var(--bad); }
  pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(127,127,127,.12); border-radius: 8px; padding: 10px; }
  pre .cap { display: block; color: var(--dim); font-size: 12px; margin-bottom: 4px; }
  .panel { border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin: 0 0 20px; position: sticky; top: 0; background: Canvas; }
  .panel h2 { font-size: 15px; margin: 0 0 8px; }
  .panel .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .panel button { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 10px; padding: 9px 16px; }
  .panel button.primary { border-color: currentColor; font-weight: 600; }
  textarea { width: 100%; min-height: 76px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: inherit; padding: 10px; margin-bottom: 8px; }
  .status { font-size: 15px; margin-top: 16px; min-height: 1.5em; }
  .status.error { color: var(--bad); }
  .more { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 10px; padding: 10px 16px; width: 100%; }
  .banner { border: 1px solid var(--warn); color: var(--warn); border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; font-size: 14px; }
  footer { margin-top: 32px; font-size: 13px; color: var(--dim); text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>Panel de administración</h1>
<p class="sub" id="subtitle">Conversaciones, lo que el asistente hizo en cada turno, y los leads que escaló.</p>

<nav id="tabs">
  <button id="tab-convos" type="button" aria-selected="true">Conversaciones</button>
  <button id="tab-leads" type="button" aria-selected="false">Leads</button>
</nav>

<button class="back" id="back" type="button" hidden>← Volver</button>

<div id="index" hidden>
  <div id="list"></div>
  <button class="more" id="more" type="button" hidden>Cargar más</button>
</div>

<div id="leads" hidden>
  <div class="row" style="margin-bottom:12px">
    <button class="more" id="toggle-handled" type="button">Mostrar también los cerrados</button>
  </div>
  <div id="leads-list"></div>
</div>

<div id="thread" hidden>
  <div class="panel" id="panel">
    <h2 id="panel-state"></h2>
    <p class="meta" id="panel-detail"></p>
    <div class="row">
      <button id="btn-pause" type="button">Responder yo (silencia al asistente)</button>
      <button id="btn-release" type="button" hidden>Devolver al asistente</button>
    </div>
    <div id="composer" hidden style="margin-top:12px">
      <textarea id="reply" placeholder="Escribe tu respuesta al cliente…"></textarea>
      <button class="primary" id="btn-send" type="button">Enviar como el negocio</button>
    </div>
  </div>
  <div id="turns"></div>
</div>

<p class="status" id="status">Cargando…</p>
<footer>Este enlace da acceso a datos de clientes reales y caduca solo.</footer>

<script>
(function () {
  "use strict";

  // The token lives in the FRAGMENT and never leaves the browser except as an
  // Authorization header. A query string would be written into the server's
  // request log on every page load.
  //
  // The keys c and g arrive the same way when a notification's landing code
  // named a conversation (admin/deep-link.ts). The conversation key IS a customer's
  // phone number, so it rides the fragment too rather than a query string —
  // keeping it out of the request log costs nothing here.
  var hash = new URLSearchParams(window.location.hash.slice(1));
  var token = hash.get("t");
  var deepLink = hash.get("c") && hash.get("g")
    ? { key: hash.get("c"), agent: hash.get("g") }
    : null;

  var statusEl = document.getElementById("status");
  var indexEl = document.getElementById("index");
  var listEl = document.getElementById("list");
  var leadsEl = document.getElementById("leads");
  var leadsListEl = document.getElementById("leads-list");
  var threadEl = document.getElementById("thread");
  var turnsEl = document.getElementById("turns");
  var backEl = document.getElementById("back");
  var moreEl = document.getElementById("more");
  var tabsEl = document.getElementById("tabs");
  var tabConvos = document.getElementById("tab-convos");
  var tabLeads = document.getElementById("tab-leads");
  var subtitleEl = document.getElementById("subtitle");
  var panelState = document.getElementById("panel-state");
  var panelDetail = document.getElementById("panel-detail");
  var btnPause = document.getElementById("btn-pause");
  var btnRelease = document.getElementById("btn-release");
  var composer = document.getElementById("composer");
  var replyEl = document.getElementById("reply");
  var btnSend = document.getElementById("btn-send");
  var toggleHandled = document.getElementById("toggle-handled");

  var PAGE_SIZE = 50;
  var offset = 0;
  var total = 0;
  var current = null;
  var includeHandled = false;

  function say(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "status error" : "status";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent is the ONLY way text enters this document. Every string
    // reaching here is untrusted — a customer's words, an admin's note, a
    // tool result — and its test pins that no markup-parsing assignment
    // exists anywhere on this page.
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function failed(response) {
    if (response.status === 401) {
      say("Tu sesión caducó o el enlace ya no es válido. Escribe \\"panel\\" al número del negocio para pedir uno nuevo.", true);
    } else if (response.status === 404) {
      say("No se encontró. Puede que el panel esté cerrado o que eso ya no exista.", true);
    } else if (response.status === 409) {
      say("Primero tienes que tomar la conversación. El asistente sigue atendiéndola.", true);
    } else if (response.status === 502) {
      say("No se pudo entregar el mensaje por WhatsApp. No se guardó nada.", true);
    } else {
      say("No se pudo completar la operación. Intenta de nuevo.", true);
    }
  }

  function call(path, options) {
    var init = options || {};
    init.headers = { "Authorization": "Bearer " + token };
    if (init.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }
    init.cache = "no-store";
    return fetch(path, init).then(function (response) {
      if (!response.ok) { failed(response); return null; }
      return response.json();
    });
  }

  function shorten(text, max) {
    var value = String(text === null || text === undefined ? "" : text);
    return value.length > max ? value.slice(0, max) + "…" : value;
  }

  // --- conversations ---------------------------------------------------------

  function renderConversation(row) {
    var card = el("button", "convo");
    card.type = "button";

    var top = el("div", "top");
    var left = el("span", null, row.conversationKey);
    if (row.paused) left.appendChild(el("span", "pill paused", "atendida por un humano"));
    top.appendChild(left);
    top.appendChild(el("span", null, row.agentLabel));
    card.appendChild(top);

    card.appendChild(el("div", "meta",
      row.messageCount + " mensajes · " + row.inboundCount + " de la persona · última actividad " +
      row.lastOccurredAt + " UTC"));
    card.appendChild(el("div", "preview",
      (row.lastDirection === "inbound" ? "Ellos: " : "Nosotros: ") + shorten(row.lastBody, 160)));

    card.addEventListener("click", function () { openThread(row.conversationKey, row.agentId); });
    return card;
  }

  // A conversation left paused is answered by NOBODY: the assistant is silent
  // and the human moved on. Nothing releases one automatically — a timer would
  // resume the bot mid-sentence — so the only defence is that it is impossible
  // to miss. A count buried in a status line was missable.
  function renderPausedBanner(count) {
    var existing = document.getElementById("paused-banner");
    if (existing) existing.remove();
    if (!count) return;
    var banner = el("div", "banner",
      "⏸ " + count + (count === 1
        ? " conversación está en manos de un humano y el asistente no le responde."
        : " conversaciones están en manos de un humano y el asistente no les responde."));
    banner.id = "paused-banner";
    indexEl.insertBefore(banner, listEl);
  }

  function loadPage() {
    say("Cargando…");
    return call("/admin/conversations?limit=" + PAGE_SIZE + "&offset=" + offset).then(function (data) {
      if (!data) return;
      total = data.total;
      data.conversations.forEach(function (row) { listEl.appendChild(renderConversation(row)); });
      offset += data.conversations.length;
      moreEl.hidden = offset >= total;
      renderPausedBanner(data.pausedCount);
      say(total === 0 ? "Todavía no hay conversaciones registradas." : "");
    });
  }

  // --- one thread ------------------------------------------------------------

  function renderMessage(message) {
    var human = message.sentBy !== null && message.sentBy !== undefined;
    var box = el("div", "msg " + message.direction + (human ? " human" : ""));
    var who = message.direction === "inbound" ? "Ellos"
      : human ? ("Humano · " + message.sentBy) : "Asistente";
    box.appendChild(el("div", "who", who));
    if (message.kind === "media" && message.body.length === 0) {
      box.appendChild(el("div", null, "(foto sin texto)"));
    } else {
      box.appendChild(el("div", null, message.body));
    }
    return box;
  }

  function renderBlock(label, body) {
    var pre = el("pre");
    pre.appendChild(el("span", "cap", label));
    pre.appendChild(document.createTextNode(body));
    return pre;
  }

  function renderTool(c) {
    var box = el("details", "tool" + (c.outcome === "error" ? " error" : ""));
    var summary = el("summary");
    summary.appendChild(document.createTextNode(c.ordinal + ". " + c.toolName));
    summary.appendChild(el("span", "badge" + (c.outcome === "error" ? " error" : ""),
      c.outcome === "error" ? "  — falló (" + c.durationMs + " ms)" : "  — " + c.durationMs + " ms"));
    box.appendChild(summary);
    box.appendChild(renderBlock("Argumentos", c.input));
    box.appendChild(renderBlock(c.outcome === "error" ? "Error" : "Resultado", c.result));
    return box;
  }

  function renderTurn(turn) {
    var box = el("div", "turn");
    box.appendChild(el("div", "when", turn.occurredAt + " UTC"));
    turn.messages.filter(function (m) { return m.direction === "inbound"; })
      .forEach(function (m) { box.appendChild(renderMessage(m)); });
    turn.toolCalls.forEach(function (c) { box.appendChild(renderTool(c)); });
    turn.messages.filter(function (m) { return m.direction === "outbound"; })
      .forEach(function (m) { box.appendChild(renderMessage(m)); });
    if (turn.messages.length === 0) {
      box.appendChild(el("div", "meta",
        "Este turno no dejó ningún mensaje: las herramientas corrieron y no se entregó respuesta."));
    }
    return box;
  }

  function renderPanel(data) {
    panelState.textContent = data.paused
      ? "Estás atendiendo esta conversación"
      : "La atiende el asistente";
    var last = data.handoffs && data.handoffs.length > 0 ? data.handoffs[0] : null;
    panelDetail.textContent = data.paused
      ? ("El asistente no responderá hasta que la devuelvas." + (last && last.paused_by ? " Tomada por " + last.paused_by + " el " + last.paused_at + " UTC." : ""))
      : (last
          ? "Si escribes, el asistente queda en silencio automáticamente. Última vez atendida por un humano: " + last.paused_at + " UTC."
          : "Si escribes, el asistente queda en silencio automáticamente con este cliente.");
    btnPause.hidden = data.paused;
    btnRelease.hidden = !data.paused;
    composer.hidden = !(data.paused && data.replyable);
    if (data.paused && !data.replyable) {
      panelDetail.textContent += " No se puede escribir en esta conversación: no hay una persona del otro lado.";
    }
  }

  function openThread(key, agentId) {
    say("Cargando conversación…");
    return call("/admin/conversation?key=" + encodeURIComponent(key) + "&agent=" + encodeURIComponent(agentId))
      .then(function (data) {
        if (!data) return;
        current = { key: key, agent: agentId };
        turnsEl.replaceChildren();
        subtitleEl.textContent = data.conversationKey + " · " + data.agentLabel;
        if (data.truncated) {
          turnsEl.appendChild(el("p", "sub", "Mostrando solo los mensajes más recientes."));
        }
        data.turns.forEach(function (turn) { turnsEl.appendChild(renderTurn(turn)); });
        renderPanel(data);
        indexEl.hidden = true; leadsEl.hidden = true; tabsEl.hidden = true;
        threadEl.hidden = false; backEl.hidden = false;
        say("");
        window.scrollTo(0, 0);
      });
  }

  function refreshThread() {
    if (!current) return Promise.resolve();
    return openThread(current.key, current.agent);
  }

  btnPause.addEventListener("click", function () {
    if (!current) return;
    btnPause.disabled = true;
    say("Tomando la conversación…");
    call("/admin/conversation/pause", { method: "POST", body: { key: current.key, agent: current.agent } })
      .then(function (data) { if (data) return refreshThread().then(function () { say("El asistente quedó en silencio para esta conversación."); }); })
      .finally(function () { btnPause.disabled = false; });
  });

  btnRelease.addEventListener("click", function () {
    if (!current) return;
    btnRelease.disabled = true;
    say("Devolviendo…");
    call("/admin/conversation/release", { method: "POST", body: { key: current.key, agent: current.agent } })
      .then(function (data) { if (data) return refreshThread().then(function () { say("El asistente vuelve a atenderla."); }); })
      .finally(function () { btnRelease.disabled = false; });
  });

  btnSend.addEventListener("click", function () {
    if (!current) return;
    var body = replyEl.value.trim();
    if (body.length === 0) { say("Escribe algo antes de enviar.", true); return; }
    btnSend.disabled = true;
    say("Enviando…");
    call("/admin/conversation/message", { method: "POST", body: { key: current.key, agent: current.agent, body: body } })
      .then(function (data) {
        if (!data) return;
        replyEl.value = "";
        return refreshThread().then(function () { say("Enviado."); });
      })
      .finally(function () { btnSend.disabled = false; });
  });

  // --- leads -----------------------------------------------------------------

  function renderLead(lead) {
    var card = el("div", "card");
    var top = el("div", "top");
    top.appendChild(el("strong", null, "#" + lead.id + " · " + lead.type));
    top.appendChild(el("span", "pill " + lead.status, lead.status));
    card.appendChild(top);
    card.appendChild(el("div", "meta",
      lead.phone + (lead.productCode ? " · " + lead.productCode : "") + " · " + lead.createdAt + " UTC" +
      (lead.claimedBy ? " · lo lleva " + lead.claimedBy : "")));
    if (lead.name) card.appendChild(el("div", null, lead.name));
    if (lead.note) card.appendChild(el("div", null, lead.note));

    var row = el("div", "row");
    row.style.marginTop = "10px";
    ["new", "in_progress", "closed"].forEach(function (status) {
      if (status === lead.status) return;
      // "Lo atiendo yo" says what it now does: it takes the lead AND silences
      // the assistant for that customer, then opens the conversation. The old
      // label read almost the same as the thread's own button while doing
      // something else entirely.
      var label = status === "new" ? "Reabrir"
        : status === "in_progress" ? "Lo atiendo yo →"
        : "Cerrar";
      var b = el("button", null, label);
      b.type = "button";
      b.style.border = status === "in_progress" ? "1px solid currentColor" : "1px solid var(--line)";
      b.style.background = "transparent";
      b.style.color = "inherit";
      b.style.borderRadius = "10px";
      b.style.padding = "7px 14px";
      if (status === "in_progress") b.style.fontWeight = "600";
      b.addEventListener("click", function () {
        b.disabled = true;
        call("/admin/lead/status", { method: "POST", body: { id: lead.id, status: status } })
          .then(function (data) {
            if (!data) return;
            // Taking it goes straight to the conversation: hunting for it
            // afterwards was the three-click path this replaces.
            if (status === "in_progress" && data.conversationKey && data.agentId) {
              return openThread(data.conversationKey, data.agentId).then(function () {
                say(data.paused
                  ? "Tomaste este lead. El asistente quedó en silencio con este cliente — escríbele tú."
                  : "Tomaste este lead. No tiene una conversación asociada que pausar.");
              });
            }
            return loadLeads();
          })
          .finally(function () { b.disabled = false; });
      });
      row.appendChild(b);
    });

    if (lead.conversationKey && lead.agentId) {
      var open = el("button", null, "Ver la conversación");
      open.type = "button";
      open.style.border = "1px solid currentColor";
      open.style.background = "transparent";
      open.style.color = "inherit";
      open.style.borderRadius = "10px";
      open.style.padding = "7px 14px";
      open.addEventListener("click", function () { openThread(lead.conversationKey, lead.agentId); });
      row.appendChild(open);
    }
    card.appendChild(row);
    return card;
  }

  function loadLeads() {
    say("Cargando leads…");
    return call("/admin/leads" + (includeHandled ? "?include_handled=true" : "")).then(function (data) {
      if (!data) return;
      leadsListEl.replaceChildren();
      data.leads.forEach(function (lead) { leadsListEl.appendChild(renderLead(lead)); });
      say(data.leads.length === 0
        ? (includeHandled ? "No hay leads." : "No hay leads pendientes.")
        : "");
    });
  }

  toggleHandled.addEventListener("click", function () {
    includeHandled = !includeHandled;
    toggleHandled.textContent = includeHandled ? "Mostrar solo los pendientes" : "Mostrar también los cerrados";
    loadLeads();
  });

  // --- navigation ------------------------------------------------------------

  function showTab(which) {
    current = null;
    threadEl.hidden = true; backEl.hidden = true; tabsEl.hidden = false;
    subtitleEl.textContent = "Conversaciones, lo que el asistente hizo en cada turno, y los leads que escaló.";
    tabConvos.setAttribute("aria-selected", which === "convos" ? "true" : "false");
    tabLeads.setAttribute("aria-selected", which === "leads" ? "true" : "false");
    indexEl.hidden = which !== "convos";
    leadsEl.hidden = which !== "leads";
    if (which === "leads") loadLeads();
  }

  backEl.addEventListener("click", function () {
    showTab(leadsEl.hidden ? "convos" : "leads");
  });
  tabConvos.addEventListener("click", function () { showTab("convos"); });
  tabLeads.addEventListener("click", function () { showTab("leads"); });
  moreEl.addEventListener("click", function () {
    moreEl.disabled = true;
    loadPage().finally(function () { moreEl.disabled = false; });
  });

  if (!token) {
    say("Falta el enlace completo. Ábrelo exactamente como te lo enviaron, sin recortarlo.", true);
  } else if (deepLink) {
    // Landed from a notification that named one conversation: open it directly
    // rather than making the person find it in a list they did not ask for.
    // The index is still loaded underneath, so "Volver" has somewhere to go.
    loadPage().catch(function () {});
    openThread(deepLink.key, deepLink.agent).catch(function () {
      say("No se pudo abrir esa conversación. Puede que ya no exista.", true);
    });
  } else {
    indexEl.hidden = false;
    loadPage().catch(function () {
      say("No se pudo conectar. Revisa tu conexión e intenta de nuevo.", true);
    });
  }
})();
</script>
</body>
</html>
`;
