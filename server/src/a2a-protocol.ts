/**
 * The agent-to-agent protocol: the rules more than one layer has to agree on.
 *
 * Two things live here, and neither belongs to the door that happens to
 * enforce it first. A conversation key's FORMAT is written by the agent door
 * and read by the purge tool; the hop cap is enforced at the door on the way
 * IN and by `ask_agent` on the way OUT. Both were declared inside `inbox/`,
 * which made a data module and a tool pack import the HTTP layer to learn a
 * constant — and `inbox/` is the one place neither of them should have to
 * know about.
 *
 * A LEAF, and it must stay one: nothing here imports anything of ours. That is
 * what lets the ops tool, the tool pack and the door all name the same rule
 * without any of them reaching through another feature to get at it.
 *
 * WHAT IS NOT HERE: anything that needs the database, the registry, or a
 * request. Admission — whether this caller may reach that agent, whether a
 * second exchange is already in flight — is enforcement, and it stays in
 * `inbox/a2a.ts` with the rows it reads.
 */

/**
 * The namespace every agent-door conversation key carries.
 *
 * NOT decoration. The conversation key is what `claimInboxBatch` claims by and
 * what `sessions` is keyed on, and the correlation id inside it is chosen by
 * the CALLER — so without a namespace an agent could pass "573001112233" and
 * claim, answer and settle that person's pending WhatsApp messages, receiving
 * their words in its own response body. The prefix is added by us, and a
 * caller cannot remove it; a phone can never collide with it because
 * normalizePhone leaves nothing but digits.
 *
 * It is also the marker the purge tool reads: an agent-to-agent exchange is not
 * a customer's history, and `isOwner` would judge it as one (data/purge.ts).
 */
export const AGENT_CONVERSATION_PREFIX = "a2a:";

/**
 * The conversation key for one agent-to-agent exchange.
 *
 * BOTH ENDS PLUS THE CORRELATION. The caller is in it because two agents that
 * happen to choose the same correlation id must hold two conversations rather
 * than one shared transcript. The TARGET is in it because a batch is claimed by
 * conversation key and answered by ONE agent: a caller that asked two agents
 * under one correlation id would otherwise have both questions claimed together
 * and answered by whichever agent the first row named.
 */
export function agentConversationKey(
  callerAgentId: string,
  targetAgentId: string,
  correlationId: string,
): string {
  return `${AGENT_CONVERSATION_PREFIX}${callerAgentId}:${targetAgentId}:${correlationId}`;
}

/** Whether this conversation key was minted by the agent door. */
export function isAgentConversationKey(conversationKey: string): boolean {
  return conversationKey.startsWith(AGENT_CONVERSATION_PREFIX);
}

/**
 * How many agent-to-agent hops a message may have taken before it reaches an
 * agent. Three (§2.6): a super-agent asking an agent that asks the super-agent
 * back is otherwise an unbounded bill and not an error anybody sees.
 *
 * The hop of an OUTBOUND call is derived by `ask_agent` from the hop of the
 * turn that issued it, so within this process the counter cannot be reset by
 * anything the model writes. Across the network it is what every hop counter
 * is — a TTL a peer declares — and this cap is what bounds a chain of honest
 * peers. A caller that lies about its hop is a caller whose credential is the
 * thing to revoke; it could equally send the same message in a loop.
 *
 * READ AT BOTH ENDS, which is why it is here rather than at either of them:
 * `inbox/a2a.ts` refuses an inbound message above the cap, and the `ask_agent`
 * tool refuses to make an outbound call that would exceed it. A cap one end
 * knew and the other did not is a chain that is only bounded in one direction.
 */
export const MAX_HOP = 3;
