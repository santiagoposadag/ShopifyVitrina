import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { assignRole, roleForPhone } from "../src/data/assignments.js";
import { openDb, type DB } from "../src/data/db.js";
import { getSessionId, setSessionId } from "../src/data/repo.js";
import { addRosterEntry } from "../src/data/test-roster.js";
import { registerTestConsole } from "../src/admin/test-console.js";
import { AGENT_IDS } from "../src/router.js";

/**
 * The TEMPORARY test console: /test-console, /test-console/state,
 * /test-console/role.
 *
 * The property this whole suite defends is CONTAINMENT: a holder can change
 * exactly one role — their own — and there is no request they can craft that
 * names another number, because the surface has no phone parameter at all. That
 * argument only survives a future "improvement" if it is a failing test, so the
 * assertions below are written against the shape (a rejected field, an
 * untouched neighbour row) rather than against a check somebody could relax.
 *
 * The second property is that flipping a role never destroys a conversation.
 * The console is what an owner uses to test both assistants, and a flip that
 * deleted the thread it was flipping away from would make the test itself
 * unrepeatable.
 */

const PHONE = "573001112233";
const OTHER_PHONE = "573004445566";

interface Harness {
  app: FastifyInstance;
  db: DB;
  token: string;
  get: (path: string, token?: string) => Promise<LightMyRequestResponse>;
  post: (
    body: unknown,
    token?: string,
    contentType?: string,
  ) => Promise<LightMyRequestResponse>;
}

interface HarnessOptions {
  /** Skip roster registration entirely, so the console is dead. */
  empty?: boolean;
  label?: string;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const db = openDb(":memory:");
  let token = "";
  if (!options.empty) {
    token = addRosterEntry(db, PHONE, options.label ?? "Mi celular").token;
  }
  const app = Fastify({ logger: false });
  registerTestConsole(app, { db });
  await app.ready();

  const auth = (value: string | undefined): Record<string, string> =>
    value === undefined ? {} : { authorization: value };

