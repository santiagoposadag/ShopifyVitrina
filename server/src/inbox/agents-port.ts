import type { DB } from "../data/db.js";
import type { AgentReplies } from "../egress/agent-reply.js";
import type { AgentsPort, AskAgentResult } from "../tools/ports.js";
import { admitExchange, runSyncExchange } from "./a2a.js";
import type { InboxBatcher } from "./batcher.js";

/**
 * `ask_agent`, performed IN PROCESS.
 *
 * The same admission checks and the same durable inbox as the HTTP door,
 * because they are literally the same functions: §4 rules out splitting this
 * build into separate processes, and this adapter is the seam that would become
 * an HTTP call if that ever changed — not a second implementation of the rules,
 * which is how two doors end up disagreeing about who may call whom.
 *
 * WHAT DIFFERS FROM THE HTTP DOOR IS THE AUTHORITY FOR `reach`. Over the wire
 * it is the registry: the operator's permission for a credential, checked
 * against a bearer token, because the caller is a stranger until it proves
 * otherwise. In process there is no token and the caller's identity is not in
 * question — the runtime built the turn — so the authority is the DEFINITION's
 * own `reach` list, which is versioned in agent.yaml, reviewed like code, and
 * validated at boot.
 *
 * The dependencies arrive as THUNKS because the composition root builds the
 * ports before the batcher that performs the work. Called only from inside
 * `ask`, they are resolved when a turn actually asks, which is long after
 * everything exists.
 */
export interface InProcessAgentsDeps {
  db: DB;
  batcher: () => InboxBatcher;
  replies: () => AgentReplies;
  /** What each agent's definition declares it may ask. */
  reachOf: (agentId: string) => readonly string[];
  /** Whether this build loaded that agent at all. */
  isKnownAgent: (agentId: string) => boolean;
}

export function inProcessAgentsPort(deps: InProcessAgentsDeps): AgentsPort {
  return {
    reachOf: deps.reachOf,
    async ask(request): Promise<AskAgentResult> {
      // Enforced HERE as well as in the pack. The pack's copy is what gives the
      // model a sentence it can act on; this one is what makes the rule
      // structural — a second tool, or a future caller of this port, finds the
      // same door rather than an unguarded shortcut.
      const refusal = admitExchange({
        callerAgentId: request.from,
        targetAgentId: request.to,
        hop: request.hop,
        reach: deps.reachOf(request.from),
        isKnownAgent: deps.isKnownAgent,
      });
      if (refusal) return { ok: false, reason: refusal.error };

      const result = await runSyncExchange(
        { db: deps.db, batcher: deps.batcher(), replies: deps.replies() },
        {
          callerAgentId: request.from,
          targetAgentId: request.to,
          text: request.text,
          hop: request.hop,
          correlationId: request.correlationId,
        },
      );
      return result.ok ? { ok: true, reply: result.reply } : { ok: false, reason: result.reason };
    },
  };
}
