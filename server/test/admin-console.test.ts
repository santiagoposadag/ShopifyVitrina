import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminConsole } from "../src/admin/console.js";
import { issueAdminSession, revokeAdminSession } from "../src/data/admin-sessions.js";
import { openDb, type DB } from "../src/data/db.js";
import {
  insertLead,
  isConversationPaused,
  listConversationMessages,
  pauseConversation,
  recordInboundMessages,
  recordOutboundMessage,
  recordToolCall,
} from "../src/data/repo.js";
import { AGENT_IDS } from "../src/router.js";
import type { WhatsAppChannel } from "../src/whatsapp/channel.js";

/**
 * The admin console: /admin, /admin/conversations, /admin/conversation.
 *
 * THE PROPERTY THIS SUITE DEFENDS IS THE OPPOSITE OF THE TEST CONSOLE'S. That
 * one is about containment — one credential, one phone, no way to name another.
 * This one reads everybody by design, so what has to hold instead is:
 *
 *  1. IT IS SHIPPED CLOSED. An empty roster answers 404 everywhere, including
 *     the unauthenticated shell, so "no rows" is indistinguishable from "not
 *     deployed".
 *  2. IT IS READ-ONLY. No route here writes anything, and the assertions check
 *     the DATABASE is untouched rather than trusting that no write was coded.
 *  3. THE TWO PERSONAS ON ONE PHONE STAY TWO THREADS. A reader that merged them
 *     would show a conversation that never happened.
 *  4. THE TOOL TRACE SITS INSIDE THE TURN IT BELONGS TO. That interleaving is
 *     the whole reason this console exists rather than a `SELECT * FROM
 *     conversation_messages`.
 */

const PHONE = "573001112233";
const OTHER = "573004445566";
const INVENTORY = AGENT_IDS.owner;
const SALES = AGENT_IDS.customer;

const ADMIN = "573009998877";

interface Harness {
  app: FastifyInstance;
  db: DB;
  token: string;
  sessionId: number;
  /** Everything the console asked the transport to deliver. */
  sent: { to: string; body: string }[];
  get: (path: string, token?: string) => Promise<LightMyRequestResponse>;
  post: (path: string, body: unknown, token?: string) => Promise<LightMyRequestResponse>;
}

/**
 * A transport that records instead of sending. The console's send route is the
 * one place it reaches the outside world, and what matters about it is WHAT it
 * asked to deliver and WHETHER it recorded only after that succeeded — so the
 * fake can also be told to fail.
 */
function fakeChannel(sent: { to: string; body: string }[], fail?: Error): WhatsAppChannel {
  return {
    sendText: async (to: string, body: string) => {
      if (fail) throw fail;
      sent.push({ to, body });
    },
    downloadMedia: async () => {
      throw new Error("not used");
    },
  } as unknown as WhatsAppChannel;
}

async function harness(
  options: { empty?: boolean; sendFails?: Error } = {},
): Promise<Harness> {
  const db = openDb(":memory:");
  let token = "";
  let sessionId = 0;
  if (!options.empty) {
    const minted = issueAdminSession(db, { phone: ADMIN, issuedVia: "whatsapp" });
    token = minted.token;
    sessionId = minted.session.id;
  }

  const sent: { to: string; body: string }[] = [];
  const app = Fastify({ logger: false });
  registerAdminConsole(app, { db, channel: fakeChannel(sent, options.sendFails) });
  await app.ready();

  return {
    app,
    db,
    token,
    sessionId,
    sent,
    get: (path, value = `Bearer ${token}`) =>
      app.inject({ method: "GET", url: path, headers: { authorization: value } }),
    post: (path, body, value = `Bearer ${token}`) =>
      app.inject({
        method: "POST",
        url: path,
        headers: { authorization: value, "content-type": "application/json" },
        payload: JSON.stringify(body),
      }),
  };
}

/** One inbound message, as the batcher would have recorded it. */
function seedInbound(
  db: DB,
  agentId: string,
  key: string,
  turnKey: string,
  body: string,
  occurredAt: string,
  id: number,
): void {
  recordInboundMessages(db, {
    agentId,
    turnKey,
    rows: [{ id, conversation_key: key, agent_text: body, kind: "text", received_at: occurredAt }],
  });
}