  return {
    app,
    db,
    token,
    get: (path, bearer) =>
      app.inject({
        method: "GET",
        url: path,
        headers: auth(bearer === undefined ? undefined : `Bearer ${bearer}`),
      }),
    post: (body, bearer, contentType) =>
      app.inject({
        method: "POST",
        url: "/test-console/role",
        headers: {
          "content-type": contentType ?? "application/json",
          ...auth(bearer === undefined ? undefined : `Bearer ${bearer}`),
        },
        payload: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

/** The raw assignment row, for the byte-identical comparison below. */
function rawAssignment(db: DB, phone: string): unknown {
  return db.prepare(`SELECT phone, role, created_at FROM assignments WHERE phone = ?`).get(phone);
}

describe("test console: the shell", () => {
  it("serves an inert page with no token, no phone and no data in it", async () => {
    const h = await harness();
    const res = await h.get("/test-console");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).not.toContain(h.token);
    expect(res.body).not.toContain(PHONE);
    // The label is operator-typed and belongs to a credential; the shell is
    // served before anyone has authenticated, so it cannot carry one.
    expect(res.body).not.toContain("Mi celular");
  });

  it("marks itself uncacheable and unindexable", async () => {
    const h = await harness();
    const res = await h.get("/test-console");

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });

  it("declares a viewport, so the page is usable on the phone it is about", async () => {
    const h = await harness();
    const res = await h.get("/test-console");

    expect(res.body).toContain('name="viewport"');
  });

  it("renders untrusted text with textContent and never with innerHTML", async () => {
    const h = await harness({ label: '<img src=x onerror="alert(1)">' });
    const res = await h.get("/test-console");

    // The mechanism, pinned: the roster label is operator-typed input and the
    // page has exactly one safe way to put it on screen. innerHTML anywhere in
    // this document is the bug, whether or not it is the label being assigned.
    expect(res.body).toContain("textContent");
    expect(res.body).not.toContain("innerHTML");
    expect(res.body).not.toContain("onerror");
  });
});

describe("test console: an empty roster is a dead console", () => {
  it("404s the shell", async () => {
    const h = await harness({ empty: true });
    expect((await h.get("/test-console")).statusCode).toBe(404);
  });

  it("404s /state, with or without a token", async () => {
    const h = await harness({ empty: true });
    expect((await h.get("/test-console/state")).statusCode).toBe(404);
    expect((await h.get("/test-console/state", "anything")).statusCode).toBe(404);
  });

  it("404s /role, so no flip is even attempted", async () => {
    const h = await harness({ empty: true });
    const res = await h.post({ role: "owner" }, "anything");

    expect(res.statusCode).toBe(404);
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
  });
});

describe("test console: authentication", () => {
  it("answers absent, malformed and unknown tokens with the identical 401", async () => {
    const h = await harness();
    const expected = { error: "unauthorized" };

    const absent = await h.get("/test-console/state");
    const malformed = await h.app.inject({
      method: "GET",
      url: "/test-console/state",
      headers: { authorization: "Basic bm90LWEtYmVhcmVy" },
    });
    const unknown = await h.get("/test-console/state", "not-a-real-token");

    for (const res of [absent, malformed, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(expected);
    }
    // Byte-identical, not merely equivalent: a body that differed by a field
    // would tell a prober which of the three it hit.
    expect(new Set([absent.body, malformed.body, unknown.body]).size).toBe(1);
  });

  it("refuses the same three ways on /role, and writes nothing", async () => {
    const h = await harness();
    const before = rawAssignment(h.db, PHONE);

    const absent = await h.post({ role: "owner" });
    const malformed = await h.post({ role: "owner" }, undefined, "application/json");
    const unknown = await h.post({ role: "owner" }, "not-a-real-token");

    expect(absent.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(JSON.parse(unknown.body)).toEqual({ error: "unauthorized" });
    expect(rawAssignment(h.db, PHONE)).toEqual(before);
  });

  it("never puts the presented token in the refusal", async () => {
    const h = await harness();
    const res = await h.get("/test-console/state", "sekrit-token-value");

    expect(res.body).not.toContain("sekrit-token-value");
  });
});

describe("test console: /state", () => {
  it("describes the holder's own row, with the phone masked", async () => {
    const h = await harness();
    assignRole(h.db, PHONE, "owner");
    const res = await h.get("/test-console/state", h.token);
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.label).toBe("Mi celular");
    expect(body.role).toBe("owner");
    expect(body.agentId).toBe(AGENT_IDS.owner);
    expect(body.phoneMasked).toBe("•••• 2233");
  });

  it("never contains the full phone", async () => {
    const h = await harness();
    const res = await h.get("/test-console/state", h.token);

    expect(res.body).not.toContain(PHONE);
    // Nor the digits with the last four removed — masking is a suffix, not a
    // second copy of the number under another name.
    expect(res.body).not.toContain("57300111");
  });

  it("never contains a second phone, even when one exists and holds sessions", async () => {
    const h = await harness();
    addRosterEntry(h.db, OTHER_PHONE, "Otro equipo");
    assignRole(h.db, OTHER_PHONE, "owner");
    setSessionId(h.db, AGENT_IDS.owner, OTHER_PHONE, "session-of-someone-else");

    const res = await h.get("/test-console/state", h.token);

    expect(res.body).not.toContain(OTHER_PHONE);
    expect(res.body).not.toContain("4455");
    expect(res.body).not.toContain("Otro equipo");
    expect(res.body).not.toContain("session-of-someone-else");
  });

  it("reports BOTH threads, so the flip is understood before it is made", async () => {
    const h = await harness();
    setSessionId(h.db, AGENT_IDS.owner, PHONE, "session-owner");

    const res = await h.get("/test-console/state", h.token);
    const body = JSON.parse(res.body);

    expect(body.threads).toHaveLength(2);
    const owner = body.threads.find((t: { role: string }) => t.role === "owner");
    const customer = body.threads.find((t: { role: string }) => t.role === "customer");
    expect(owner).toMatchObject({ agentId: AGENT_IDS.owner, hasConversation: true });
    expect(owner.lastActivityAt).toEqual(expect.any(String));
    expect(customer).toMatchObject({
      agentId: AGENT_IDS.customer,
      hasConversation: false,
      lastActivityAt: null,
    });
  });

  it("reads as a customer when the phone has no assignment row at all", async () => {
    const h = await harness();
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();

    const body = JSON.parse((await h.get("/test-console/state", h.token)).body);

    expect(body.role).toBe("customer");
    expect(body.agentId).toBe(AGENT_IDS.customer);
  });

  it("ignores a phone smuggled into the query string", async () => {
    const h = await harness();
    addRosterEntry(h.db, OTHER_PHONE, "Otro equipo");
    assignRole(h.db, OTHER_PHONE, "owner");

    const res = await h.get(`/test-console/state?phone=${OTHER_PHONE}`, h.token);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(OTHER_PHONE);
    expect(JSON.parse(res.body).phoneMasked).toBe("•••• 2233");
  });

  it("is uncacheable", async () => {
    const h = await harness();
    expect((await h.get("/test-console/state", h.token)).headers["cache-control"]).toBe("no-store");
  });
});

describe("test console: /role, the flip", () => {
  it("promotes the holder and reports the change", async () => {
    const h = await harness();
    const res = await h.post({ role: "owner" }, h.token);
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ role: "owner", changed: true, agentId: AGENT_IDS.owner });
    expect(roleForPhone(h.db, PHONE)).toBe("owner");
  });

  it("reports changed:false when the same role is re-selected", async () => {
    const h = await harness();
    assignRole(h.db, PHONE, "owner");

    const body = JSON.parse((await h.post({ role: "owner" }, h.token)).body);

    expect(body).toMatchObject({ role: "owner", changed: false });
    expect(roleForPhone(h.db, PHONE)).toBe("owner");
  });

  it("never contains the full phone", async () => {
    const h = await harness();
    const res = await h.post({ role: "owner" }, h.token);

    expect(res.body).not.toContain(PHONE);
  });

  it("leaves the store with zero owners when asked, and says so", async () => {
    const h = await harness();
    assignRole(h.db, PHONE, "owner");

    const res = await h.post({ role: "customer" }, h.token);
    const body = JSON.parse(res.body);

    // ALLOWED, deliberately: refusing would break the primary use case — the
    // only owner is the person testing the customer path from their own phone.
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ role: "customer", changed: true, storeHasNoOwners: true });
    expect(roleForPhone(h.db, PHONE)).toBe("customer");
  });

  it("does not claim the store is ownerless when another owner remains", async () => {
    const h = await harness();
    assignRole(h.db, PHONE, "owner");
    assignRole(h.db, OTHER_PHONE, "owner");

    const body = JSON.parse((await h.post({ role: "customer" }, h.token)).body);

    expect(body.storeHasNoOwners).toBe(false);
  });
});

