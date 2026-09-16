import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { countAdminEntries, findAdminByToken, type AdminEntry } from "../data/admin-roster.js";
import type { DB } from "../data/db.js";
import {
  countConversations,
  listConversations,
  listConversationMessages,
  listConversationToolCalls,
  type ConversationMessage,
  type MessageDirection,
  type ToolCall,
  type ToolOutcome,
} from "../data/repo.js";
import { AGENT_IDS } from "../router.js";

/**
 * The admin console: a read-only view of every conversation this deployment has
 * held, and of what the assistant actually DID inside each one.
 *
 * WHY IT EXISTS: the words alone do not answer the question an operator is
 * really asking about an assistant that can reprice and delete products in a
 * live store. A reply saying "listo, quedó en $80.000" reads identically
 * whether the write succeeded, was refused by a business rule, or never
 * happened. `conversation_tool_calls` is where that difference lives, and this
 * is what renders it beside the message it explains.
 *
 * READ-ONLY, AND THAT IS STRUCTURAL RATHER THAN A RULE SOMEBODY REMEMBERS:
 * there is no write route in this file, and the three functions it imports from
 * the repo layer are all SELECTs. Nothing here flips a role, reprices anything,
 * or deletes a conversation. A credential's blast radius is "saw things".
 *
 * THE CONTRAST WITH THE TEST CONSOLE IS DELIBERATE AND RUNS THE OTHER WAY.
 * admin/test-console.ts has NO phone parameter anywhere in its surface, because
 * its whole containment argument is that the phone comes from the credential
 * and a caller cannot name anyone else. This surface is the opposite by
 * definition — reading every conversation is the feature — so it cannot borrow
 * that argument and must not borrow that credential. `admin_roster` is a
 * separate table for exactly this reason (see data/admin-roster.ts).
 *
 * WHAT IS EXPOSED IS LARGE AND SHOULD BE TREATED AS SUCH: every customer's
 * phone number, every message they sent, and every catalog operation performed
 * on their behalf. Those customers are third parties under Ley 1581 (DEUDA #7
 * carries the retention decision this sits on top of). The link is a bearer
 * credential and data/admin-credentials.ts says so at length when it mints one.
 *
 * NOT MARKED TEMPORARY, unlike the test console. This answers a standing
 * operational need rather than covering a manual test period, so it carries no
 * removal checklist — but it is still killed instantly by emptying its roster,
 * with no restart, because authentication is a lookup in that table.
 */

/** The prefix every route lives under, so removal is one grep. */
const PREFIX = "/admin";

/**
 * How many conversations one page of the index may ask for.
 *
 * A CAP RATHER THAN A TRUSTED PARAMETER: the count comes off a query string, and
 * `listConversations` groups over the whole message table to answer it. An
 * unbounded limit would let one request render every conversation the store has
 * ever held into a single JSON document — which is a memory spike on a small
 * container, and a slow response on a server whose webhook must ACK fast.
 */
const MAX_PAGE = 200;

/**
 * How many messages one thread renders, newest-last.
 *
 * `listConversationMessages` takes the MOST RECENT n when given a limit (its
 * own doc explains why taking the first n answers the wrong question), so a
 * long conversation shows its recent end rather than its beginning. There is no
 * retention policy on this table (DEUDA #7), so a conversation has no bound on
 * how long it can get and the unbounded read is the one that needs a decision.
 */
const MAX_THREAD_MESSAGES = 500;

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
 * handed the two interleaved into a conversation that never happened. Same
 * reasoning `listConversationMessages` states on its own agent scope.
 *
 * `.strict()` for the reason inbox/a2a.ts and the test console give: a silently
 * dropped field lets a caller believe such a field exists and might one day be
 * honoured.
 */
const ThreadQuerySchema = z
  .object({
    key: z.string().min(1),
    agent: z.string().min(1),
  })
  .strict();

export interface AdminConsoleDeps {
  db: DB;
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
// Copied from the sibling consoles rather than shared, on the same principle
// they copy it from each other: the three credential surfaces stay disjoint,
// and a helper shared between them is the first thread tying them together.

/**
 * Headers every response here carries.
 *
 * `no-store` because the body is every customer's conversation and a cached
 * copy outlives the credential that fetched it; `noindex` because the URL will
 * be pasted into a chat and chat clients fetch previews.
 */
function guardHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex");
}