describe("admin console: shipped closed", () => {
  it("answers 404 on every path while the roster is empty, shell included", async () => {
    const h = await harness({ empty: true });

    for (const path of ["/admin", "/admin/conversations", "/admin/conversation?key=x&agent=y"]) {
      const response = await h.get(path, "Bearer whatever");
      expect(response.statusCode).toBe(404);
    }
  });

  it("serves the shell unauthenticated once a credential exists, because the token is in the fragment", async () => {
    const h = await harness();
    // No Authorization header at all: a fragment never reaches the server, so
    // the shell CANNOT be authenticated and must not pretend to be.
    const response = await h.app.inject({ method: "GET", url: "/admin" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
  });

  it("refuses absent, malformed and unknown tokens with one identical answer", async () => {
    const h = await harness();

    // No header at all — injected directly, since the harness defaults to the
    // real token when none is named.
    const absent = await h.app.inject({ method: "GET", url: "/admin/conversations" });
    const malformed = await h.get("/admin/conversations", "Token abc");
    const unknown = await h.get("/admin/conversations", "Bearer 00deadbeef");

    for (const response of [absent, malformed, unknown]) {
      expect(response.statusCode).toBe(401);
      // One vocabulary, so a prober cannot tell which of the three it hit.
      expect(response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("never echoes the token back in any response", async () => {
    const h = await harness();
    const shell = await h.app.inject({ method: "GET", url: "/admin" });
    const data = await h.get("/admin/conversations");

    expect(shell.body).not.toContain(h.token);
    expect(data.body).not.toContain(h.token);
  });
});

describe("admin console: the page itself", () => {
  /**
   * Every string this page renders is untrusted in the strict sense: a
   * customer's own words, an operator-typed label, a tool result assembled from
   * Shopify data. `innerHTML` anywhere in the document would turn any one of
   * them into markup, and the person who introduced it would have no failing
   * test to tell them. Pinned as a MECHANISM rather than as a review rule.
   */
  it("contains no innerHTML anywhere", async () => {
    const h = await harness();
    const shell = await h.app.inject({ method: "GET", url: "/admin" });

    expect(shell.body).not.toContain("innerHTML");
    expect(shell.body).not.toContain("outerHTML");
    expect(shell.body).not.toContain("insertAdjacentHTML");
    expect(shell.body).not.toContain("document.write");
  });

  /**
   * The token must reach the server as a HEADER and never as a query string:
   * Fastify runs with `logger: true` in production, so `?t=` would write a live
   * credential into the request log on every page load.
   */
  it("sends the token as an Authorization header, never in a URL", async () => {
    const h = await harness();
    const shell = await h.app.inject({ method: "GET", url: "/admin" });

    expect(shell.body).toContain('"Authorization": "Bearer " + token');
    expect(shell.body).toContain('location.hash');
    expect(shell.body).not.toContain("?t=");
  });
});

describe("admin console: the conversation index", () => {
  it("lists one row per (conversation, agent) with counts and a preview", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "hola", "2026-01-01 10:00:00", 1);
    recordOutboundMessage(h.db, {
      conversationKey: PHONE,
      agentId: SALES,
      turnKey: "t1",
      body: "hola, ¿qué buscas?",
      occurredAt: "2026-01-01 10:00:05",
    });

    const body = (await h.get("/admin/conversations")).json();

    expect(body.total).toBe(1);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      conversationKey: PHONE,
      agentId: SALES,
      agentLabel: "Ventas (cliente)",
      messageCount: 2,
      inboundCount: 1,
      lastDirection: "outbound",
      lastBody: "hola, ¿qué buscas?",
    });
  });

  /**
   * One phone, two personas, two rows. Collapsing them would merge an owner's
   * stock edits with the same person's customer-side messages into one thread
   * that never happened — and on a store where the owner tests both sides from
   * their own phone (which is exactly what the test console exists for) that is
   * the normal case, not an edge one.
   */
  it("keeps one phone's two personas as two separate conversations", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "como cliente", "2026-01-01 10:00:00", 1);
    seedInbound(h.db, INVENTORY, PHONE, "t2", "como dueño", "2026-01-01 11:00:00", 2);

    const body = (await h.get("/admin/conversations")).json();

    expect(body.total).toBe(2);
    expect(body.conversations.map((c: { agentId: string }) => c.agentId)).toEqual([
      INVENTORY, // newest activity first
      SALES,
    ]);
  });

  it("orders by most recent activity and pages without losing or repeating a row", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "viejo", "2026-01-01 10:00:00", 1);
    seedInbound(h.db, SALES, OTHER, "t2", "nuevo", "2026-01-02 10:00:00", 2);

    const first = (await h.get("/admin/conversations?limit=1&offset=0")).json();
    const second = (await h.get("/admin/conversations?limit=1&offset=1")).json();

    expect(first.conversations[0].conversationKey).toBe(OTHER);
    expect(second.conversations[0].conversationKey).toBe(PHONE);
    expect(first.total).toBe(2);
  });

  it("refuses a page size beyond the cap rather than honouring it", async () => {
    const h = await harness();
    const response = await h.get("/admin/conversations?limit=100000");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("admin console: one conversation", () => {
  it("groups messages and tool calls into the turn they belong to, in order", async () => {
    const h = await harness();
    seedInbound(h.db, INVENTORY, PHONE, "t1", "sube la camisa negra a 80000", "2026-01-01 10:00:00", 1);
    recordToolCall(h.db, {
      conversationKey: PHONE,
      agentId: INVENTORY,
      turnKey: "t1",
      ordinal: 1,
      toolName: "search_catalog",
      toolInput: { query: "camisa negra" },
      result: "1. Camisa negra — match=91%",
      outcome: "ok",
      durationMs: 320,
    });
    recordToolCall(h.db, {
      conversationKey: PHONE,
      agentId: INVENTORY,
      turnKey: "t1",
      ordinal: 2,
      toolName: "update_product",
      toolInput: { handle: "camisa-negra", price: "80000" },
      result: "Precio actualizado.",
      outcome: "ok",
      durationMs: 410,
    });
    recordOutboundMessage(h.db, {
      conversationKey: PHONE,
      agentId: INVENTORY,
      turnKey: "t1",
      body: "Listo, quedó en $80.000",
      occurredAt: "2026-01-01 10:00:09",
    });

    const body = (await h.get(
      `/admin/conversation?key=${PHONE}&agent=${INVENTORY}`,
    )).json();

    expect(body.turns).toHaveLength(1);
    const turn = body.turns[0];
    expect(turn.turnKey).toBe("t1");
    expect(turn.messages.map((m: { direction: string }) => m.direction)).toEqual([
      "inbound",
      "outbound",
    ]);
    // The ordinal is the call sequence, and it is what makes the read before
    // the write readable as the reason for it.
    expect(turn.toolCalls.map((c: { toolName: string }) => c.toolName)).toEqual([
      "search_catalog",
      "update_product",
    ]);
    expect(turn.toolCalls[1]).toMatchObject({
      input: '{"handle":"camisa-negra","price":"80000"}',
      result: "Precio actualizado.",
      outcome: "ok",
      durationMs: 410,
    });
  });

  /**
   * The case this console exists for. The reply says the price changed; the
   * trace says the write was refused. Those are the same row in
   * conversation_messages and different facts here.
   */
  it("shows a failed tool call beside the reply that followed it", async () => {
    const h = await harness();
    seedInbound(h.db, INVENTORY, PHONE, "t1", "bórralo", "2026-01-01 10:00:00", 1);
    recordToolCall(h.db, {
      conversationKey: PHONE,
      agentId: INVENTORY,
      turnKey: "t1",
      ordinal: 1,
      toolName: "delete_product",
      toolInput: { handle: "camisa-negra" },
      result: "Shopify rejected the request",
      outcome: "error",
      durationMs: 120,
    });

    const body = (await h.get(
      `/admin/conversation?key=${PHONE}&agent=${INVENTORY}`,
    )).json();

    expect(body.turns[0].toolCalls[0]).toMatchObject({
      outcome: "error",
      result: "Shopify rejected the request",
    });
  });

  /**
   * A turn whose tools ran and that then died before delivering anything is the
   * single most informative shape this console can render — an assistant that
   * wrote to the store and went silent. It must not be dropped for having no
   * messages.
   */
  it("keeps a turn that ran tools and produced no message", async () => {
    const h = await harness();
    recordToolCall(h.db, {
      conversationKey: PHONE,
      agentId: INVENTORY,
      turnKey: "t-silent",
      ordinal: 1,
      toolName: "adjust_inventory",
      toolInput: { sku: "ABC", delta: -3 },
      result: "Stock actualizado.",
      outcome: "ok",
      durationMs: 200,
    });

    const body = (await h.get(
      `/admin/conversation?key=${PHONE}&agent=${INVENTORY}`,
    )).json();

    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].messages).toEqual([]);
    expect(body.turns[0].toolCalls).toHaveLength(1);
  });

  it("never shows the other persona's half of the same phone", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t-sales", "como cliente", "2026-01-01 10:00:00", 1);
    seedInbound(h.db, INVENTORY, PHONE, "t-inv", "como dueño", "2026-01-01 11:00:00", 2);

    const body = (await h.get(
      `/admin/conversation?key=${PHONE}&agent=${SALES}`,
    )).json();

    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].messages[0].body).toBe("como cliente");
  });

  it("answers 404 for a conversation that does not exist, rather than an empty thread", async () => {
    const h = await harness();
    const response = await h.get(`/admin/conversation?key=${PHONE}&agent=${SALES}`);

    expect(response.statusCode).toBe(404);
  });

  /**
   * `agent` is required rather than optional-with-a-default: a reader that
   * omitted the scope would be handed both personas interleaved.
   */
  it("refuses a request that does not name the agent", async () => {
    const h = await harness();
    const response = await h.get(`/admin/conversation?key=${PHONE}`);

    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown query field instead of silently dropping it", async () => {
    const h = await harness();
    const response = await h.get(
      `/admin/conversation?key=${PHONE}&agent=${SALES}&limit=9999`,
    );

    expect(response.statusCode).toBe(400);
  });
});

