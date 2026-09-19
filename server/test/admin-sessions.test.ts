import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_CLAIM_TTL_MINUTES,
  ADMIN_SESSION_TTL_HOURS,
  authenticateAdminSession,
  countLiveAdminSessions,
  deleteStaleAdminSessions,
  issueAdminSession,
  listAdminSessions,
  listLiveAdminSessions,
  revokeAdminSession,
  revokeAdminSessionsForPhone,
} from "../src/data/admin-sessions.js";
import { isAdminLinkRequest } from "../src/admin/link-request.js";
import { addRosterEntry, findRosterByToken } from "../src/data/test-roster.js";
import { findAgentByToken, hashAgentToken, mintAgentToken, upsertAgentCredential } from "../src/data/agent-registry.js";
import { openDb, type DB } from "../src/data/db.js";

/**
 * ADMIN ACCESS AS SESSIONS THAT DIE ON THEIR OWN.
 *
 * There is no long-lived admin credential in this build, and that is a decision
 * about the DELIVERY CHANNEL: the token travels through a WhatsApp chat, which
 * is backed up, synced to WhatsApp Web, and readable by whoever holds the
 * phone. A permanent credential delivered that way turns one forwarded message
 * into permanent access to every customer's data.
 *
 * So what this suite defends is that every token dies — on its claim deadline
 * if nobody opens it, on its session deadline if somebody does, and immediately
 * on revocation — and that the console is CLOSED whenever none is alive.
 */

const OWNER = "573001112233";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

