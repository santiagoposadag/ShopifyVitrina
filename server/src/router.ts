import { normalizePhone } from "./config.js";
import type { AgentDefinition } from "./agent/definition.js";
import { roleForPhone } from "./data/assignments.js";
import type { DB } from "./data/db.js";
import type { Role } from "./types.js";

/**
 * Which agent answers, and as what.
 *
 * The decision §2.5 of docs/agent-platform-decoupling.md draws as one arrow:
 * principal → role → agentId. Both halves are DATA now. The role comes from the
 * `assignments` table (data/assignments.ts), seeded from OWNER_PHONE_NUMBERS but
 * no longer defined by it; the agent comes from the definitions' own `roles`
 * lists, so an agent that changes who it serves says so in its own agent.yaml.
 *
 * ROLE IS FROM THE TRANSPORT, NEVER FROM THE TEXT. The only input here is the
 * phone the WhatsApp door authenticated against a signature over the raw body.
 * A person who writes "soy el dueño" has changed the text and nothing else.
 *
 * AN AGENT PRINCIPAL HAS NO ROLE and no row, and there is deliberately no
 * function here that would give it one: its target agent is stamped by the door
 * that authenticated its token, and its privileges are that definition's
 * `tools[]` plus the registry's `reach` (see inbox/a2a.ts, and TurnContext.role
 * for why "customer" is not a safe default for a caller with no phone).
 */

/**
 * The agent definitions this build LOADS, indexed by the role each declares.
 *
 * A LOAD LIST, not the routing table: `createRouter` derives role → agent from
 * the definitions it is handed, so this is only what index.ts reads off disk and
 * what tests name the two agents by. `router.test.ts` pins the two against each
 * other, so a definition whose `roles` changed cannot silently disagree with the
 * list of files this build opens.
 *
 * The ids themselves are durable data: they are written into `sessions.agent_id`.
 * Changing one orphans every session stored under the old id — the row survives,
 * nothing reads it, and the person's next message starts a fresh conversation
 * with no error anywhere. If one ever must change, it needs a migration step
 * next to the sessions rebuild in data/db.ts.
 */
export const AGENT_IDS = {
  owner: "vitrina-inventario",
  customer: "vitrina-ventas",
} as const satisfies Record<Role, string>;

export type AgentId = (typeof AGENT_IDS)[Role];

/**
 * Every role the router can produce, exhaustively.
 *
 * The `satisfies Record<Role, true>` is the point: a third role added to `Role`
 * fails to compile here, rather than silently becoming a role no definition
 * covers and no boot check notices.
 */
const ROUTABLE_ROLES = Object.keys({
  owner: true,
  customer: true,
} satisfies Record<Role, true>) as Role[];

/** Who a phone is, and which agent therefore answers it. */
export interface Router {
  /**
   * The role the assignments table gives this phone; "customer" when it has no
   * row. Read PER CALL, never cached: an operator who grants or revokes access
   * through the ops entry point must not also have to restart the server, and a
   * cached allowlist is how a revoked owner keeps their access until someone
   * redeploys.
   *
   * The granularity that buys is a MESSAGE, not an instant. A turn already in
   * flight keeps the role and the agent it was routed with — its tools were
   * bound before the change — so a revocation lands from that person's next
   * message. Bounded by one turn, and the alternative (re-checking mid-turn)
   * would mean a tool call failing halfway through the owner's own edit.
   */
  roleFor(phone: string): Role;
  /** phone → role → agentId, the whole decision in one call. */
  routeWhatsApp(phone: string): { role: Role; agentId: string };
}

export interface RouterDeps {
  db: DB;
  /** The definitions this build loaded and validated. Their `roles` are the map. */
  definitions: Iterable<AgentDefinition>;
}

/**
 * Build the router from the definitions this build serves.
 *
 * Both checks below fail the BOOT, for the same reason every other definition
 * check does: they are deploy-time mistakes in a data file, and the alternative
 * is discovering them on a live message. Two agents claiming one role would be
 * a coin flip decided by load order — an owner reaching the sales assistant on
 * one deploy and the inventory assistant on the next. A role no agent claims
 * would route a real person to an agent id nothing has a definition for.
 */
export function createRouter(deps: RouterDeps): Router {
  const byRole = new Map<Role, string>();
  for (const definition of deps.definitions) {
    for (const role of definition.roles) {
      const claimed = byRole.get(role);
      if (claimed !== undefined && claimed !== definition.id) {
        throw new Error(
          `Agent definitions "${claimed}" and "${definition.id}" both declare roles: [${role}] — ` +
            "which one answers would be decided by load order alone",
        );
      }
      byRole.set(role, definition.id);
    }
  }
  for (const role of ROUTABLE_ROLES) {
    if (!byRole.has(role)) {
      throw new Error(
        `No agent definition declares the "${role}" role, so a message from ` +
          `a ${role} would route to an agent this build does not serve`,
      );
    }
  }

  const roleFor = (phone: string): Role => roleForPhone(deps.db, phone);
  return {
    roleFor,
    routeWhatsApp(phone: string) {
      const role = roleFor(phone);
      // Non-null: every routable role was checked above, at construction.
      return { role, agentId: byRole.get(role)! };
    },
  };
}

/**
 * The agent a session written by a phone-keyed build belonged to.
 *
 * DELIBERATELY NOT A TABLE READ, and the ordering is why: this runs inside
 * `openDb` (data/db.ts migrateSessionsKey), while the schema is still being
 * created — before anything has seeded the assignments table and before the
 * router exists. A resolver that read the table would read an EMPTY one and
 * file the owner's in-progress listing under the customer agent.
 *
 * Reading the variable is also the correct answer rather than a fallback: those
 * rows were written by a build in which OWNER_PHONE_NUMBERS WAS the authority,
 * so it is what decided who they belonged to. And a database old enough to hold
 * them cannot hold an assignment the table would disagree with — every process
 * that can write one opens the database first, which is what re-keys the
 * sessions.
 *
 * A session migrated under an id the router never produces is a row nothing
 * reads: it survives, and the person's next message quietly starts from nothing.
 */
export function legacySessionAgentId(
  ownerPhoneNumbers: ReadonlySet<string>,
  phone: string,
): AgentId {
  return ownerPhoneNumbers.has(normalizePhone(phone)) ? AGENT_IDS.owner : AGENT_IDS.customer;
}

/**
 * The same resolver for an ops entry point, which refuses to guess.
 *
 * The server treats "no owners" as a valid deployment and keeps booting; a
 * command that is about to purge sessions or manage credentials cannot, because
 * the likeliest cause of an empty allowlist is a missing .env rather than an
 * intent (loadDotEnv swallows an absent file), and filing the owner's session
 * under the customer agent is silent and unrecoverable.
 *
 * It throws only when it is actually ASKED — that is, when the database really
 * does hold sessions keyed by phone alone. A tool run against an already
 * migrated database never reaches this, which is what lets a deployment whose
 * owners live only in the assignments table use these commands at all. The
 * rebuild runs in one transaction, so the throw rolls it back and leaves the
 * legacy table intact.
 */
export function refusingLegacyAgentIdFor(
  ownerPhoneNumbers: ReadonlySet<string>,
): (phone: string) => string {
  return (phone: string) => {
    if (ownerPhoneNumbers.size === 0) {
      throw new Error(
        "OWNER_PHONE_NUMBERS is empty and this database still keys sessions by phone alone — " +
          "refusing to migrate them, since every one of them (the owner's included) would be " +
          "filed under the customer agent. Set the allowlist and retry.",
      );
    }
    return legacySessionAgentId(ownerPhoneNumbers, phone);
  };
}