describe("admin console: taking a conversation over", () => {
  async function withThread() {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "quiero 40 unidades", "2026-01-01 10:00:00", 1);
    return h;
  }

  it("pauses a conversation and names who took it", async () => {
    const h = await withThread();

    const response = await h.post("/admin/conversation/pause", {
      key: PHONE,
      agent: SALES,
      reason: "pedido al por mayor",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().paused).toBe(true);
    // Asserted against the DATABASE, because this is the flag the message
    // pipeline reads before every turn — not against the response alone.
    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(true);
    expect(response.json().handoff).toMatchObject({
      paused_by: ADMIN,
      reason: "pedido al por mayor",
      released_at: null,
    });
  });

  /**
   * Two admins opening the same thread and both hitting pause is ordinary. A
   * second handoff row would make release ambiguous: it would close one and
   * leave the conversation paused by the other, with the console showing it
   * live.
   */
  it("is idempotent, so a second pause does not create a second handoff", async () => {
    const h = await withThread();

    const first = await h.post("/admin/conversation/pause", { key: PHONE, agent: SALES });
    const second = await h.post("/admin/conversation/pause", { key: PHONE, agent: SALES });

    expect(second.json().handoff.id).toBe(first.json().handoff.id);
    const thread = (await h.get(`/admin/conversation?key=${PHONE}&agent=${SALES}`)).json();
    expect(thread.handoffs).toHaveLength(1);
  });

  it("releases it back to the agent and keeps the history", async () => {
    const h = await withThread();
    await h.post("/admin/conversation/pause", { key: PHONE, agent: SALES });

    const response = await h.post("/admin/conversation/release", { key: PHONE, agent: SALES });

    expect(response.json()).toMatchObject({ paused: false, released: 1 });
    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(false);
    // The row stays: "who took this over, when, and how long did it sit" is the
    // traceability an audit asks for, and a flag overwritten in place answers
    // none of it.
    const thread = (await h.get(`/admin/conversation?key=${PHONE}&agent=${SALES}`)).json();
    expect(thread.handoffs[0]).toMatchObject({ released_by: ADMIN });
    expect(thread.handoffs[0].released_at).not.toBeNull();
  });

  it("pauses only the named persona, not the same phone's other thread", async () => {
    const h = await withThread();
    seedInbound(h.db, INVENTORY, PHONE, "t2", "como dueño", "2026-01-01 11:00:00", 2);

    await h.post("/admin/conversation/pause", { key: PHONE, agent: SALES });

    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(true);
    expect(isConversationPaused(h.db, PHONE, INVENTORY)).toBe(false);
  });

  it("reports the paused state on the thread and on the index", async () => {
    const h = await withThread();
    await h.post("/admin/conversation/pause", { key: PHONE, agent: SALES });

    const thread = (await h.get(`/admin/conversation?key=${PHONE}&agent=${SALES}`)).json();
    const index = (await h.get("/admin/conversations")).json();

    expect(thread.paused).toBe(true);
    expect(index.pausedCount).toBe(1);
    expect(index.conversations[0].paused).toBe(true);
  });
});

