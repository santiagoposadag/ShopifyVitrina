/**
 * Prose that names a tool the agent was not given.
 *
 * ONE RULE, TWO PLACES THAT MUST APPLY IT. The boot validator checks a
 * persona (agent/definition.ts) and the knowledge loader checks every document
 * it reads (knowledge/store.ts), because both kinds of prose reach the model
 * the same way — inline in the system prompt, or as a tool result — and an
 * instruction to call a tool that does not exist is the same hole either way.
 *
 * It lives at the root rather than inside either of them because both are real
 * callers: the validator does not import the knowledge loader, and the
 * knowledge loader had to import the validator to borrow this. A leaf with no
 * runtime imports of ours is what lets the two share the rule without either
 * one owning the other. The types below are `import type` only, so nothing of
 * this module survives into the emitted graph.
 */
import type { AgentDefinition, ToolUniverse } from "./agent/definition.js";

/**
 * A prompt "mentions" a tool when the tool's exact name appears as a whole
 * word. This catches the failure the plan calls out — a persona naming a
 * tool that was renamed or was never added to `tools[]` — without flagging
 * ordinary prose: an underscore-joined lowercase identifier does not occur by
 * accident in English or Spanish sentences. It CANNOT catch a misspelled tool
 * name ("adjust_inventroy") or a paraphrase ("the stock tool") — those read as
 * prose, not as the literal the schema can compare against.
 */
function mentionsTool(text: string, toolName: string): boolean {
  return new RegExp(`\\b${toolName}\\b`).test(text);
}

/**
 * Tool names a piece of prose mentions that this agent was NOT given.
 */
export function undeclaredToolMentions(
  text: string,
  definition: AgentDefinition,
  universe: ToolUniverse,
): string[] {
  // What this agent's model will actually see. Only the tools that EXIST are
  // mapped: an unknown key in tools[] is already its own error, and reporting
  // it twice buries the one line that names the typo.
  const declaredExposed = new Set(
    definition.tools
      .map((key) => universe.exposedNames.get(key))
      .filter((name): name is string => name !== undefined),
  );
  return [...new Set(universe.exposedNames.values())].filter(
    (exposed) => mentionsTool(text, exposed) && !declaredExposed.has(exposed),
  );
}