/** Push a session's deadline into the past, as the clock would. */
function expire(id: number): void {
  db.prepare(`UPDATE admin_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(
    id,
  );
}

describe("issuing a session", () => {
  it("mints a token that resolves back to the phone that asked", () => {
    const { token, session } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });

    expect(authenticateAdminSession(db, token)).toMatchObject({
      id: session.id,
      phone: OWNER,
      issued_via: "whatsapp",
    });
  });

  /**
   * The phone goes through the SAME normalisation `assignments` is keyed by. A
   * row written '+57 300…' would attribute an admin's writes to a number no
   * lookup can match, and the attribution is the only reason the column exists.
   */
  it("normalises the phone into the assignments key space", () => {
    const { session } = issueAdminSession(db, { phone: "+57 300 111 2233", issuedVia: "cli" });
    expect(session.phone).toBe("573001112233");
  });

  it("refuses a phone that normalises to nothing", () => {
    expect(() => issueAdminSession(db, { phone: "sin dígitos", issuedVia: "cli" })).toThrow(
      /contains no digits/,
    );
  });

  it("records how it was issued, so a terminal link is visible as one", () => {
    issueAdminSession(db, { phone: OWNER, issuedVia: "cli" });
    expect(listLiveAdminSessions(db)[0]?.issued_via).toBe("cli");
  });

  it("stores no plaintext token anywhere", () => {
    const { token } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const row = db.prepare(`SELECT * FROM admin_sessions`).get() as Record<string, unknown>;
    expect(Object.values(row).join(" ")).not.toContain(token);
  });
});

describe("the two deadlines", () => {
  /**
   * The claim window is what makes a link from last week worthless — most of
   * what this design buys, since the realistic leak is a phone handed over or a
   * screenshot forwarded months later, not somebody watching the chat live.
   */
  it("starts unclaimed, with a deadline minutes away", () => {
    const { session } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    expect(session.claimed_at).toBeNull();
    expect(ADMIN_CLAIM_TTL_MINUTES).toBeLessThanOrEqual(60);
  });

  /**
   * Claiming happens on the FIRST authenticated request, because that is the
   * only moment anything observes the link being opened — there is no separate
   * login step, the page simply starts fetching.
   */
  it("claims on first use and extends to the session length", () => {
    const { token, session } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const before = session.expires_at;

    const claimed = authenticateAdminSession(db, token);

    expect(claimed?.claimed_at).not.toBeNull();
    expect(claimed?.expires_at).not.toBe(before);
    expect(ADMIN_SESSION_TTL_HOURS).toBeGreaterThan(0);
  });

  /** Stamped once, never moved — it is when the link was opened, not when it was last used. */
  it("does not re-claim on later requests", () => {
    const { token } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const first = authenticateAdminSession(db, token);
    const second = authenticateAdminSession(db, token);

    expect(second?.claimed_at).toBe(first?.claimed_at);
  });

  it("refuses a link nobody opened in time", () => {
    const { token, session } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    expire(session.id);

    expect(authenticateAdminSession(db, token)).toBeNull();
  });

  it("refuses a claimed session past its own deadline", () => {
    const { token, session } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    authenticateAdminSession(db, token); // claim it
    expire(session.id);

    expect(authenticateAdminSession(db, token)).toBeNull();
  });
});

describe("revocation", () => {
  it("kills one session on its next request", () => {
    const { token, session } = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });

    expect(revokeAdminSession(db, session.id)).toBe(true);
    expect(authenticateAdminSession(db, token)).toBeNull();
    // Already revoked: nothing to do, and it says so rather than reporting a
    // second success an operator would read as a second live session killed.
    expect(revokeAdminSession(db, session.id)).toBe(false);
  });

  /**
   * "This person no longer works here" is TWO steps and this is the second:
   * removing their `assignments` row stops them asking for a NEW link and does
   * nothing to a session already issued, because that session is a token and
   * not a role lookup.
   */
  it("kills every live session for a phone at once", () => {
    const a = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const b = issueAdminSession(db, { phone: OWNER, issuedVia: "cli" });
    const other = issueAdminSession(db, { phone: "573004445566", issuedVia: "whatsapp" });

    expect(revokeAdminSessionsForPhone(db, OWNER)).toBe(2);
    expect(authenticateAdminSession(db, a.token)).toBeNull();
    expect(authenticateAdminSession(db, b.token)).toBeNull();
    expect(authenticateAdminSession(db, other.token)).not.toBeNull();
  });
});

describe("what 'the console is open' means", () => {
  it("counts only sessions that could be used right now", () => {
    const live = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const dead = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const revoked = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    expire(dead.session.id);
    revokeAdminSession(db, revoked.session.id);

    expect(countLiveAdminSessions(db)).toBe(1);
    expect(listLiveAdminSessions(db).map((s) => s.id)).toEqual([live.session.id]);
  });

  it("is zero on a fresh database, so the surface ships closed", () => {
    expect(countLiveAdminSessions(db)).toBe(0);
    expect(authenticateAdminSession(db, "anything")).toBeNull();
  });
});

describe("token handling", () => {
  it("answers null for an absent or malformed token instead of throwing", () => {
    issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });

    expect(authenticateAdminSession(db, undefined)).toBeNull();
    expect(authenticateAdminSession(db, "")).toBeNull();
    expect(authenticateAdminSession(db, "no-es-hex")).toBeNull();
    // A token of the wrong LENGTH is the one that would make timingSafeEqual
    // throw and take the console down for every holder, not just this caller.
    expect(authenticateAdminSession(db, "ab")).toBeNull();
  });

  /**
   * The credential tables are separate precisely so that none is a superset of
   * another, and the failure that separation prevents is invisible from either
   * side's code. These are what stop a future "let's unify the token lookup".
   */
  it("does not cross with the test-console roster or the agent door", () => {
    const admin = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const roster = addRosterEntry(db, OWNER, "Mi celular");
    const agentToken = mintAgentToken();
    upsertAgentCredential(db, {
      agent_id: "super-agent",
      token_hash: hashAgentToken(agentToken),
      reach: [],
      callback_prefix: null,
      token: agentToken,
    } as unknown as Parameters<typeof upsertAgentCredential>[1]);

    expect(findRosterByToken(db, admin.token)).toBeNull();
    expect(findAgentByToken(db, admin.token)).toBeNull();
    expect(authenticateAdminSession(db, roster.token)).toBeNull();
    expect(authenticateAdminSession(db, agentToken)).toBeNull();
  });
});

describe("sweeping", () => {
  /**
   * NOT ON EXPIRY, on expiry plus a grace period: a dead session is still an
   * audit record, and an admin write to a conversation names the session that
   * made it.
   */
  it("keeps a recently dead session and drops a long-dead one", () => {
    const recent = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    const ancient = issueAdminSession(db, { phone: OWNER, issuedVia: "whatsapp" });
    expire(recent.session.id);
    db.prepare(`UPDATE admin_sessions SET expires_at = datetime('now', '-90 days') WHERE id = ?`).run(
      ancient.session.id,
    );

    expect(deleteStaleAdminSessions(db, 30)).toBe(1);
    expect(listAdminSessions(db).map((s) => s.id)).toEqual([recent.session.id]);
  });
});

describe("asking for the link over WhatsApp", () => {
  it("matches the request words whatever the casing, accents or punctuation", () => {
    for (const text of ["panel", "PANEL", "Panel!", "  panel  ", "consola", "Cónsola"]) {
      expect(isAdminLinkRequest(text)).toBe(true);
    }
  });

  /**
   * THE CASE THIS RULE EXISTS FOR. An owner writing about a product must never
   * be answered with a live credential, so the match is over the WHOLE message
   * and never a substring.
   */
  it("does not match a message that merely contains the word", () => {
    for (const text of [
      "abre el panel de la camisa negra",
      "sube el panel de madera a 80000",
      "panel de control",
      "necesito un panel",
      "¿cuánto vale el panel?",
    ]) {
      expect(isAdminLinkRequest(text)).toBe(false);
    }
  });

  /**
   * A burst carrying a photo renders a photo line into the batch text, so it
   * can never be exactly one of the request words — which is what keeps an
   * owner's listing burst from minting a credential.
   */
  it("does not match a coalesced burst that carried a photo", () => {
    expect(isAdminLinkRequest("(El usuario envió 3 fotos)\npanel")).toBe(false);
  });
});
