import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { assignRole, countAssignedOwners, roleForPhone } from "../data/assignments.js";
import type { DB } from "../data/db.js";
import { countRosterEntries, findRosterByToken, type RosterEntry } from "../data/test-roster.js";
import { AGENT_IDS } from "../router.js";
import type { Role } from "../types.js";

/**
 * TEMPORARY. The test console: a page a pre-registered test phone opens to flip
 * its OWN role between owner and customer.
 *
 * WHY IT EXISTS: the store owner has to experience both assistants from their
 * own phone, and a role currently changes only from a terminal. REMOVING THE
 * FEATURE IS DELETING FILES AND ROWS — this file, its test, the two lines in
 * index.ts, data/test-roster.ts and the `test_roster` block in data/db.ts.
 * Nothing durable imports this module.
 *
 * THERE IS NO PHONE PARAMETER ANYWHERE IN THIS SURFACE, and that is the whole
 * containment argument. The phone comes from the roster row the bearer token
 * matched, and `entry.phone` below is the ONLY expression in this module that
 * produces a phone. There is no request a caller can craft that names another
 * number, because there is no field to put one in: the body schema is
 * `.strict()`, so a `phone` key is a 400 rather than something silently
 * dropped, and neither route reads a param, a query string or a header for
 * identity. Containment is therefore not a check somebody could write wrong.
 *
 * NOTHING HERE MAY EVER CALL addRosterEntry OR rotateRosterToken. A console
 * that can enrol a phone is a console that grants itself reach, which destroys
 * the shape above. Enrolment is the operator's CLI only.
 *
 * NOTHING HERE DELETES A SESSION either. The console exists so an owner can
 * test both sides; deleting the thread it is flipping away from would destroy
 * the continuity being tested and make the flip irreversible in the only sense
 * the person cares about. The routes below read `sessions` and never write it.
 *
 * `unassignPhone` is also deliberately never called: a toggle SETS a role, and
 * deleting the row would let `seedOwnerAssignments` re-promote the phone on the
 * next boot — the owner's deliberate demotion silently undone by a restart.
 */

/** The prefix every route lives under, so removal is one grep. */
const PREFIX = "/test-console";

/**
 * The wire body. One field, and `.strict()` is the load-bearing part.
 *
 * A body carrying `phone` is REJECTED, not ignored: a silently dropped field
 * lets a caller believe such a field exists and might one day be honoured, and
 * it lets a future reader believe the containment lives in a `delete body.phone`
 * somewhere. Same rule and same reasoning as inbox/a2a.ts.
 */
const RoleBodySchema = z.object({ role: z.enum(["owner", "customer"]) }).strict();

export interface TestConsoleDeps {
  db: DB;
}

/** One of the two conversations this phone can hold, as the page shows them. */
interface ThreadView {
  role: Role;
  agentId: string;
  /**
   * Whether a session row with a stored id exists for this (agent, phone).
   *
   * "Exists", not "is resumable": expiry is SESSION_MAX_AGE_DAYS and lives in
   * the config this module deliberately does not take. The distinction only
   * matters for a thread untouched for weeks, where the page would say the
   * conversation is waiting and the next message would start fresh anyway.
   */
  hasConversation: boolean;
  lastActivityAt: string | null;
}

/**
 * The two session rows this phone owns, read directly.
 *
 * A DELIBERATE DEVIATION FROM HOUSE STYLE: this query belongs here rather than
 * as a new helper in data/repo.ts, because a durable file gaining a function
 * whose only caller is temporary is exactly what survives the removal of the
 * temporary thing. `listSessions` would have answered it and is not used: it
 * returns EVERY conversation key in the database — every customer's phone —
 * and this page must never be able to show a second person's number.
 *
 * `sessions` is keyed (agent_id, conversation_key), and for a WhatsApp
 * principal the conversation key IS the phone (inbox/envelope.ts). The two
 * agent ids come from the router, so a build that renames one cannot leave this
 * silently reading a table nothing writes.
 */
function threadsFor(db: DB, phone: string): ThreadView[] {
  const rows = db
    .prepare(
      `SELECT agent_id, agent_session_id, updated_at
       FROM sessions WHERE conversation_key = ? AND agent_id IN (?, ?)`,
    )
    .all(phone, AGENT_IDS.owner, AGENT_IDS.customer) as {
    agent_id: string;
    agent_session_id: string | null;
    updated_at: string;
  }[];

  // Fixed order, owner first, so the page renders the same two cards in the
  // same places whether or not either conversation has been started.
  return (["owner", "customer"] as const).map((role) => {
    const agentId = AGENT_IDS[role];
    const row = rows.find((r) => r.agent_id === agentId);
    return {
      role,
      agentId,
      hasConversation: row?.agent_session_id != null,
      lastActivityAt: row?.updated_at ?? null,
    };
  });
}

