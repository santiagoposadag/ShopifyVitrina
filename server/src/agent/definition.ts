import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Role } from "../types.js";

/**
 * `PromptSpec.base` names a preset the RUNTIME owns (see agent/prompt.ts),
 * not a path into the definition directory — the grounding preamble is a
 * property of this deployment, not of one business, so no per-agent file
 * exists for it to point at.
 */
const PROMPT_BASES = ["grounding", "none"] as const;

const RoleSchema = z.enum(["owner", "customer"]);

/** `runtime.ts` passes `maxTurns` straight through to the SDK's own option. */
const ModelKnobsSchema = z
  .object({
    maxTurns: z.number().int().positive(),
  })
  .strict();

const PromptSpecSchema = z
  .object({
    base: z.enum(PROMPT_BASES),
    /** Relative to the definition's own directory, e.g. "prompt.md". */
    persona: z.string().min(1),
    /** No definition sets one yet; `slots` is rendered by prompt.ts regardless. */
    slots: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * The two knowledge tiers. Paths are relative to the agent's own directory and
 * must resolve under its `knowledge/` folder — knowledge/store.ts reads them at
 * boot and enforces both the containment and the budget.
 *
 * `maxInlineTokens` is a budget over the INLINE documents only, measured with
 * the deliberate over-estimate in store.ts. It does not cover the runtime's own
 * few lines of framing around them, which are the same for every agent and are
 * not something a definition can change.
 */
const KnowledgeSpecSchema = z
  .object({
    inline: z.array(z.string()),
    searchable: z.array(z.string()),
    maxInlineTokens: z.number().int().nonnegative(),
  })
  .strict();

const SessionPolicySchema = z
  .object({
    /**
     * Optional, and deliberately unset in both shipped definitions. Wiring
     * the shipped default (matching SESSION_MAX_AGE_DAYS's own default) would
     * make the YAML outrank the environment variable: a deployment that has
     * actually SET that variable to something else would have its window
     * silently shortened or lengthened by a data file nobody told it to read.
     * `runtime.ts` reads `session.maxAgeDays ?? config.sessionMaxAgeDays`, so
     * a definition that DOES need its own window can declare one without
     * every other agent inheriting a value config no longer controls.
     */
    maxAgeDays: z.number().int().positive().optional(),
    /**
     * Tool names that MAY trigger a session reset — NOT a literal "this tool
     * call resets the session" mapping. Today's actual condition is a STATE
     * TRANSITION a tool evaluates for itself (`isPublishTransition` in
     * tools/packs/catalog.ts: a product becomes ACTIVE and was not before) and signals
     * through `ctx.sessionAfterTurn = "reset"`; `update_product` appears here
     * because it CAN cause that transition, not because every call to it
     * resets anything. A future implementation that reads this field at
     * tool-name granularity — "reset whenever one of these tools is called" —
     * would reset the owner's session on an ordinary price edit, which is
     * exactly the mid-listing data loss the transition check exists to avoid.
     * Validated against `tools[]` below; not yet read by the runtime.
     */
    resetOn: z.array(z.string()),
    keyedBy: z.enum(["principal", "correlation"]),
  })
  .strict();

const AgentDefinitionFileSchema = z
  .object({
    id: z.string().min(1),
    roles: z.array(RoleSchema).min(1),
    model: ModelKnobsSchema,
    tools: z.array(z.string()),
    prompt: PromptSpecSchema,
    knowledge: KnowledgeSpecSchema,
    session: SessionPolicySchema,
    /** Agent ids this one may call via ask_agent. Empty until Phase 5 exists. */
    reach: z.array(z.string()),
  })
  .strict();

export type ModelKnobs = z.infer<typeof ModelKnobsSchema>;
export type PromptSpec = z.infer<typeof PromptSpecSchema>;
export type KnowledgeSpec = z.infer<typeof KnowledgeSpecSchema>;
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;

/**
 * One agent, as data. Mirrors §2.2's class diagram in
 * docs/agent-platform-decoupling.md, plus `personaText` — the persona file's
 * content, read at load time so validation and prompt composition never touch
 * the filesystem again.
 */
export interface AgentDefinition {
  id: string;
  roles: Role[];
  model: ModelKnobs;
  tools: string[];
  prompt: PromptSpec;
  knowledge: KnowledgeSpec;
  session: SessionPolicy;
  reach: string[];
  personaText: string;
}

/**
 * What this BUILD can serve, independent of any one definition — the shape
 * `tools/registry.ts` produces and `validateDefinition` checks `tools[]`,
 * `session.resetOn` and the persona's prose against.
 *
 * TWO sets, and they are not interchangeable. `keys` is what a definition may
 * NAME; `exposedNames` is what the MODEL sees, and the two differ wherever one
 * exposed name has more than one implementation behind it (`get_product`:
 * ACTIVE-only for the customer, any status for the owner). A persona writes
 * prose for the model, so its mentions are checked against exposed names —
 * checking them against keys would reject the owner persona for saying
 * `get_product` while correctly declaring `get_product_any_status`.
 *
 * Structural rather than the registry type itself: this module must stay
 * loadable, and testable, without importing the tool layer it validates.
 */
export interface ToolUniverse {
  keys: ReadonlySet<string>;
  /** Registry key → the name the model is given for it. */
  exposedNames: ReadonlyMap<string, string>;
}

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
 * The registry key of the knowledge search tool.
 *
 * Declared HERE, not in the registry, because this module must stay loadable
 * without importing the tool layer it validates — and the pairing rule below
 * ("searchable knowledge and this tool imply each other") needs the name. The
 * registry imports this constant, so there is still exactly one spelling of it.
 */
export const SEARCH_KNOWLEDGE_TOOL = "search_knowledge";

/**
 * Tool names a piece of prose mentions that this agent was NOT given.
 *
 * Shared by the persona check below and by the knowledge loader, because a
 * knowledge document reaches the model exactly as the prompt does — inline in
 * the system prompt, or as a tool result — and an instruction to call a tool
 * the agent does not have is the same hole either way.
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

/**
 * Load one definition from `<agentsDir>/<id>/`. Throws with the offending
 * path on a missing file, malformed YAML, an unknown key, or a wrong type —
 * every one of those must fail BOOT, not the first turn that reaches this
 * agent.
 */
export function loadDefinition(agentsDir: string, id: string): AgentDefinition {
  const dir = join(agentsDir, id);
  const yamlPath = join(dir, "agent.yaml");

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(yamlPath, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent definition "${id}": could not read or parse ${yamlPath}: ${detail}`);
  }

  const parsed = AgentDefinitionFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Agent definition "${id}" (${yamlPath}) is invalid: ${parsed.error.message}`);
  }
  if (parsed.data.id !== id) {
    // The directory name is what the router and the sessions table key on; a
    // mismatched `id` field would load correctly and then answer under a name
    // nothing in the pipeline ever looks up.
    throw new Error(
      `Agent definition at ${yamlPath} declares id "${parsed.data.id}", expected "${id}" (its directory name)`,
    );
  }

  const personaPath = join(dir, parsed.data.prompt.persona);
  let personaText: string;
  try {
    personaText = readFileSync(personaPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent definition "${id}": could not read persona file ${personaPath}: ${detail}`);
  }

  return { ...parsed.data, personaText };
}

/**
 * The boot validator. Everything it rejects would otherwise surface as an
 * agent that asks for a tool it does not have, or one that resets a session on
 * a tool call it can never make.
 */
export function validateDefinition(definition: AgentDefinition, universe: ToolUniverse): void {
  const errors: string[] = [];
  const declaredTools = new Set(definition.tools);

  for (const toolName of definition.tools) {
    if (!universe.keys.has(toolName)) {
      errors.push(`tools[] names "${toolName}", which is not a tool this build serves`);
    }
  }

  const seenExposed = new Set<string>();
  for (const key of definition.tools) {
    const exposed = universe.exposedNames.get(key);
    if (exposed === undefined) continue;
    if (seenExposed.has(exposed)) {
      // Two tools of one name on one MCP server is a coin flip over which one
      // the model reaches, decided by nothing a reader of the YAML can see.
      errors.push(`tools[] declares two tools exposed to the model as "${exposed}"`);
    }
    seenExposed.add(exposed);
  }

  for (const exposed of undeclaredToolMentions(definition.personaText, definition, universe)) {
    errors.push(`prompt.md mentions "${exposed}", which is not in tools[]`);
  }

  // The two tiers and the tool imply each other, in BOTH directions, and each
  // direction is its own silent failure. Searchable documents with no
  // search_knowledge are knowledge indexed at boot that no turn can ever reach.
  // search_knowledge with nothing searchable is a tool the prompt will offer
  // and that always answers "nothing found" — which reads to the model as the
  // business having no policy, rather than as a definition that forgot a file.
  //
  // The DOCUMENTS are checked by knowledge/store.ts, which can read the disk;
  // what is checkable here is the pairing, and it is checked here so a
  // definition built in memory (a test, a future loader) cannot skip it.
  const searchesKnowledge = definition.tools.includes(SEARCH_KNOWLEDGE_TOOL);
  if (definition.knowledge.searchable.length > 0 && !searchesKnowledge) {
    errors.push(
      `knowledge.searchable declares ${definition.knowledge.searchable.length} document(s) ` +
        `but tools[] does not include "${SEARCH_KNOWLEDGE_TOOL}", so nothing can read them`,
    );
  }
  if (searchesKnowledge && definition.knowledge.searchable.length === 0) {
    errors.push(
      `tools[] includes "${SEARCH_KNOWLEDGE_TOOL}" but knowledge.searchable is empty, ` +
        `so the tool can only ever answer that it found nothing`,
    );
  }

  for (const toolName of definition.session.resetOn) {
    if (!universe.keys.has(toolName)) {
      errors.push(`session.resetOn names "${toolName}", which is not a tool this build serves`);
    } else if (!declaredTools.has(toolName)) {
      errors.push(`session.resetOn names "${toolName}", which this agent does not have in tools[]`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Agent definition "${definition.id}" failed validation:\n- ${errors.join("\n- ")}`);
  }
}

/** Load and validate every id, or throw before returning any of them. */
export function loadAndValidateDefinitions(
  agentsDir: string,
  ids: readonly string[],
  universe: ToolUniverse,
): Map<string, AgentDefinition> {
  const definitions = new Map<string, AgentDefinition>();
  for (const id of ids) {
    const definition = loadDefinition(agentsDir, id);
    validateDefinition(definition, universe);
    definitions.set(id, definition);
  }
  return definitions;
}