describe("admin console: replying inside a conversation", () => {
  async function paused() {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "quiero 40 unidades", "2026-01-01 10:00:00", 1);
    await h.post("/admin/conversation/pause", { key: PHONE, agent: SALES });
    return h;
  }

  it("delivers the message and records it as the human's", async () => {
    const h = await paused();

    const response = await h.post("/admin/conversation/message", {
      key: PHONE,
      agent: SALES,
      body: "Hola, soy Santiago. Sí podemos con 40 unidades.",
    });

    expect(response.statusCode).toBe(200);
    expect(h.sent).toEqual([
      { to: PHONE, body: "Hola, soy Santiago. Sí podemos con 40 unidades." },
    ]);
    const recorded = listConversationMessages(h.db, PHONE, { agentId: SALES });
    const outbound = recorded.filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    // sent_by is the one field that tells a human's words from a model's, and
    // it is the whole question a handoff exists to make answerable.
    expect(outbound[0]?.sent_by).toBe(ADMIN);
    expect(outbound[0]?.turn_key.startsWith("admin:")).toBe(true);
  });

  /**
   * EVERY HUMAN INTERVENTION SUSPENDS THE AGENT, and sending is one — so a
   * reply into a live conversation TAKES IT rather than being refused. An
   * earlier version answered 409 and made the admin pause first; that paid for
   * a risk with the confusion it meant to prevent, since the admin learned the
   * rule from an error while the bot was still answering their customer.
   *
   * The safety property is unchanged and this is what pins it: the pause is in
   * place BEFORE the message goes out, so no agent reply can interleave.
   */
  it("takes the conversation over when replying into a live one", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "hola", "2026-01-01 10:00:00", 1);

    const response = await h.post("/admin/conversation/message", {
      key: PHONE,
      agent: SALES,
      body: "te respondo yo",
    });

    expect(response.statusCode).toBe(200);
    expect(h.sent).toEqual([{ to: PHONE, body: "te respondo yo" }]);
    // The gate the message pipeline reads before every turn.
    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(true);
  });

  /**
   * A failed send is a human MID-REPLY, not one who changed their mind.
   * Resuming the agent here would put it back in front of somebody who is
   * still typing to them.
   */
  it("keeps the conversation paused when the send fails", async () => {
    const db = openDb(":memory:");
    recordInboundMessages(db, {
      agentId: SALES,
      turnKey: "t1",
      rows: [
        {
          id: 1,
          conversation_key: PHONE,
          agent_text: "hola",
          kind: "text",
          received_at: "2026-01-01 10:00:00",
        },
      ],
    });
    const { token } = issueAdminSession(db, { phone: ADMIN, issuedVia: "whatsapp" });
    const app = Fastify({ logger: false });
    registerAdminConsole(app, { db, channel: fakeChannel([], new Error("bridge unreachable")) });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/admin/conversation/message",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ key: PHONE, agent: SALES, body: "hola" }),
    });

    expect(response.statusCode).toBe(502);
    expect(isConversationPaused(db, PHONE, SALES)).toBe(true);
  });

  /**
   * Recording a message the person never received is the exact failure the
   * record exists to make visible — the same contract Responders.deliver keeps.
   */
  it("records nothing when the transport fails", async () => {
    const db = openDb(":memory:");
    recordInboundMessages(db, {
      agentId: SALES,
      turnKey: "t1",
      rows: [
        {
          id: 1,
          conversation_key: PHONE,
          agent_text: "hola",
          kind: "text",
          received_at: "2026-01-01 10:00:00",
        },
      ],
    });
    pauseConversation(db, { conversationKey: PHONE, agentId: SALES, pausedBy: ADMIN });
    const { token } = issueAdminSession(db, { phone: ADMIN, issuedVia: "whatsapp" });
    const app = Fastify({ logger: false });
    registerAdminConsole(app, {
      db,
      channel: fakeChannel([], new Error("bridge unreachable")),
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/admin/conversation/message",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ key: PHONE, agent: SALES, body: "hola" }),
    });

    expect(response.statusCode).toBe(502);
    expect(
      listConversationMessages(db, PHONE, { agentId: SALES }).filter(
        (m) => m.direction === "outbound",
      ),
    ).toEqual([]);
  });

  it("refuses an empty message and one past the length cap", async () => {
    const h = await paused();

    expect((await h.post("/admin/conversation/message", { key: PHONE, agent: SALES, body: "   " })).statusCode).toBe(400);
    expect(
      (
        await h.post("/admin/conversation/message", {
          key: PHONE,
          agent: SALES,
          body: "x".repeat(5000),
        })
      ).statusCode,
    ).toBe(400);
    expect(h.sent).toEqual([]);
  });

  /**
   * An a2a conversation key is a correlation id, not a phone. Sending into one
   * would hand `sendText` a string that looks nothing like a number and,
   * worse, there is no person on the other end to receive it.
   */
  it("refuses to send into an agent-to-agent conversation", async () => {
    const h = await harness();
    const a2a = "a2a:super-agent:vitrina-inventario:corr-1";
    seedInbound(h.db, INVENTORY, a2a, "t1", "consulta", "2026-01-01 10:00:00", 1);
    await h.post("/admin/conversation/pause", { key: a2a, agent: INVENTORY });

    const response = await h.post("/admin/conversation/message", {
      key: a2a,
      agent: INVENTORY,
      body: "hola",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "not_a_person" });
    expect(h.sent).toEqual([]);
    // And the thread says so up front rather than leaving it to be discovered.
    const thread = (await h.get(`/admin/conversation?key=${encodeURIComponent(a2a)}&agent=${INVENTORY}`)).json();
    expect(thread.replyable).toBe(false);
  });
});