/**
 * Who is asking, or a refusal already sent.
 *
 * TWO GATES, IN THIS ORDER, exactly as the test console does it. An empty
 * roster is a CLOSED feature, so it answers 404 on every path including the
 * unauthenticated shell — "no rows" must not be distinguishable from "not
 * deployed". Only then is the token looked at, and its refusal is one
 * vocabulary for all three ways it can fail (absent, malformed, unknown) so a
 * prober learns nothing about which.
 */
function authenticate(
  db: DB,
  reply: FastifyReply,
  authorization: string | string[] | undefined,
): AdminEntry | null {
  if (countAdminEntries(db) === 0) {
    void guardHeaders(reply).code(404).send({ error: "not_found" });
    return null;
  }
  const entry = findAdminByToken(db, bearerToken(authorization));
  if (!entry) {
    void guardHeaders(reply).code(401).send({ error: "unauthorized" });
    return null;
  }
  return entry;
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

/** One message as the page renders it. */
interface MessageView {
  direction: MessageDirection;
  body: string;
  kind: string;
  occurredAt: string;
}

/** One executed tool call as the page renders it. */
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
 * One turn: what the person said, what the assistant did about it, and what it
 * answered.
 *
 * THE GROUPING IS turn_key, which both tables carry. That is what makes this
 * view possible at all: `conversation_messages` says one row per message rather
 * than one per coalesced prompt, and every message answered together shares a
 * turn key — so a burst of four photos and the one reply they produced belong
 * to one turn here, and the tool calls that ran in between sit between them.
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
 * — an assistant that wrote to the store and then went silent. Dropping it
 * would hide the failure that most needs seeing.
 *
 * Both inputs arrive already ordered by their own readers, so this preserves
 * insertion order within a turn rather than re-sorting: the messages reader
 * orders by occurred_at then id, and the tool reader by ordinal, which is the
 * call sequence and deliberately not time (db.ts says why).
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
    a.occurredAt === b.occurredAt ? a.turnKey.localeCompare(b.turnKey) : a.occurredAt < b.occurredAt ? -1 : 1,
  );
}

export function registerAdminConsole(app: FastifyInstance, deps: AdminConsoleDeps): void {
  const { db } = deps;

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
    if (countAdminEntries(db) === 0) {
      return guardHeaders(reply).code(404).send({ error: "not_found" });
    }
    return guardHeaders(reply).type("text/html; charset=utf-8").send(PAGE);
  });

  /** Every conversation, newest activity first. */
  app.get(`${PREFIX}/conversations`, async (request, reply) => {
    const entry = authenticate(db, reply, request.headers.authorization);
    if (!entry) return reply;

    const parsed = IndexQuerySchema.safeParse(request.query);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const { limit, offset } = parsed.data;

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
    }));

    return guardHeaders(reply)
      .code(200)
      .send({ total: countConversations(db), limit, offset, conversations });
  });

  /**
   * One conversation, as turns.
   *
   * The two reads are deliberately NOT one join in SQL. They are different
   * shapes — one row per message against one row per tool call — and a join
   * would multiply each message by that turn's tool count, leaving the
   * de-duplication to be done here anyway over a result set several times
   * larger than either input.
   */
  app.get(`${PREFIX}/conversation`, async (request, reply) => {
    const entry = authenticate(db, reply, request.headers.authorization);
    if (!entry) return reply;

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
      truncated: messages.length === MAX_THREAD_MESSAGES,
      turns: toTurns(messages, toolCalls),
    });
  });
}

/**
 * The page. ONE template literal, no framework, no build step, no static file —
 * the same shape as the test console, for the same reason.
 *
 * THERE IS NO `innerHTML` IN THIS DOCUMENT. Every value rendered here is
 * untrusted in the strict sense: a customer's own words, an operator-typed
 * label, a tool result built from Shopify data. All of it is assigned with
 * `textContent` or inserted with `createTextNode`, which is a mechanism rather
 * than a rule someone has to remember. Its test pins that.
 *
 * User-visible copy is SPANISH. Everything else in this file is English.
 */
