import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/data/db.js";
import { getSessionId, listConversationMessages, recordOutboundMessage, setSessionId } from "../src/data/repo.js";
import {
  assertOwnerAllowlist,
  purgeCustomerSessions,
  type PurgeConfig,
} from "../src/data/purge.js";
import { AGENT_IDS } from "../src/router.js";
import { assignRole } from "../src/data/assignments.js";
import { agentConversationKey } from "../src/inbox/envelope.js";

/**
 * The purge judges a session by its CONVERSATION KEY, which on the WhatsApp
 * door is the phone. The agent id it is stored under is therefore incidental to
 * the decision — and these fixtures use the real one for each role so the
 * fixture cannot pass by accident under a mapping that no longer matches.
 */
const INVENTORY = AGENT_IDS.owner;
const SALES = AGENT_IDS.customer;

const OWNER = "573001110000";
const CUSTOMER = "573002220000";
const OTHER_CUSTOMER = "573003330000";

const OWNER_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORPHAN_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const CONFIG: PurgeConfig = {
  ownerPhoneNumbers: new Set([OWNER]),
  sessionMaxAgeDays: 7,
};

let db: DB;
let root: string;

function seedTranscript(sessionId: string, ageDays = 0): void {
  const file = join(root, `${sessionId}.jsonl`);
  writeFileSync(file, "{}\n");
  mkdirSync(join(root, sessionId), { recursive: true });
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(file, when, when);
  utimesSync(join(root, sessionId), when, when);
}

function transcriptExists(sessionId: string): boolean {
  return existsSync(join(root, `${sessionId}.jsonl`)) || existsSync(join(root, sessionId));
}

let turnCounter = 0;