/**
 * Enough of the number to recognise, not enough to publish.
 *
 * A screenshot of this page is the likeliest way it leaves the phone it was
 * opened on, and a full E.164 number in one is a customer-reachable identity.
 * The last four digits are what tells two test phones apart.
 */
function maskPhone(phone: string): string {
  return `•••• ${phone.slice(-4)}`;
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
// Copied from inbox/a2a.ts rather than shared, on purpose: exporting it would
// make a durable module depend on the existence of this one, and the whole
// point of this file is that deleting it breaks nothing.

/**
 * Headers every response here carries.
 *
 * `no-store` because the JSON says what role a live phone currently has and
 * the shell is a door; `noindex` because the URL will be pasted into a chat and
 * chat clients fetch previews.
 */
function guardHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex");
}

/**
 * Who is asking, or a refusal already sent.
 *
 * TWO GATES, IN THIS ORDER. An empty roster is a DEAD feature, so it answers
 * 404 on every path including the unauthenticated shell — the console is
 * shipped closed, and "no rows" must not be distinguishable from "not
 * deployed". Only then is the token looked at, and its refusal is one
 * vocabulary for all three ways it can fail (absent, malformed, unknown) so a
 * prober learns nothing about which. The token never enters the response, the
 * log, or anything derived from either.
 */
function authenticate(
  db: DB,
  reply: FastifyReply,
  authorization: string | string[] | undefined,
): RosterEntry | null {
  if (countRosterEntries(db) === 0) {
    void guardHeaders(reply).code(404).send({ error: "not_found" });
    return null;
  }
  const entry = findRosterByToken(db, bearerToken(authorization));
  if (!entry) {
    void guardHeaders(reply).code(401).send({ error: "unauthorized" });
    return null;
  }
  return entry;
}

export function registerTestConsole(app: FastifyInstance, deps: TestConsoleDeps): void {
  const { db } = deps;

  /**
   * The shell. UNAUTHENTICATED BECAUSE IT CANNOT BE AUTHENTICATED, and the
   * reason is the fragment: the token travels as `/test-console#t=<token>`, and
   * a fragment is never sent to the server by any browser. The page reads
   * `location.hash` and puts the token in an `Authorization` header on the two
   * data calls below.
   *
   * A QUERY-STRING TOKEN IS WHAT THIS AVOIDS. The server runs `logger: true`,
   * so `?t=<token>` would be written into the request log on every single page
   * load — a live credential, at rest, in a file nobody thinks of as secret,
   * and also in any proxy or browser history in between.
   *
   * So the shell carries no data, no token and no phone: it is markup and the
   * script that fetches them.
   */
  app.get(PREFIX, async (_request, reply) => {
    // One count per shell load, and it is the whole gate: an empty roster means
    // the console is dead and the door does not exist.
    if (countRosterEntries(db) === 0) {
      return guardHeaders(reply).code(404).send({ error: "not_found" });
    }
    return guardHeaders(reply).type("text/html; charset=utf-8").send(PAGE);
  });

  /**
   * What the holder's own row looks like right now, plus BOTH of their threads.
   *
   * The threads are here rather than on the flip's response because the page
   * has to show them BEFORE the change is made. `sessions` is keyed by agent as
   * well as by conversation, so flipping does not continue the conversation —
   * it starts, or resumes, the other one, and the first is still sitting there.
   * An owner who is not told that reads it as lost messages.
   */
  app.get(`${PREFIX}/state`, async (request, reply) => {
    const entry = authenticate(db, reply, request.headers.authorization);
    if (!entry) return reply;

    // entry.phone — the ONLY phone this module ever produces. Nothing from the
    // request participates.
    const role = roleForPhone(db, entry.phone);
    return guardHeaders(reply).code(200).send({
      label: entry.label,
      phoneMasked: maskPhone(entry.phone),
      role,
      agentId: AGENT_IDS[role],
      threads: threadsFor(db, entry.phone),
    });
  });

  /**
   * The flip. One write: `assignRole`, on the credential's own phone.
   *
   * IDEMPOTENT BY CONSTRUCTION — it SETS a role rather than toggling one, so a
   * double-tap, a retried fetch or a replayed request all land on the same
   * state and `changed:false` is a truthful answer rather than a lost update.
   * That is why the body names the target role instead of saying "switch".
   *
   * ONE IMMEDIATE TRANSACTION around the read, the write and the owner count.
   * Within this process better-sqlite3 is synchronous and nothing interleaves;
   * the lock is for two processes on one database file (a redeploy overlapping
   * its predecessor), where a read-then-write would otherwise report a `changed`
   * and a `storeHasNoOwners` that were never simultaneously true. Same reasoning
   * as seedOwnerAssignments and addRosterEntry.
   *
   * A FLIP THAT LEAVES ZERO OWNERS IS ALLOWED. Refusing it would break the
   * primary use case — the only owner is the person testing the customer path
   * from their own phone — so the fact is reported instead, and the page says
   * it. The same page flips them back.
   */
  app.post(`${PREFIX}/role`, async (request, reply) => {
    const entry = authenticate(db, reply, request.headers.authorization);
    if (!entry) return reply;

    const parsed = RoleBodySchema.safeParse(request.body);
    if (!parsed.success) return guardHeaders(reply).code(400).send({ error: "invalid_request" });
    const role: Role = parsed.data.role;

    const flip = db.transaction((phone: string, wanted: Role) => {
      const previous = roleForPhone(db, phone);
      assignRole(db, phone, wanted);
      return {
        changed: previous !== wanted,
        storeHasNoOwners: countAssignedOwners(db) === 0,
      };
    });
    const result = flip.immediate(entry.phone, role);

    // The phone is NOT in this log line, and neither is the token. The label is
    // what an operator can correlate a flip back to a row with.
    request.log.warn(
      { label: entry.label, role, changed: result.changed },
      "test console: a registered test number changed its own role",
    );

    return guardHeaders(reply).code(200).send({
      role,
      agentId: AGENT_IDS[role],
      changed: result.changed,
      storeHasNoOwners: result.storeHasNoOwners,
    });
  });
}