describe("admin console: the leads panel", () => {
  function seedLead(db: DB, overrides: Record<string, unknown> = {}) {
    return insertLead(db, {
      phone: PHONE,
      type: "follow_up",
      note: "quiere 40 unidades",
      conversation_key: PHONE,
      agent_id: SALES,
      turn_key: "t1",
      ...overrides,
    });
  }

  it("lists open leads with the conversation that produced each one", async () => {
    const h = await harness();
    seedLead(h.db);

    const body = (await h.get("/admin/leads")).json();

    expect(body.leads).toHaveLength(1);
    expect(body.leads[0]).toMatchObject({
      phone: PHONE,
      type: "follow_up",
      status: "new",
      // The link back to the exchange. This is what makes a lead actionable
      // rather than a phone number and a guess.
      conversationKey: PHONE,
      agentId: SALES,
      turnKey: "t1",
    });
  });

  it("hides handled leads by default and shows them on request", async () => {
    const h = await harness();
    const lead = seedLead(h.db);
    await h.post("/admin/lead/status", { id: lead.id, status: "closed" });

    expect((await h.get("/admin/leads")).json().leads).toHaveLength(0);
    expect((await h.get("/admin/leads?include_handled=true")).json().leads).toHaveLength(1);
  });

  /**
   * EVERY HUMAN INTERVENTION SUSPENDS THE AGENT, and taking a lead is one.
   * Marking a lead as yours and then discovering the bot is still answering
   * that customer is the confusion this rule exists to remove: the person was
   * told a team member would follow up, one picked it up, and the assistant
   * kept talking over them in between.
   */
  it("silences the agent for the conversation when a lead is taken", async () => {
    const h = await harness();
    const lead = seedLead(h.db);
    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(false);

    const response = await h.post("/admin/lead/status", { id: lead.id, status: "in_progress" });

    expect(response.json()).toMatchObject({
      paused: true,
      conversationKey: PHONE,
      agentId: SALES,
    });
    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(true);
  });

  /**
   * "I am done with this lead" and "the assistant may have this conversation
   * back" are different statements — somebody can close a lead and still be
   * mid-exchange. An auto-release would resume the agent mid-sentence.
   */
  it("does not hand the conversation back when a lead is closed", async () => {
    const h = await harness();
    const lead = seedLead(h.db);
    await h.post("/admin/lead/status", { id: lead.id, status: "in_progress" });

    await h.post("/admin/lead/status", { id: lead.id, status: "closed" });

    expect(isConversationPaused(h.db, PHONE, SALES)).toBe(true);
  });

  /**
   * A lead from before leads carried a provenance has no conversation to pause.
   * The status still changes — that is what was asked for — and the answer says
   * plainly that nothing was paused.
   */
  it("still moves a lead that has no conversation behind it", async () => {
    const h = await harness();
    const lead = seedLead(h.db, { conversation_key: null, agent_id: null });

    const response = await h.post("/admin/lead/status", { id: lead.id, status: "in_progress" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ paused: false });
  });

  it("records who took a lead, and clears that on reopening", async () => {
    const h = await harness();
    const lead = seedLead(h.db);

    const taken = (await h.post("/admin/lead/status", { id: lead.id, status: "in_progress" })).json();
    expect(taken.lead).toMatchObject({ status: "in_progress", claimed_by: ADMIN });

    // A lead nobody is handling must not keep naming somebody: that is how one
    // sits untouched while everyone assumes the named person has it.
    const reopened = (await h.post("/admin/lead/status", { id: lead.id, status: "new" })).json();
    expect(reopened.lead).toMatchObject({ status: "new", claimed_by: null });
  });

  it("refuses a status outside the lifecycle", async () => {
    const h = await harness();
    const lead = seedLead(h.db);

    const response = await h.post("/admin/lead/status", { id: lead.id, status: "archivado" });

    expect(response.statusCode).toBe(400);
  });

  it("answers 404 for a lead that does not exist", async () => {
    const h = await harness();
    const response = await h.post("/admin/lead/status", { id: 999, status: "closed" });
    expect(response.statusCode).toBe(404);
  });
});

