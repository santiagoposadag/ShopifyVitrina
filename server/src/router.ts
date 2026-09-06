import { isOwner, type Config } from "./config.js";
import type { Role } from "./types.js";

/**
 * Which agent answers.
 *
 * TEMPORARY, AND DELIBERATELY ONE FUNCTION. There is no definition loader yet:
 * the two personas still live in `systemPrompt(role)` and the two tool sets in
 * `buildToolServer`, so an "agent id" here names nothing that exists on disk.
 * What it does is give sessions, logs and the legacy migration a stable name to
 * key on, so the definitions can land in a later phase without moving any data.
 *
 * The phase that introduces `agents/<id>/agent.yaml` replaces this by DELETING
 * `agentIdForRole` and routing on the definition's declared roles instead. The
 * literals live here and nowhere else for exactly that reason — scattered
 * through the pipeline they would have to be found before they could be
 * removed, and one missed copy is a conversation resumed under an id nothing
 * routes to any more.
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