const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Historial de conversaciones</title>
<style>
  :root { color-scheme: light dark; --line: #d1d5db; --dim: #6b7280; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 64px;
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 860px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); font-size: 14px; margin: 0 0 20px; }
  button { font: inherit; cursor: pointer; }
  .back {
    border: 1px solid var(--line); background: transparent; color: inherit;
    border-radius: 10px; padding: 8px 14px; margin-bottom: 16px;
  }
  .convo {
    display: block; width: 100%; text-align: left;
    border: 1px solid var(--line); border-radius: 12px;
    padding: 12px 14px; margin-bottom: 10px;
    background: transparent; color: inherit;
  }
  .convo .top { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; }
  .convo .meta { color: var(--dim); font-size: 13px; margin-top: 2px; }
  .convo .preview {
    color: var(--dim); font-size: 14px; margin-top: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .turn { border-left: 3px solid var(--line); padding-left: 14px; margin: 0 0 22px; }
  .turn .when { color: var(--dim); font-size: 12px; margin-bottom: 8px; }
  .msg { border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; white-space: pre-wrap; }
  .msg.inbound { background: rgba(127,127,127,.14); }
  .msg.outbound { background: rgba(37,99,235,.14); }
  .msg .who { font-size: 12px; color: var(--dim); margin-bottom: 4px; }
  details.tool {
    border: 1px solid var(--line); border-radius: 10px;
    padding: 8px 12px; margin-bottom: 8px; font-size: 14px;
  }
  details.tool.error { border-color: #b91c1c; }
  details.tool summary { cursor: pointer; font-weight: 600; }
  details.tool .badge { font-weight: 400; color: var(--dim); font-size: 13px; }
  details.tool .badge.error { color: #b91c1c; }
  pre {
    white-space: pre-wrap; word-break: break-word; margin: 8px 0 0;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(127,127,127,.12); border-radius: 8px; padding: 10px;
  }
  pre .cap { display: block; color: var(--dim); font-size: 12px; margin-bottom: 4px; }
  .status { font-size: 15px; margin-top: 16px; min-height: 1.5em; }
  .status.error { color: #b91c1c; }
  .more { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 10px; padding: 10px 16px; width: 100%; }
  footer { margin-top: 32px; font-size: 13px; color: var(--dim); text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>Historial de conversaciones</h1>
<p class="sub" id="subtitle">Todo lo que se dijo, y lo que el asistente hizo en cada turno.</p>

<button class="back" id="back" type="button" hidden>← Volver a la lista</button>

<div id="index" hidden>
  <div id="list"></div>
  <button class="more" id="more" type="button" hidden>Cargar más</button>
</div>

<div id="thread" hidden></div>

<p class="status" id="status">Cargando…</p>
<footer>Solo lectura. Este enlace da acceso a datos de clientes reales.</footer>

<script>
(function () {
  "use strict";

  // The token lives in the FRAGMENT and never leaves the browser except as an
  // Authorization header. A query string would be written into the server's
  // request log on every page load.
  var token = new URLSearchParams(window.location.hash.slice(1)).get("t");

  var statusEl = document.getElementById("status");
  var indexEl = document.getElementById("index");
  var listEl = document.getElementById("list");
  var threadEl = document.getElementById("thread");
  var backEl = document.getElementById("back");
  var moreEl = document.getElementById("more");
  var subtitleEl = document.getElementById("subtitle");

  var PAGE_SIZE = 50;
  var offset = 0;
  var total = 0;

  function say(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "status error" : "status";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent is the ONLY way text enters this document. Every string
    // reaching here is untrusted — a customer's own words, an operator's
    // label, a tool result — and its test pins that no markup-parsing
    // assignment exists anywhere on this page.
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function failed(response) {
    if (response.status === 401) {
      say("Este enlace ya no es válido. Pide uno nuevo a quien te lo envió.", true);
    } else if (response.status === 404) {
      say("No se encontró. Es posible que la consola esté cerrada o que la conversación ya no exista.", true);
    } else {
      say("No se pudo completar la operación. Intenta de nuevo.", true);
    }
  }

  function get(path) {
    return fetch(path, {
      headers: { "Authorization": "Bearer " + token },
      cache: "no-store"
    }).then(function (response) {
      if (!response.ok) { failed(response); return null; }
      return response.json();
    });
  }

  function shorten(text, max) {
    var value = String(text === null || text === undefined ? "" : text);
    return value.length > max ? value.slice(0, max) + "…" : value;
  }

  function renderConversation(row) {
    var card = el("button", "convo");
    card.type = "button";

    var top = el("div", "top");
    top.appendChild(el("span", null, row.conversationKey));
    top.appendChild(el("span", null, row.agentLabel));
    card.appendChild(top);

    card.appendChild(el(
      "div", "meta",
      row.messageCount + " mensajes · " + row.inboundCount + " de la persona · última actividad " +
        row.lastOccurredAt + " UTC"
    ));

    var who = row.lastDirection === "inbound" ? "Ellos: " : "Asistente: ";
    card.appendChild(el("div", "preview", who + shorten(row.lastBody, 160)));

    card.addEventListener("click", function () {
      openThread(row.conversationKey, row.agentId);
    });
    return card;
  }

  function renderBlock(label, body) {
    var pre = el("pre");
    pre.appendChild(el("span", "cap", label));
    pre.appendChild(document.createTextNode(body));
    return pre;
  }

  function renderTool(call) {
    var box = el("details", "tool" + (call.outcome === "error" ? " error" : ""));
    var summary = el("summary");
    summary.appendChild(document.createTextNode(call.ordinal + ". " + call.toolName));
    var badge = el(
      "span", "badge" + (call.outcome === "error" ? " error" : ""),
      call.outcome === "error" ? "  — falló (" + call.durationMs + " ms)" : "  — " + call.durationMs + " ms"
    );
    summary.appendChild(badge);
    box.appendChild(summary);
    box.appendChild(renderBlock("Argumentos", call.input));
    box.appendChild(renderBlock(call.outcome === "error" ? "Error" : "Resultado", call.result));
    return box;
  }

  function renderTurn(turn) {
    var box = el("div", "turn");
    box.appendChild(el("div", "when", turn.occurredAt + " UTC"));

    // Inbound first, then the tools that ran because of it, then the reply.
    // That is the order it happened in, and it is what makes a tool result
    // readable as the reason for the words underneath it.
    turn.messages.filter(function (m) { return m.direction === "inbound"; })
      .forEach(function (m) { box.appendChild(renderMessage(m)); });
    turn.toolCalls.forEach(function (c) { box.appendChild(renderTool(c)); });
    turn.messages.filter(function (m) { return m.direction === "outbound"; })
      .forEach(function (m) { box.appendChild(renderMessage(m)); });

    if (turn.messages.length === 0) {
      box.appendChild(el("div", "meta", "Este turno no dejó ningún mensaje: las herramientas corrieron y no se entregó respuesta."));
    }
    return box;
  }

  function renderMessage(message) {
    var box = el("div", "msg " + message.direction);
    box.appendChild(el("div", "who", message.direction === "inbound" ? "Ellos" : "Asistente"));
    if (message.kind === "media" && message.body.length === 0) {
      box.appendChild(el("div", null, "(foto sin texto)"));
    } else {
      box.appendChild(el("div", null, message.body));
    }
    return box;
  }

  function showIndex() {
    threadEl.hidden = true;
    backEl.hidden = true;
    indexEl.hidden = false;
    subtitleEl.textContent = "Todo lo que se dijo, y lo que el asistente hizo en cada turno.";
  }

  function openThread(key, agentId) {
    say("Cargando conversación…");
    get("/admin/conversation?key=" + encodeURIComponent(key) + "&agent=" + encodeURIComponent(agentId))
      .then(function (data) {
        if (!data) return;
        threadEl.replaceChildren();
        subtitleEl.textContent = data.conversationKey + " · " + data.agentLabel;
        if (data.truncated) {
          threadEl.appendChild(el("p", "sub", "Mostrando solo los mensajes más recientes de esta conversación."));
        }
        data.turns.forEach(function (turn) { threadEl.appendChild(renderTurn(turn)); });
        indexEl.hidden = true;
        threadEl.hidden = false;
        backEl.hidden = false;
        say("");
        window.scrollTo(0, 0);
      })
      .catch(function () { say("No se pudo conectar. Revisa tu conexión e intenta de nuevo.", true); });
  }

  function loadPage() {
    say("Cargando…");
    return get("/admin/conversations?limit=" + PAGE_SIZE + "&offset=" + offset).then(function (data) {
      if (!data) return;
      total = data.total;
      data.conversations.forEach(function (row) { listEl.appendChild(renderConversation(row)); });
      offset += data.conversations.length;
      moreEl.hidden = offset >= total;
      indexEl.hidden = false;
      say(total === 0 ? "Todavía no hay conversaciones registradas." : "");
    });
  }

  backEl.addEventListener("click", showIndex);
  moreEl.addEventListener("click", function () {
    moreEl.disabled = true;
    loadPage().finally(function () { moreEl.disabled = false; });
  });

  if (!token) {
    say("Falta el enlace completo. Ábrelo exactamente como te lo enviaron, sin recortarlo.", true);
  } else {
    loadPage().catch(function () {
      say("No se pudo conectar. Revisa tu conexión e intenta de nuevo.", true);
    });
  }
})();
</script>
</body>
</html>
`;
