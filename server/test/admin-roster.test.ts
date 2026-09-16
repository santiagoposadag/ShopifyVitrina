import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdminEntry,
  countAdminEntries,
  deleteAdminEntry,
  findAdminByToken,
  listAdminEntries,
  rotateAdminToken,
} from "../src/data/admin-roster.js";
import { addRosterEntry, findRosterByToken } from "../src/data/test-roster.js";
import {
  findAgentByToken,
  hashAgentToken,
  mintAgentToken,
  upsertAgentCredential,
} from "../src/data/agent-registry.js";
import { openDb, type DB } from "../src/data/db.js";

/**
 * The admin credential.
 *
 * WHAT THIS SUITE IS REALLY DEFENDING is the disjointness of the three
 * credential tables. `admin_roster` grants a read of every conversation in the
 * store; `test_roster` grants one phone the ability to flip its OWN role;
 * `agent_registry` grants the right to speak AS an agent. They are three tables
 * precisely so that none is a superset of another, and the failure that
 * separation prevents is invisible from either side's code — a test link that
 * silently became a reader of every customer's messages would look exactly like
 * a test link.
 *
 * So the crossing tests below are not paranoia about a bug that exists; they
 * are what stops a future "let's unify the token lookup" from shipping.
 */

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("the admin roster", () => {
  it("is empty until an operator enrols someone, and an empty roster authenticates nobody", () => {
    expect(countAdminEntries(db)).toBe(0);
    expect(findAdminByToken(db, "anything")).toBeNull();
  });

  it("mints a token that resolves back to its own entry", () => {
    const { token } = addAdminEntry(db, "santiago", "Portátil");

    expect(findAdminByToken(db, token)).toMatchObject({
      name: "santiago",
      label: "Portátil",
    });
  });

  it("normalises the name, so one person is one row", () => {
    addAdminEntry(db, "  Santiago  ", "Portátil");

    expect(listAdminEntries(db).map((e) => e.name)).toEqual(["santiago"]);
  });

  it("refuses a name that is not a usable identifier", () => {
    expect(() => addAdminEntry(db, "santiago posada", "x")).toThrow(/not a usable admin name/);
    expect(() => addAdminEntry(db, "", "x")).toThrow(/needs a name/);
  });

  /**
   * An upsert would silently invalidate a live link, and its holder would start
   * getting 401s with nothing connecting the two events. Replacing a token has
   * to be asked for.
   */
  it("never overwrites an existing credential, and names rotate as the remedy", () => {
    const first = addAdminEntry(db, "santiago", "Portátil");

    expect(() => addAdminEntry(db, "santiago", "Otro")).toThrow(/Rotate it/);
    expect(findAdminByToken(db, first.token)).not.toBeNull();
  });

  it("rotates with no overlap window, and carries the label over", () => {
    const first = addAdminEntry(db, "santiago", "Portátil");
    const second = rotateAdminToken(db, "santiago");

    expect(findAdminByToken(db, first.token)).toBeNull();
    expect(findAdminByToken(db, second.token)).toMatchObject({ label: "Portátil" });
    expect(listAdminEntries(db)[0]?.rotated_at).not.toBeNull();
  });

  it("refuses to rotate a credential that does not exist", () => {
    expect(() => rotateAdminToken(db, "nadie")).toThrow(/add one before rotating/);
  });

  /**
   * Revocation is deleting the row, which takes effect on the next request with
   * no restart — that is the whole reason there is no expiry column and no
   * second enabling flag.
   */
  it("revokes on the next lookup once the row is deleted", () => {
    const { token } = addAdminEntry(db, "santiago", "Portátil");

    expect(deleteAdminEntry(db, "santiago")).toBe(true);
    expect(findAdminByToken(db, token)).toBeNull();
    expect(deleteAdminEntry(db, "santiago")).toBe(false);
  });

  it("stores no plaintext token anywhere", () => {
    const { token } = addAdminEntry(db, "santiago", "Portátil");
    const row = db.prepare(`SELECT * FROM admin_roster`).get() as Record<string, unknown>;

    expect(Object.values(row).join(" ")).not.toContain(token);
  });

  it("answers null for an absent or malformed token instead of throwing", () => {
    addAdminEntry(db, "santiago", "Portátil");

    expect(findAdminByToken(db, undefined)).toBeNull();
    expect(findAdminByToken(db, "")).toBeNull();
    expect(findAdminByToken(db, "no-es-hex")).toBeNull();
    // A token of the wrong LENGTH is the one that would make timingSafeEqual
    // throw and take the console down for every holder, not just this caller.
    expect(findAdminByToken(db, "ab")).toBeNull();
  });
});

/** One agent-door credential, returning its plaintext token. */
function seedAgentCredential(): string {
  const token = mintAgentToken();
  upsertAgentCredential(db, {
    agent_id: "super-agent",
    token_hash: hashAgentToken(token),
    reach: [],
    callback_prefix: null,
    token,
  } as unknown as Parameters<typeof upsertAgentCredential>[1]);
  return token;
}

describe("the three credential tables stay disjoint", () => {
  it("does not let an admin token authenticate at the test console or the agent door", () => {
    const { token } = addAdminEntry(db, "santiago", "Portátil");

    expect(findRosterByToken(db, token)).toBeNull();
    expect(findAgentByToken(db, token)).toBeNull();
  });

  it("does not let a test-console token read conversations", () => {
    const { token } = addRosterEntry(db, "573001112233", "Mi celular");

    expect(findAdminByToken(db, token)).toBeNull();
  });

  it("does not let an agent-door token read conversations", () => {
    const token = seedAgentCredential();

    expect(findAdminByToken(db, token)).toBeNull();
  });

  it("keeps the three tables' counts independent", () => {
    addAdminEntry(db, "santiago", "Portátil");
    addRosterEntry(db, "573001112233", "Mi celular");
    seedAgentCredential();

    expect(countAdminEntries(db)).toBe(1);
  });
});