describe("admin console: the session behind a request", () => {
  /**
   * The link is a claim window until it is opened, then a session. Nothing
   * observes the opening except the first authenticated request, which is why
   * authentication claims rather than a separate login step doing it.
   */
  it("claims the session on its first authenticated request", async () => {
    const h = await harness();

    const before = h.db
      .prepare(`SELECT claimed_at FROM admin_sessions WHERE id = ?`)
      .get(h.sessionId) as { claimed_at: string | null };
    expect(before.claimed_at).toBeNull();

    await h.get("/admin/conversations");

    const after = h.db
      .prepare(`SELECT claimed_at FROM admin_sessions WHERE id = ?`)
      .get(h.sessionId) as { claimed_at: string | null };
    expect(after.claimed_at).not.toBeNull();
  });

  /**
   * A revoked session must answer exactly like an unknown one. Telling a holder
   * that their token is real but stale is telling a prober that the token they
   * found used to work.
   */
  it("refuses a revoked session in the same words as an unknown token", async () => {
    const h = await harness();
    // A second live session, so the surface stays open and the first refusal is
    // about THIS token rather than about the console being closed.
    issueAdminSession(h.db, { phone: "573001110000", issuedVia: "cli" });
    revokeAdminSession(h.db, h.sessionId);

    const response = await h.get("/admin/conversations");

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
  });

  /** An expired session is dead without anything having to sweep it. */
  it("refuses a session past its deadline", async () => {
    const h = await harness();
    issueAdminSession(h.db, { phone: "573001110000", issuedVia: "cli" });
    h.db
      .prepare(`UPDATE admin_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`)
      .run(h.sessionId);

    expect((await h.get("/admin/conversations")).statusCode).toBe(401);
  });

  /** With every session dead the surface is closed again, shell included. */
  it("closes the whole surface once no session is live", async () => {
    const h = await harness();
    revokeAdminSession(h.db, h.sessionId);

    expect((await h.app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(404);
    expect((await h.get("/admin/conversations")).statusCode).toBe(404);
  });

  /** Every write attributes itself to the session's phone, never to a body field. */
  it("attributes writes to the session, with no field a caller could smuggle one into", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "hola", "2026-01-01 10:00:00", 1);

    const response = await h.post("/admin/conversation/pause", {
      key: PHONE,
      agent: SALES,
      pausedBy: "573000000000",
    });

    // `.strict()`: a body carrying an identity field is REJECTED, not ignored.
    // A silently dropped field lets a caller believe such a field exists and
    // might one day be honoured.
    expect(response.statusCode).toBe(400);
  });
});
