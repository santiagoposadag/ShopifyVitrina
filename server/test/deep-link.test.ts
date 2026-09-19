import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { registerDeepLinks } from "../src/admin/deep-link.js";
import { registerAdminConsole } from "../src/admin/console.js";
import {
  deleteStaleAdminDeepLinks,
  listLiveAdminDeepLinks,
  mintAdminDeepLink,
  redeemAdminDeepLink,
} from "../src/data/admin-deep-links.js";
import { authenticateAdminSession } from "../src/data/admin-sessions.js";
import { buildLandingLink } from "../src/data/console-link.js";
import { openDb, type DB } from "../src/data/db.js";
import { recordInboundMessages } from "../src/data/repo.js";
import { AGENT_IDS } from "../src/router.js";
import type { WhatsAppChannel } from "../src/whatsapp/channel.js";

/**
 * THE LANDING ROUTE A WHATSAPP NOTIFICATION POINTS AT.
 *
 * Its shape is forced by Meta: a template's URL button takes exactly ONE
 * variable, appended at the END of a base URL that is FROZEN at approval. So
 * one opaque value carries who, which conversation, and which persona — and the
 * route that spends it has to work in states no other admin path does.
 *
 * Three properties this suite defends:
 *
 *  1. IT WORKS WITH THE CONSOLE CLOSED. Every /admin path answers 404 while no
 *     session is live; opening one of these is what creates the first one.
 *  2. SINGLE USE MEANS ONE SESSION. The link is tapped twice routinely — the
 *     notification, then the chat re-opened — and two sessions for one code
 *     would make "single use" a word with no meaning.
 *  3. A DEAD CODE SHOWS A REAL PAGE, not a 404. This URL is submitted to Meta
 *     as a template's sample and opened by a human reviewer during approval.
 */

const OWNER = "573001112233";
const CUSTOMER = "573004445566";
const SALES = AGENT_IDS.customer;
const BASE = "https://luminiere.pasiolum.com";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function fakeChannel(): WhatsAppChannel {
  return {
    sendText: async () => undefined,
    downloadMedia: async () => {
      throw new Error("not used");
    },
  } as unknown as WhatsAppChannel;
}

/** The landing route alone — the state a fresh deployment is in. */
async function landingOnly(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerDeepLinks(app, { db, publicBaseUrl: BASE });
  await app.ready();
  return app;
}

/** The landing route plus the console, as the server wires them. */
async function fullApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerAdminConsole(app, { db, channel: fakeChannel() });
  registerDeepLinks(app, { db, publicBaseUrl: BASE });
  await app.ready();
  return app;
}

describe("minting a landing code", () => {
  it("produces a URL-safe code that needs no escaping in a path", () => {
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    // base64url: the alphabet a path segment carries verbatim. A code needing
    // percent-encoding would be mangled by whatever assembles the template's
    // URL, and the failure would look like an invalid code.
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(code)).toBe(code);
  });

  it("normalises the phone into the assignments key space", () => {
    const { link } = mintAdminDeepLink(db, { phone: "+57 300 111 2233" });
    expect(link.phone).toBe("573001112233");
  });

  it("refuses a phone that normalises to nothing", () => {
    expect(() => mintAdminDeepLink(db, { phone: "sin dígitos" })).toThrow(/contains no digits/);
  });

  it("stores no plaintext code anywhere", () => {
    const { code } = mintAdminDeepLink(db, { phone: OWNER });
    const row = db.prepare(`SELECT * FROM admin_deep_links`).get() as Record<string, unknown>;

    expect(Object.values(row).join(" ")).not.toContain(code);
  });

  it("composes the link with the code as a path segment, not a fragment", () => {
    const { code } = mintAdminDeepLink(db, { phone: OWNER });
    const { link } = buildLandingLink("/go", code, BASE);

    // Meta appends the template variable to the END of the base URL, so the
    // code HAS to be a path segment — a fragment cannot be expressed that way.
    expect(link).toBe(`${BASE}/go/${code}`);
    expect(link).not.toContain("#");
  });
});

