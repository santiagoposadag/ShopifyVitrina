import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.js";

/**
 * Who may speak through the agent door, and what each caller may reach.
 *
 * This table IS the switch. The door authenticates by looking a presented token
 * up in here, so an empty registry matches nothing and refuses everything —
 * there is no "enabled" flag that could be left on by a deployment that never
 * meant to open a second entrance. Adding the first row opens it; deleting the
 * last row closes it again, with no restart either way.
 *
 * NOTHING IN HERE IS A PLAINTEXT CREDENTIAL. The database file is backed up
 * (data/backup.ts) and lives on a volume; a stored token would be a store's
 * write access sitting in every copy of it.
 */

/** A caller as the door needs it: identity, permission, and callback policy. */
export interface AgentCredential {
  agentId: string;
  /** Agent ids this credential may send to, as the OPERATOR permitted them. */
  reach: string[];
  /**
   * The only URL family this caller may name in `replyTo`, or undefined for
   * "none". A callback is a request WE make to a URL a request body chose, so
   * the default has to be that it cannot choose one at all.
   */
  callbackPrefix?: string;
}

/**
 * Mint a token for an operator to hand to a caller.
 *
 * 256 bits from the CSPRNG, base64url so it survives a header, an env var and a
 * shell without quoting. Length is what makes the SHA-256 at rest sufficient:
 * there is no dictionary to run against a value drawn uniformly from 2^256, so
 * the slow-KDF reasoning that applies to passwords does not apply here.
 */
export function mintAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * How a token is stored and compared. Exported for the ops entry point, which
 * must be able to write a row without ever holding the plaintext afterwards.
 */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Create or rotate a caller's credential.
 *
 * ROTATION REPLACES: writing a new token here invalidates the old one on the
 * next request, with no overlap window. That is a real operational constraint
 * (the caller must be updated in the same maintenance step) and it is the
 * conservative direction — a second live token per agent is a second thing to
 * leak, and nothing in this build needs one yet.
 */
export function upsertAgentCredential(
  db: DB,
  input: AgentCredential & { token: string },
): void {
  db.prepare(
    `INSERT INTO agent_registry (agent_id, token_hash, reach, callback_prefix)
     VALUES (@agent_id, @token_hash, @reach, @callback_prefix)
     ON CONFLICT(agent_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       reach = excluded.reach,
       callback_prefix = excluded.callback_prefix,
       rotated_at = datetime('now')`,
  ).run({
    agent_id: input.agentId,
    token_hash: hashAgentToken(input.token),
    // JSON rather than a comma-joined string: an agent id is data an operator
    // types, and a list format that cannot represent one containing its own
    // separator is a list format that silently grants the wrong reach.
    reach: JSON.stringify(input.reach),
    callback_prefix: input.callbackPrefix ?? null,
  });
}

/** Remove a caller's credential. The door closes for it on the next request. */
export function deleteAgentCredential(db: DB, agentId: string): boolean {
  return db.prepare(`DELETE FROM agent_registry WHERE agent_id = ?`).run(agentId).changes > 0;
}

interface RegistryRow {
  agent_id: string;
  token_hash: string;
  reach: string;
  callback_prefix: string | null;
}

function toCredential(row: RegistryRow): AgentCredential {
  let reach: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.reach);
    // A malformed reach grants NOTHING rather than everything. The column is
    // operator-written, and the failure mode of guessing here is a caller with
    // reach it was never given.
    if (Array.isArray(parsed)) reach = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    reach = [];
  }
  return {
    agentId: row.agent_id,
    reach,
    callbackPrefix: row.callback_prefix ?? undefined,
  };
}

/**
 * The caller a bearer token identifies, or null.
 *
 * A SCAN with a constant-time compare per row, not a lookup by hash. The
 * registry holds a handful of rows, and this keeps the door's answer identical
 * — one refusal, no detail — whether the token is unknown, malformed or absent:
 * a caller learns nothing about which of those it was, and neither does anyone
 * watching the response.
 *
 * The comparison is over the HASHES. Comparing the plaintext would mean holding
 * one, and a `===` on a secret leaks its prefix through timing the same way a
 * signature check would (see inbox/webhook.ts secretEquals, same reasoning).
 */
export function findAgentByToken(db: DB, token: string | undefined): AgentCredential | null {
  if (!token) return null;
  const presented = Buffer.from(hashAgentToken(token), "hex");
  const rows = db
    .prepare(`SELECT agent_id, token_hash, reach, callback_prefix FROM agent_registry`)
    .all() as RegistryRow[];

  let found: RegistryRow | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.token_hash, "hex");
    // Length-guard first: timingSafeEqual THROWS on a length mismatch, which a
    // truncated or hand-edited token_hash would otherwise turn into a 500 that
    // takes the whole door down for every caller.
    if (stored.length !== presented.length) continue;
    // No early return: every row is compared, so the time this takes does not
    // depend on WHERE in the table the matching credential sits.
    if (timingSafeEqual(stored, presented)) found = row;
  }
  return found ? toCredential(found) : null;
}

/** Every registered caller, for the boot log and the ops tool. Never a token. */
export function listAgentCredentials(db: DB): AgentCredential[] {
  const rows = db
    .prepare(
      `SELECT agent_id, token_hash, reach, callback_prefix FROM agent_registry ORDER BY agent_id`,
    )
    .all() as RegistryRow[];
  return rows.map(toCredential);
}

/** How many callers exist. Zero means the agent door is closed. */
export function countAgentCredentials(db: DB): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM agent_registry`).get() as { n: number };
  return row.n;
}