describe("test console: containment", () => {
  it("rejects a body that carries a phone, rather than dropping the field", async () => {
    const h = await harness();
    const res = await h.post({ role: "owner", phone: OTHER_PHONE }, h.token);

    expect(res.statusCode).toBe(400);
    // Nothing was written for EITHER phone: the request was refused whole.
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
    expect(rawAssignment(h.db, OTHER_PHONE)).toBeUndefined();
  });

  it("rejects any unknown field, not just a phone", async () => {
    const h = await harness();

    for (const body of [
      { role: "owner", target: OTHER_PHONE },
      { role: "owner", conversationKey: OTHER_PHONE },
      { role: "owner", agentId: AGENT_IDS.owner },
    ]) {
      const res = await h.post(body, h.token);
      expect(res.statusCode).toBe(400);
    }
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
  });

  it("leaves another phone's assignment byte-identical", async () => {
    const h = await harness();
    assignRole(h.db, OTHER_PHONE, "owner");
    const before = rawAssignment(h.db, OTHER_PHONE);

    expect((await h.post({ role: "owner" }, h.token)).statusCode).toBe(200);
    expect((await h.post({ role: "customer" }, h.token)).statusCode).toBe(200);

    expect(rawAssignment(h.db, OTHER_PHONE)).toEqual(before);
    expect(roleForPhone(h.db, OTHER_PHONE)).toBe("owner");
  });

  it("flips the token's own phone even when a query string names another", async () => {
    const h = await harness();
    assignRole(h.db, OTHER_PHONE, "customer");

    const res = await h.app.inject({
      method: "POST",
      url: `/test-console/role?phone=${OTHER_PHONE}`,
      headers: { "content-type": "application/json", authorization: `Bearer ${h.token}` },
      payload: JSON.stringify({ role: "owner" }),
    });

    expect(res.statusCode).toBe(200);
    expect(roleForPhone(h.db, PHONE)).toBe("owner");
    expect(roleForPhone(h.db, OTHER_PHONE)).toBe("customer");
  });

  it("uses another holder's token to flip only that holder", async () => {
    const h = await harness();
    const otherToken = addRosterEntry(h.db, OTHER_PHONE, "Otro equipo").token;

    expect((await h.post({ role: "owner" }, otherToken)).statusCode).toBe(200);

    expect(roleForPhone(h.db, OTHER_PHONE)).toBe("owner");
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
  });

  it("refuses a role outside the two this build serves", async () => {
    const h = await harness();

    for (const role of ["admin", "OWNER", "", null, 1]) {
      const res = await h.post({ role }, h.token);
      expect(res.statusCode).toBe(400);
    }
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
  });

  it("refuses a body that is not JSON, so a plain form POST cannot flip a role", async () => {
    const h = await harness();
    const res = await h.post("role=owner", h.token, "application/x-www-form-urlencoded");

    expect(res.statusCode).toBe(415);
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
  });

  it("refuses a malformed JSON body", async () => {
    const h = await harness();
    const res = await h.post("{not json", h.token);

    expect(res.statusCode).toBe(400);
    expect(rawAssignment(h.db, PHONE)).toBeUndefined();
  });
});

