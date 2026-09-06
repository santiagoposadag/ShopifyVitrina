import { isOwner, type Config } from "./config.js";
import type { Role } from "./types.js";

/**
 * Which agent answers.
 *
 * TEMPORARY, AND DELIBERATELY ONE FUNCTION. The two personas now live in
 * `agents/<id>/prompt.md` and the two tool sets are still selected by
 * `ctx.role` in `buildToolServer` — Phase 3 is what makes `agent.yaml`'s
 * `tools[]` the authority there. What this function does is give sessions,
 * logs and the legacy migration a stable name to key on, independent of
 * whichever phase the tool selection is in.
 *
 * The phase that replaces `isOwner(phone)` with an assignments table (§2.7)
 * is what finally DELETES `agentIdForRole` and routes on a definition's
 * declared roles instead. The literals live here and nowhere else for exactly
 * that reason — scattered through the pipeline they would have to be found
 * before they could be removed, and one missed copy is a conversation resumed
 * under an id nothing routes to any more.
 */
export const AGENT_IDS = {
  owner: "vitrina-inventario",
  customer: "vitrina-ventas",
} as const satisfies Record<Role, string>;

export type AgentId = (typeof AGENT_IDS)[Role];

/**
 * The role → agent mapping, and the ONLY place these two ids are written.
 *
 * Changing an id here silently orphans every session stored under the old one:
 * the row survives, nothing reads it, and the person's next message starts a
 * fresh conversation with no error anywhere. If one ever has to change, it
 * needs a migration step next to the sessions rebuild in data/db.ts.
 */
export function agentIdForRole(role: Role): AgentId {
  return AGENT_IDS[role];
}

/**
 * The same decision for a phone: allowlist → role → agent.
 *
 * Two callers need it away from the request path — the composition root, when
 * it re-keys sessions written by a build that only knew phones, and the purge
 * tool, which opens the database and therefore runs that same migration. Both
 * MUST agree with what live traffic does, or a session is migrated under an id
 * no turn will ever look up: the row survives, nothing reads it, and the
 * person's next message quietly starts from nothing.
 */
export function agentIdForPhone(config: Pick<Config, "ownerPhoneNumbers">, phone: string): AgentId {
  return agentIdForRole(isOwner(config, phone) ? "owner" : "customer");
}
