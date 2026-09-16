import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminConsole } from "../src/admin/console.js";
import { addAdminEntry } from "../src/data/admin-roster.js";
import { openDb, type DB } from "../src/data/db.js";
import {
  recordInboundMessages,
  recordOutboundMessage,
  recordToolCall,
} from "../src/data/repo.js";
import { AGENT_IDS } from "../src/router.js";

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

interface Harness {
  app: FastifyInstance;
  db: DB;
  token: string;
  get: (path: string, token?: string) => Promise<LightMyRequestResponse>;
}

async function harness(options: { empty?: boolean } = {}): Promise<Harness> {
  const db = openDb(":memory:");
  let token = "";
  if (!options.empty) token = addAdminEntry(db, "santiago", "Portátil").token;

  const app = Fastify({ logger: false });
  registerAdminConsole(app, { db });
  await app.ready();

  return {
    app,
    db,
    token,
    get: (path, value = `Bearer ${token}`) =>
      app.inject({
        method: "GET",
        url: path,
        headers: value === undefined ? {} : { authorization: value },
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

describe("admin console: read-only", () => {
  /**
   * Asserted against the DATABASE rather than against the absence of a write in
   * the source, so a future route that did write would fail here rather than
   * pass a review.
   */
  it("changes nothing in the database, whatever is requested", async () => {
    const h = await harness();
    seedInbound(h.db, SALES, PHONE, "t1", "hola", "2026-01-01 10:00:00", 1);
    recordToolCall(h.db, {
      conversationKey: PHONE,
      agentId: SALES,
      turnKey: "t1",
      ordinal: 1,
      toolName: "search_catalog",
      toolInput: { query: "x" },
      result: "nada",
      outcome: "ok",
      durationMs: 10,
    });

    const before = {
      messages: h.db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages`).get(),
      tools: h.db.prepare(`SELECT COUNT(*) AS n FROM conversation_tool_calls`).get(),
      admins: h.db.prepare(`SELECT COUNT(*) AS n FROM admin_roster`).get(),
      assignments: h.db.prepare(`SELECT COUNT(*) AS n FROM assignments`).get(),
    };

    await h.app.inject({ method: "GET", url: "/admin" });
    await h.get("/admin/conversations");
    await h.get(`/admin/conversation?key=${PHONE}&agent=${SALES}`);
    // Every write verb, on every route, refused by the router rather than
    // served: nothing here registers one.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await h.app.inject({
        method,
        url: "/admin/conversations",
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(response.statusCode).toBe(404);
    }

    expect({
      messages: h.db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages`).get(),
      tools: h.db.prepare(`SELECT COUNT(*) AS n FROM conversation_tool_calls`).get(),
      admins: h.db.prepare(`SELECT COUNT(*) AS n FROM admin_roster`).get(),
      assignments: h.db.prepare(`SELECT COUNT(*) AS n FROM assignments`).get(),
    }).toEqual(before);
  });
});