describe("test console: conversations survive the flip", () => {
  it("deletes neither session when flipping away and back", async () => {
    const h = await harness();
    assignRole(h.db, PHONE, "owner");
    setSessionId(h.db, AGENT_IDS.owner, PHONE, "session-owner");
    setSessionId(h.db, AGENT_IDS.customer, PHONE, "session-customer");
    const before = h.db
      .prepare(`SELECT agent_id, conversation_key, agent_session_id, updated_at FROM sessions`)
      .all();

    expect((await h.post({ role: "customer" }, h.token)).statusCode).toBe(200);
    expect((await h.post({ role: "owner" }, h.token)).statusCode).toBe(200);

    // Byte-identical, both rows: the console reads sessions and never writes
    // them. A flip that dropped the thread it flipped away from would make the
    // owner's test unrepeatable and would read to them as lost messages.
    expect(
      h.db
        .prepare(`SELECT agent_id, conversation_key, agent_session_id, updated_at FROM sessions`)
        .all(),
    ).toEqual(before);
    expect(getSessionId(h.db, AGENT_IDS.owner, PHONE)).toBe("session-owner");
    expect(getSessionId(h.db, AGENT_IDS.customer, PHONE)).toBe("session-customer");
  });

  it("does not touch a session belonging to another phone", async () => {
    const h = await harness();
    setSessionId(h.db, AGENT_IDS.owner, OTHER_PHONE, "session-of-someone-else");

    await h.post({ role: "owner" }, h.token);
    await h.get("/test-console/state", h.token);

    expect(getSessionId(h.db, AGENT_IDS.owner, OTHER_PHONE)).toBe("session-of-someone-else");
  });
});