/**
 * The page. ONE template literal, no framework, no build step, no static file.
 *
 * THE LABEL IS OPERATOR-TYPED TEXT AND IS NEVER INTERPOLATED INTO HTML. It does
 * not appear in this string at all — it arrives from `/state` as JSON and is
 * assigned with `textContent`, which is a mechanism rather than a rule someone
 * has to remember. There is no `innerHTML` in this document and its test pins
 * that.
 *
 * User-visible copy is SPANISH because the store owner reads it. Everything
 * else in this file is English.
 */
const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Consola de pruebas</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 48px;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 520px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
  .badge {
    display: block; text-align: center; border-radius: 14px;
    padding: 22px 16px; font-size: 24px; font-weight: 700;
    border: 2px solid currentColor; margin-bottom: 20px;
  }
  .badge.owner { color: #b45309; }
  .badge.customer { color: #1d4ed8; }
  .identity { font-size: 14px; color: #6b7280; margin: 0 0 20px; text-align: center; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 24px 0 8px; }
  .card { border: 1px solid #d1d5db; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .card .name { font-weight: 600; }
  .card .detail { font-size: 14px; color: #6b7280; }
  .note { font-size: 14px; background: rgba(127,127,127,.12); border-radius: 12px; padding: 14px; margin: 16px 0 24px; }
  button {
    display: block; width: 100%; min-height: 60px; margin-bottom: 12px;
    font-size: 18px; font-weight: 600; border-radius: 14px;
    border: 2px solid #374151; background: transparent; color: inherit; cursor: pointer;
  }
  button[disabled] { opacity: .4; cursor: default; }
  .status { font-size: 15px; margin-top: 16px; min-height: 1.5em; }
  .status.error { color: #b91c1c; }
  .warn { font-size: 14px; color: #b45309; margin-top: 12px; }
  footer { margin-top: 32px; font-size: 13px; color: #6b7280; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>Consola de pruebas</h1>
<p class="sub">Cambia entre modo Dueño y modo Cliente para probar el asistente desde tu propio número.</p>

<div id="app" hidden>
  <div id="badge" class="badge">…</div>
  <p class="identity"><span id="label"></span> · <span id="phone"></span></p>

  <h2>Tus dos conversaciones</h2>
  <div class="card">
    <div class="name">Modo Dueño — asistente de inventario</div>
    <div class="detail" id="thread-owner"></div>
  </div>
  <div class="card">
    <div class="name">Modo Cliente — asistente de ventas</div>
    <div class="detail" id="thread-customer"></div>
  </div>

  <p class="note">
    Cada modo mantiene su propia conversación. Al cambiar de modo no continúas la
    conversación actual: empiezas o retomas la del otro modo, y la anterior queda
    donde la dejaste. No se borra nada. El cambio se aplica desde tu próximo
    mensaje de WhatsApp.
  </p>

  <button id="to-owner" type="button">Cambiar a modo Dueño</button>
  <button id="to-customer" type="button">Cambiar a modo Cliente</button>
  <p class="warn" id="no-owners" hidden>
    Atención: en este momento la tienda no tiene ningún dueño asignado. Mientras
    siga así, ningún número puede administrar el inventario. Puedes volver a modo
    Dueño desde esta misma página.
  </p>
</div>

<p class="status" id="status">Cargando…</p>
<footer>Herramienta temporal de pruebas.</footer>

<script>
(function () {
  "use strict";

  // The token lives in the FRAGMENT and never leaves the browser except as an
  // Authorization header. A query string would be written into the server's
  // request log on every page load.
  var token = new URLSearchParams(window.location.hash.slice(1)).get("t");

  var app = document.getElementById("app");
  var statusEl = document.getElementById("status");
  var badge = document.getElementById("badge");
  var buttons = {
    owner: document.getElementById("to-owner"),
    customer: document.getElementById("to-customer")
  };
  var threadEls = {
    owner: document.getElementById("thread-owner"),
    customer: document.getElementById("thread-customer")
  };
  var noOwners = document.getElementById("no-owners");

  var BADGE = { owner: "Estás en modo Dueño", customer: "Estás en modo Cliente" };

  function say(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "status error" : "status";
  }

  function describeThread(thread, isCurrent) {
    if (!thread.hasConversation) {
      return isCurrent
        ? "Sin conversación todavía. Escríbele por WhatsApp para empezar."
        : "Sin conversación todavía.";
    }
    var when = thread.lastActivityAt ? " · última actividad: " + thread.lastActivityAt + " UTC" : "";
    return (isCurrent ? "Conversación en curso" : "Conversación guardada, te espera donde la dejaste") + when;
  }

  function render(state) {
    document.getElementById("label").textContent = state.label || "Sin nombre";
    document.getElementById("phone").textContent = state.phoneMasked;
    badge.textContent = BADGE[state.role] || state.role;
    badge.className = "badge " + state.role;
    state.threads.forEach(function (thread) {
      var el = threadEls[thread.role];
      if (el) el.textContent = describeThread(thread, thread.role === state.role);
    });
    buttons.owner.disabled = state.role === "owner";
    buttons.customer.disabled = state.role === "customer";
    app.hidden = false;
  }

  function failed(response) {
    if (response.status === 401) {
      say("Este enlace ya no es válido. Pide uno nuevo a quien te lo envió.", true);
    } else if (response.status === 404) {
      say("La consola de pruebas está cerrada.", true);
    } else {
      say("No se pudo completar la operación. Intenta de nuevo.", true);
    }
  }

  function load() {
    return fetch("/test-console/state", {
      headers: { "Authorization": "Bearer " + token },
      cache: "no-store"
    }).then(function (response) {
      if (!response.ok) { failed(response); return null; }
      return response.json().then(function (state) {
        render(state);
        say("");
        return state;
      });
    });
  }

  function flip(role) {
    buttons.owner.disabled = true;
    buttons.customer.disabled = true;
    say("Cambiando…");
    fetch("/test-console/role", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      cache: "no-store",
      body: JSON.stringify({ role: role })
    }).then(function (response) {
      if (!response.ok) { failed(response); return; }
      return response.json().then(function (result) {
        noOwners.hidden = !result.storeHasNoOwners;
        return load().then(function () {
          say(result.changed
            ? "Listo. Tu próximo mensaje de WhatsApp llega al otro asistente."
            : "Ya estabas en ese modo. No se cambió nada.");
        });
      });
    }).catch(function () {
      say("No se pudo conectar. Revisa tu conexión e intenta de nuevo.", true);
    });
  }

  buttons.owner.addEventListener("click", function () { flip("owner"); });
  buttons.customer.addEventListener("click", function () { flip("customer"); });

  if (!token) {
    say("Falta el enlace completo. Ábrelo exactamente como te lo enviaron, sin recortarlo.", true);
  } else {
    load().catch(function () {
      say("No se pudo conectar. Revisa tu conexión e intenta de nuevo.", true);
    });
  }
})();
</script>
</body>
</html>
`;
