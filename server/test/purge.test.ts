import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/data/db.js";
import { getSessionId, setSessionId } from "../src/data/repo.js";
import {
  assertOwnerAllowlist,
  purgeCustomerSessions,
  type PurgeConfig,
} from "../src/data/purge.js";
import { agentIdForRole } from "../src/router.js";
import { agentConversationKey } from "../src/inbox/envelope.js";

/**
 * The purge judges a session by its CONVERSATION KEY, which on the WhatsApp
 * door is the phone. The agent id it is stored under is therefore incidental to
 * the decision — and these fixtures use the real one for each role so the
 * fixture cannot pass by accident under a mapping that no longer matches.
 */
const INVENTORY = agentIdForRole("owner");
const SALES = agentIdForRole("customer");

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
 * It is exported and called a second time by the ops entry point BEFORE it
 * opens the database, because opening the database now runs the session
 * migration — which asks this same allowlist which agent owned each legacy row.
 * An empty one there would file the owner's session under the customer agent,
 * and the check inside purgeCustomerSessions would then be guarding a decision
 * that had already been made.
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
