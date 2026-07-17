import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/data/db.js";
import { getSessionId, setSessionId } from "../src/data/repo.js";
import { purgeCustomerSessions, type PurgeConfig } from "../src/data/purge.js";

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
  setSessionId(db, OWNER, OWNER_SESSION);
  setSessionId(db, CUSTOMER, CUSTOMER_SESSION);
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
    expect(getSessionId(db, CUSTOMER)).toBeUndefined();
    expect(getSessionId(db, OWNER)).toBe(OWNER_SESSION);
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
    expect(getSessionId(db, CUSTOMER)).toBe(CUSTOMER_SESSION);
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
    expect(getSessionId(db, OWNER)).toBe(OWNER_SESSION); // nothing was touched
    expect(getSessionId(db, CUSTOMER)).toBe(CUSTOMER_SESSION);
    expect(transcriptExists(OWNER_SESSION)).toBe(true);
  });

  it("purges every customer, not just the first", () => {
    const second = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    setSessionId(db, OTHER_CUSTOMER, second);
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
    expect(getSessionId(db, CUSTOMER)).toBeUndefined();
    expect(transcriptExists(CUSTOMER_SESSION)).toBe(true); // untouched on disk
  });
});