describe("redeeming a code", () => {
  it("mints a session for the phone it was minted for", () => {
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    const redeemed = redeemAdminDeepLink(db, code);

    expect(redeemed?.session.phone).toBe(OWNER);
    // The session is real: the token it hands over authenticates.
    expect(authenticateAdminSession(db, redeemed!.token)).not.toBeNull();
  });

  /**
   * The property the whole shape rests on. A WhatsApp link is tapped twice
   * routinely, and two sessions for one code would make "single use" a word
   * with no meaning.
   */
  it("is single use: a second redemption finds nothing", () => {
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    expect(redeemAdminDeepLink(db, code)).not.toBeNull();
    expect(redeemAdminDeepLink(db, code)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_sessions`).get()).toEqual({ n: 1 });
  });

  it("records which session it produced, so the trail connects", () => {
    const { code } = mintAdminDeepLink(db, { phone: OWNER });
    const redeemed = redeemAdminDeepLink(db, code);

    const row = db.prepare(`SELECT used_at, session_id FROM admin_deep_links`).get() as {
      used_at: string | null;
      session_id: number | null;
    };
    expect(row.used_at).not.toBeNull();
    expect(row.session_id).toBe(redeemed?.session.id);
  });

  it("refuses an expired code", () => {
    const { code, link } = mintAdminDeepLink(db, { phone: OWNER });
    db.prepare(`UPDATE admin_deep_links SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(
      link.id,
    );

    expect(redeemAdminDeepLink(db, code)).toBeNull();
    // And it minted nothing on the way to refusing.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_sessions`).get()).toEqual({ n: 0 });
  });

  it("answers null for an absent, unknown or malformed code instead of throwing", () => {
    mintAdminDeepLink(db, { phone: OWNER });

    expect(redeemAdminDeepLink(db, undefined)).toBeNull();
    expect(redeemAdminDeepLink(db, "")).toBeNull();
    expect(redeemAdminDeepLink(db, "no-es-un-codigo")).toBeNull();
    // Wrong LENGTH is the one that would make timingSafeEqual throw — a 500 on
    // a page a customer-facing notification points at.
    expect(redeemAdminDeepLink(db, "ab")).toBeNull();
  });

  it("carries the conversation it was aimed at", () => {
    const { code } = mintAdminDeepLink(db, {
      phone: OWNER,
      conversationKey: CUSTOMER,
      agentId: SALES,
      leadId: 7,
    });

    const redeemed = redeemAdminDeepLink(db, code);

    expect(redeemed?.link).toMatchObject({
      conversation_key: CUSTOMER,
      agent_id: SALES,
      lead_id: 7,
    });
  });
});

describe("the landing route", () => {
  /**
   * The state a fresh deployment is in, and the one every /admin path refuses.
   * Opening a landing link is what creates the first session, so this route
   * cannot sit behind the console's own gate.
   */
  it("works while the console has no live session at all", async () => {
    const app = await landingOnly();
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    const response = await app.inject({ method: "GET", url: `/go/${code}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("location.replace");
  });

  it("hands the token over in the body, never in a Location header", async () => {
    const app = await landingOnly();
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    const response = await app.inject({ method: "GET", url: `/go/${code}` });

    // A 302 would put the token in a header, and the reverse proxies this runs
    // behind are far likelier to log response headers than Fastify is.
    expect(response.statusCode).toBe(200);
    expect(response.headers["location"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
  });

  it("sends the browser to the conversation the code named, in the fragment", async () => {
    const app = await landingOnly();
    const { code } = mintAdminDeepLink(db, {
      phone: OWNER,
      conversationKey: CUSTOMER,
      agentId: SALES,
    });

    const response = await app.inject({ method: "GET", url: `/go/${code}` });

    // Everything rides the fragment: the token because it is a credential, and
    // the conversation key because it IS a customer's phone number.
    expect(response.body).toContain(`${BASE}/admin#t=`);
    expect(response.body).toContain(`c=${CUSTOMER}`);
    expect(response.body).toContain(`g=${SALES}`);
    expect(response.body).not.toContain(`?t=`);
  });

  it("lands on the front page when the code named no conversation", async () => {
    const app = await landingOnly();
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    const response = await app.inject({ method: "GET", url: `/go/${code}` });

    expect(response.body).toContain(`${BASE}/admin#t=`);
    expect(response.body).not.toContain("&c=");
  });

  /**
   * THE PAGE A META REVIEWER SEES. The template's sample URL is opened by a
   * human during approval, and a 404 reads to them — and to every link checker
   * — as a broken destination.
   */
  it("answers 200 with a real page for a dead code, not a 404", async () => {
    const app = await landingOnly();

    const response = await app.inject({ method: "GET", url: "/go/uncodigoquenoexiste" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Este enlace ya no sirve");
    // It tells the reader the one thing that gets them moving again.
    expect(response.body).toContain("panel");
  });

  /**
   * Unknown, expired and already-spent must be one answer. Telling a visitor
   * their code "was already used" tells them the code was real.
   */
  it("says the same thing for unknown, expired and spent codes", async () => {
    const app = await landingOnly();
    const spent = mintAdminDeepLink(db, { phone: OWNER });
    await app.inject({ method: "GET", url: `/go/${spent.code}` });
    const expired = mintAdminDeepLink(db, { phone: OWNER });
    db.prepare(`UPDATE admin_deep_links SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(
      expired.link.id,
    );

    const bodies = await Promise.all(
      [`/go/${spent.code}`, `/go/${expired.code}`, "/go/desconocido"].map((url) =>
        app.inject({ method: "GET", url }).then((r) => r.body),
      ),
    );

    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });

  it("never echoes the code back, on success or failure", async () => {
    const app = await landingOnly();
    const { code } = mintAdminDeepLink(db, { phone: OWNER });

    const ok = await app.inject({ method: "GET", url: `/go/${code}` });
    const dead = await app.inject({ method: "GET", url: "/go/otrocodigo" });

    expect(ok.body).not.toContain(code);
    expect(dead.body).not.toContain("otrocodigo");
  });

  /** End to end: the session the landing minted really opens the console. */
  it("produces a session the console accepts", async () => {
    const app = await fullApp();
    recordInboundMessages(db, {
      agentId: SALES,
      turnKey: "t1",
      rows: [
        {
          id: 1,
          conversation_key: CUSTOMER,
          agent_text: "hola",
          kind: "text",
          received_at: "2026-01-01 10:00:00",
        },
      ],
    });
    const { code } = mintAdminDeepLink(db, {
      phone: OWNER,
      conversationKey: CUSTOMER,
      agentId: SALES,
    });

    const landing = await app.inject({ method: "GET", url: `/go/${code}` });
    // Pull the token back out of the handoff exactly as the browser would.
    const token = decodeURIComponent(/#t=([^&"]+)/.exec(landing.body)?.[1] ?? "");
    expect(token).not.toBe("");

    const thread = await app.inject({
      method: "GET",
      url: `/admin/conversation?key=${CUSTOMER}&agent=${SALES}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(thread.statusCode).toBe(200);
    expect(thread.json().conversationKey).toBe(CUSTOMER);
  });
});

describe("housekeeping", () => {
  it("lists only codes that could still be opened", () => {
    const live = mintAdminDeepLink(db, { phone: OWNER });
    const spent = mintAdminDeepLink(db, { phone: OWNER });
    redeemAdminDeepLink(db, spent.code);

    expect(listLiveAdminDeepLinks(db).map((l) => l.id)).toEqual([live.link.id]);
  });

  /**
   * A spent row is the record that a notification was OPENED, and session_id
   * connects it to whatever that session then read. Sweeping eagerly would
   * erase the first half of every audit trail.
   */
  it("keeps a recently dead code and drops a long-dead one", () => {
    const recent = mintAdminDeepLink(db, { phone: OWNER });
    const ancient = mintAdminDeepLink(db, { phone: OWNER });
    redeemAdminDeepLink(db, recent.code);
    db.prepare(`UPDATE admin_deep_links SET expires_at = datetime('now', '-90 days') WHERE id = ?`).run(
      ancient.link.id,
    );

    expect(deleteStaleAdminDeepLinks(db, 30)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_deep_links`).get()).toEqual({ n: 1 });
  });
});