/** One durable message row, filed under whichever conversation key the caller names. */
function seedMessage(agentId: string, conversationKey: string, body = "hola"): void {
  turnCounter += 1;
  recordOutboundMessage(db, {
    conversationKey,
    agentId,
    turnKey: `turn-${turnCounter}`,
    body,
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  root = mkdtempSync(join(tmpdir(), "vitrina-purge-"));
  setSessionId(db, INVENTORY, OWNER, OWNER_SESSION);
  setSessionId(db, SALES, CUSTOMER, CUSTOMER_SESSION);
  seedTranscript(OWNER_SESSION);
  seedTranscript(CUSTOMER_SESSION);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// The privilege boundary again — this time for a DESTRUCTIVE op. An owner
// mid-listing has a session upsert_product's merge semantics depend on: purging
// it silently loses their in-progress work, which is worse than any customer
// history we are deliberately throwing away.
describe("purgeCustomerSessions role boundary", () => {
  it("drops customer sessions and keeps owner sessions", () => {
    const result = purgeCustomerSessions(db, CONFIG, root);

    expect(result).toMatchObject({ purged: 1, kept: 1 });
    expect(getSessionId(db, SALES, CUSTOMER)).toBeUndefined();
    expect(getSessionId(db, INVENTORY, OWNER)).toBe(OWNER_SESSION);
  });

  it("deletes the purged customer's transcript and leaves the owner's on disk", () => {
    purgeCustomerSessions(db, CONFIG, root);

    expect(transcriptExists(CUSTOMER_SESSION)).toBe(false);
    expect(transcriptExists(OWNER_SESSION)).toBe(true);
  });

  it("decides role from the allowlist, not from what the contacts table recorded", () => {
    // A number promoted to owner keeps its session; role is never inferred from
    // stored history (config.isOwner is the only source of truth).
    const promoted: PurgeConfig = { ...CONFIG, ownerPhoneNumbers: new Set([OWNER, CUSTOMER]) };

    expect(purgeCustomerSessions(db, promoted, root)).toMatchObject({ purged: 0, kept: 2 });
    expect(getSessionId(db, SALES, CUSTOMER)).toBe(CUSTOMER_SESSION);
  });

  it("refuses to run at all when the owner allowlist is empty", () => {
    // Caught end-to-end, not by a unit test: `npm run -w server` runs from
    // server/, where loadDotEnv's relative ".env" resolved to nothing and was
    // silently swallowed — so OWNER_PHONE_NUMBERS came back empty and the real
    // tool purged the OWNER's session as a customer's. loadDotEnv now anchors at
    // REPO_ROOT; this is the second line of defence, because an empty allowlist
    // means "cannot tell owner from customer", which is never a licence to guess.
    const blind: PurgeConfig = { ...CONFIG, ownerPhoneNumbers: new Set() };

    expect(() => purgeCustomerSessions(db, blind, root)).toThrow(/OWNER_PHONE_NUMBERS is empty/);
    expect(getSessionId(db, INVENTORY, OWNER)).toBe(OWNER_SESSION); // nothing was touched
    expect(getSessionId(db, SALES, CUSTOMER)).toBe(CUSTOMER_SESSION);
    expect(transcriptExists(OWNER_SESSION)).toBe(true);
  });

  it("purges every customer, not just the first", () => {
    const second = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    setSessionId(db, SALES, OTHER_CUSTOMER, second);
    seedTranscript(second);

    expect(purgeCustomerSessions(db, CONFIG, root)).toMatchObject({ purged: 2, kept: 1 });
    expect(transcriptExists(second)).toBe(false);
  });
});

describe("purgeCustomerSessions transcript sweep", () => {
  it("collects orphans left behind by earlier resets", () => {
    // The leak this tool exists for: a session id dropped long ago whose
    // transcript nothing ever deleted.
    seedTranscript(ORPHAN_SESSION, CONFIG.sessionMaxAgeDays + 1);

    expect(purgeCustomerSessions(db, CONFIG, root).swept).toBe(1);
    expect(transcriptExists(ORPHAN_SESSION)).toBe(false);
  });

  it("does not sweep the owner session it just spared", () => {
    // The sweep runs AFTER the purge, so it must re-read the surviving rows —
    // reusing the pre-purge list would collect the owner's live transcript.
    purgeCustomerSessions(db, CONFIG, root);
    expect(transcriptExists(OWNER_SESSION)).toBe(true);
  });

  it("still drops the rows when no transcript root is configured", () => {
    // Without a root we skip the disk half rather than guess a path (that guess
    // is the developer's own Claude Code history) — but the row is what makes a
    // session resumable, so the user-visible purge must still happen.
    const result = purgeCustomerSessions(db, CONFIG, undefined);

    expect(result).toMatchObject({ purged: 1, swept: null });
    expect(getSessionId(db, SALES, CUSTOMER)).toBeUndefined();
    expect(transcriptExists(CUSTOMER_SESSION)).toBe(true); // untouched on disk
  });
});

/**
 * The refusal, on its own.
 *
 * It is exported and called a second time by the ops entry point, which passes
 * the open database so the check sees the assignments table as well. The
 * legacy-session half of the same danger — opening the database runs the
 * migration, which asks who owned each phone-keyed row — is guarded by the
 * resolver that entry point passes (router.ts refusingLegacyAgentIdFor), since
 * there is no moment before the open at which the table could be consulted.
 */
describe("assertOwnerAllowlist", () => {
  it("refuses an empty allowlist", () => {
    expect(() => assertOwnerAllowlist({ ...CONFIG, ownerPhoneNumbers: new Set() })).toThrow(
      /OWNER_PHONE_NUMBERS is empty/,
    );
  });

  it("passes when the allowlist can tell owner from customer", () => {
    expect(() => assertOwnerAllowlist(CONFIG)).not.toThrow();
  });
});

/**
 * The purge was written when every conversation key was a phone. The agent door
 * stores something no allowlist can ever match, and `isOwner` would therefore
 * read every agent-to-agent exchange as a customer's history and delete it.
 */
describe("agent-to-agent sessions are not customer histories", () => {
  const AGENT_KEY = agentConversationKey("super-agent", INVENTORY, "corr-1");
  const AGENT_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("keeps a session stored under an agent conversation key", () => {
    setSessionId(db, INVENTORY, AGENT_KEY, AGENT_SESSION);
    seedTranscript(AGENT_SESSION);

    const result = purgeCustomerSessions(db, CONFIG, root);

    expect(getSessionId(db, INVENTORY, AGENT_KEY)).toBe(AGENT_SESSION);
    expect(result).toMatchObject({ purged: 1, kept: 1, keptAgent: 1 });
  });

  // The transcript half matters as much as the row: a swept transcript is an
  // exchange that can no longer be resumed even though its row survived.
  it("leaves the transcript of a kept agent session alone", () => {
    setSessionId(db, INVENTORY, AGENT_KEY, AGENT_SESSION);
    seedTranscript(AGENT_SESSION);

    purgeCustomerSessions(db, CONFIG, root);

    expect(transcriptExists(AGENT_SESSION)).toBe(true);
  });

  // ONE axis: the same key without the namespace IS a plain conversation key,
  // and a plain key that no allowlist names is a customer's.
  it("still purges a session whose key merely looks unusual", () => {
    setSessionId(db, SALES, "super-agent:corr-1", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

    const result = purgeCustomerSessions(db, CONFIG, root);

    expect(getSessionId(db, SALES, "super-agent:corr-1")).toBeUndefined();
    expect(result).toMatchObject({ keptAgent: 0 });
  });
});

/**
 * The durable half of a conversation. `conversation_messages` holds the actual
 * words in both directions, and it is a SEPARATE table from `sessions` — a
 * purge that only drops the session row and leaves this behind has not purged
 * the conversation, it has only made it unresumable.
 */
describe("purgeCustomerSessions durable message deletion", () => {
  it("deletes the purged customer's conversation messages", () => {
    seedMessage(SALES, CUSTOMER, "quiero una remera");
    seedMessage(SALES, CUSTOMER, "talle M");

    const result = purgeCustomerSessions(db, CONFIG, root);

    expect(result).toMatchObject({ purged: 1, purgedMessages: 2 });
    expect(listConversationMessages(db, CUSTOMER)).toHaveLength(0);
  });

  it("keeps an owner's conversation messages", () => {
    seedMessage(INVENTORY, OWNER, "subí el stock a 10");

    purgeCustomerSessions(db, CONFIG, root);

    expect(listConversationMessages(db, OWNER)).toHaveLength(1);
  });

  it("keeps an agent-to-agent conversation's messages", () => {
    const AGENT_KEY = agentConversationKey("super-agent", INVENTORY, "corr-msg");
    const AGENT_SESSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    setSessionId(db, INVENTORY, AGENT_KEY, AGENT_SESSION);
    seedMessage(INVENTORY, AGENT_KEY, "consulta de otro agente");

    purgeCustomerSessions(db, CONFIG, root);

    expect(listConversationMessages(db, AGENT_KEY)).toHaveLength(1);
  });

  it("reports a count that matches what was actually deleted, across several customers", () => {
    const second = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    setSessionId(db, SALES, OTHER_CUSTOMER, second);
    seedMessage(SALES, CUSTOMER, "uno");
    seedMessage(SALES, CUSTOMER, "dos");
    seedMessage(SALES, OTHER_CUSTOMER, "tres");

    const result = purgeCustomerSessions(db, CONFIG, root);

    expect(result.purgedMessages).toBe(3);
    expect(listConversationMessages(db, CUSTOMER)).toHaveLength(0);
    expect(listConversationMessages(db, OTHER_CUSTOMER)).toHaveLength(0);
  });

  // The hard case: a session can expire and be swept (or be cleared by an
  // earlier purge) while its messages persist by design — deleteConversationMessages
  // never runs on a timer. The loop this tool runs iterates SESSIONS
  // (listSessions), so a conversation with no session row is invisible to it.
  //
  // Reaching these belongs here in principle — the whole point of this slice is
  // that a purge's name should match what it does — but repo.ts exposes no way
  // to enumerate conversation_keys that have messages independently of the
  // sessions table, and hacking that up with raw SQL from outside repo.ts would
  // bypass the one seam every other caller in this codebase goes through. So
  // this case is documented as a KNOWN GAP rather than silently patched: it
  // requires a new repo.ts function (see purge.ts's comment at the loop) before
  // it can close.
  it("cannot reach a customer's messages once its session row is gone (documented gap)", () => {
    const ORPHAN_KEY = "573009990000";
    seedMessage(SALES, ORPHAN_KEY, "nadie me va a leer");
    // No setSessionId for ORPHAN_KEY: this conversation has messages but no
    // session row, exactly like one whose session already expired and was swept.

    const result = purgeCustomerSessions(db, CONFIG, root);

    expect(listConversationMessages(db, ORPHAN_KEY)).toHaveLength(1); // NOT purged — see comment above
    expect(result.purged).toBe(1); // only CUSTOMER, the one with a session row
  });
});

/**
 * The refusal and the role decision, once the ASSIGNMENTS TABLE is what the
 * router reads and OWNER_PHONE_NUMBERS is only its seed.
 *
 * A guard that keeps checking the variable alone has quietly stopped guarding:
 * it would refuse a deployment that can tell owner from customer perfectly
 * well, and — worse — it would let this tool delete the session of an owner the
 * table names and the variable does not.
 */
describe("purge with owners in the assignments table", () => {
  const NO_VARIABLE: PurgeConfig = { ...CONFIG, ownerPhoneNumbers: new Set() };

  it("refuses when neither the variable nor the table names an owner", () => {
    expect(() => assertOwnerAllowlist(NO_VARIABLE, db)).toThrow(/OWNER_PHONE_NUMBERS is empty/);
    expect(() => purgeCustomerSessions(db, NO_VARIABLE, root)).toThrow(
      /OWNER_PHONE_NUMBERS is empty/,
    );
    expect(getSessionId(db, INVENTORY, OWNER)).toBe(OWNER_SESSION); // nothing was touched
  });

  // ONE axis from the case above: the same empty variable, one owner row.
  it("runs with an empty variable once the table names an owner", () => {
    assignRole(db, OWNER, "owner");
    expect(() => assertOwnerAllowlist(NO_VARIABLE, db)).not.toThrow();
  });

  // A customer row is not an owner. The refusal is about whether an OWNER can
  // be recognised, not about whether the table has rows in it.
  it("still refuses when the table holds only customers", () => {
    assignRole(db, CUSTOMER, "customer");
    expect(() => assertOwnerAllowlist(NO_VARIABLE, db)).toThrow(/OWNER_PHONE_NUMBERS is empty/);
  });

  // The destructive half of the same question: an owner the ops tool assigned,
  // whose phone the variable never named, must keep their session.
  it("keeps the session of an owner only the table knows about", () => {
    assignRole(db, OWNER, "owner");

    const result = purgeCustomerSessions(db, NO_VARIABLE, root);

    expect(getSessionId(db, INVENTORY, OWNER)).toBe(OWNER_SESSION);
    expect(transcriptExists(OWNER_SESSION)).toBe(true);
    expect(result).toMatchObject({ purged: 1, kept: 1 });
  });

  // The one direction in which the two sources can disagree: demoted in the
  // table, still named by the variable. A destructive tool resolves that the
  // conservative way — it keeps the history rather than acting on a
  // disagreement it noticed.
  it("keeps a session the table demoted while the variable still names it", () => {
    assignRole(db, OWNER, "customer");

    expect(purgeCustomerSessions(db, CONFIG, root)).toMatchObject({ purged: 1, kept: 1 });
    expect(getSessionId(db, INVENTORY, OWNER)).toBe(OWNER_SESSION);
  });

  // Without a database there is no table to ask, so the variable is all there
  // is — the strictly more conservative half of the check.
  it("judges the variable alone when it is called without a database", () => {
    assignRole(db, OWNER, "owner");
    expect(() => assertOwnerAllowlist(NO_VARIABLE)).toThrow(/OWNER_PHONE_NUMBERS is empty/);
  });
});

/**
 * The defect this scoping exists to fix. `sessions` is keyed
 * (agent_id, conversation_key), so ONE phone can hold a row under BOTH
 * AGENT_IDS.owner and AGENT_IDS.customer — used the inventory agent once,
 * then the phone's CURRENT role reads as customer (never in the allowlist
 * for that role, or demoted from it). isOwnerKey alone judges the phone, not
 * the session, and would classify BOTH rows as a customer's — destroying the
 * owner-agent conversation along with the real customer one. agent_id records
 * what the conversation WAS HAD as, a fact isOwnerKey cannot see.
 */
describe("purgeCustomerSessions spares a session by its own agent_id, not just the phone's current role", () => {
  const DUAL_SESSION = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    // CUSTOMER already has a SALES session from the top-level beforeEach.
    // This adds an owner-agent session under the SAME phone — CUSTOMER is not
    // in CONFIG's allowlist, so isOwnerKey(CUSTOMER) is false, yet this
    // session is owner-mode history.
    setSessionId(db, INVENTORY, CUSTOMER, DUAL_SESSION);
    seedTranscript(DUAL_SESSION);
    seedMessage(INVENTORY, CUSTOMER, "cargué 10 remeras");
    seedMessage(SALES, CUSTOMER, "quiero una remera");
  });

  it("keeps the owner-agent session, its messages and its transcript", () => {
    purgeCustomerSessions(db, CONFIG, root);

    expect(getSessionId(db, INVENTORY, CUSTOMER)).toBe(DUAL_SESSION);
    expect(transcriptExists(DUAL_SESSION)).toBe(true);
    const kept = listConversationMessages(db, CUSTOMER);
    expect(kept).toEqual([
      expect.objectContaining({ agent_id: INVENTORY, body: "cargué 10 remeras" }),
    ]);
  });

  it("still drops the customer-agent session under the very same phone", () => {
    purgeCustomerSessions(db, CONFIG, root);

    expect(getSessionId(db, SALES, CUSTOMER)).toBeUndefined();
    expect(transcriptExists(CUSTOMER_SESSION)).toBe(false);
  });

  it("reports the spared session in kept, not purged, and a message count matching only what was removed", () => {
    const result = purgeCustomerSessions(db, CONFIG, root);

    // Sessions in play: OWNER's own inventory session and CUSTOMER's dual
    // inventory session are both spared; only SALES/CUSTOMER is purged.
    expect(result).toMatchObject({ purged: 1, kept: 2, purgedMessages: 1 });
  });
});
