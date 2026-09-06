import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { DB } from "../data/db.js";
import { clearSessionId, getSessionId, setSessionId } from "../data/repo.js";
import { buildToolServer, MCP_SERVER_NAME } from "../tools/registry.js";
import type { ToolPorts } from "../tools/ports.js";
import type { AgentDefinition } from "./definition.js";
import { composePrompt } from "./prompt.js";
import type { TurnContext } from "../types.js";

/**
 * What the person gets when a turn ends without words.
 *
 * The usual cause is the turn cap: the agent kept calling tools and never
 * arrived at an answer. Saying so plainly beats both silence and a fake
 * apology for an error that did not happen — and asking for a narrower request
 * is the one thing that actually changes the outcome on a retry.
 */
export const NO_ANSWER_FALLBACK =
  "Disculpa, me enredé buscando eso y no alcancé a terminar. ¿Puedes pedírmelo de nuevo, un poco más específico?";

/**
 * What one turn needs. NO TRANSPORT: the turn returns its reply and the caller
 * delivers it (see egress/responder.ts). A channel here is what made the reply
 * address a property of the agent loop, so the only person it could ever answer
 * was a WhatsApp phone.
 */
export interface AgentDeps {
  db: DB;
  config: Config;
  /**
   * What the tools may reach: the catalog, the leads store, the inbound photos.
   * Built once at the composition root, because the catalog adapter carries the
   * shared cache whose whole value is that a burst of messages from one owner,
   * and two customers asking at the same time, do not each pay for a full
   * catalog fetch.
   *
   * The runtime never calls a port itself. It holds them only to hand them to
   * the tool server, which is what keeps the loop indifferent to the domain it
   * is answering about.
   */
  ports: ToolPorts;
  /**
   * Every agent this runtime can serve, keyed by `agentId` — loaded and
   * validated once at boot (see index.ts and agent/definition.ts), so a broken
   * prompt or a tool typo fails startup rather than the first turn that reaches
   * it. Composing the prompt is `runQuery`'s job, not the composition root's:
   * a fresh render per turn is what lets `prompt.slots` change without a
   * restart, once something sets one.
   */
  definitions: Record<string, AgentDefinition>;
  /**
   * Only the levels this module uses: per-turn usage and each tool call (info),
   * a session fallback and a denied tool (warn), and a turn that ended with no
   * reply at all (error — the person got a fallback instead of an answer).
   */
  log: Pick<FastifyBaseLogger, "warn" | "info" | "error">;
}

/**
 * The environment the Agent SDK's subprocess runs with.
 *
 * The SDK spawns the bundled Claude Code CLI, which reads its endpoint,
 * credential and model tiers from environment variables — so swapping providers
 * needs no abstraction layer, only the right variables. We pass them explicitly
 * instead of relying on the ambient process environment for two reasons: config
 * stays the single source of truth (a stray shell variable cannot outvote it),
 * and the mapping becomes a pure function a test can assert on directly.
 *
 * The `...process.env` spread is NOT optional. The SDK's `env` option REPLACES
 * the environment rather than merging into it, so omitting the spread strips
 * PATH and the subprocess never starts.
 *
 * Exported for tests.
 */
export function buildAgentEnv(config: Config): Record<string, string | undefined> {
  // Both keys are always written, one of them to undefined, because the
  // process.env spread below would otherwise leave a leftover credential from
  // the shell sitting next to the configured one — and the CLI would pick
  // whichever it resolves first. A coin-flip between providers is not a
  // deployment. `delete` rather than `undefined`: unset must mean unset.
  const credential = config.agentAuthToken
    ? { ANTHROPIC_AUTH_TOKEN: config.agentAuthToken, ANTHROPIC_API_KEY: undefined }
    : { ANTHROPIC_API_KEY: config.anthropicApiKey, ANTHROPIC_AUTH_TOKEN: undefined };

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: config.agentBaseUrl,
    ...credential,
    ANTHROPIC_MODEL: config.model,
    // All three, deliberately. The CLI resolves the utility tier through
    // different code paths depending on the call, and an unset one keeps asking
    // for the compiled-in Haiku default — which an Anthropic-compatible endpoint
    // may serve with a silent substitution rather than an error, hiding the
    // mistake behind a working reply from a model we did not choose.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.smallFastModel,
    ANTHROPIC_SMALL_FAST_MODEL: config.smallFastModel,
    CLAUDE_CODE_SUBAGENT_MODEL: config.smallFastModel,
    // Written unconditionally, to undefined when unset, for the same reason the
    // credential pair above is: a conditional spread leaves whatever the shell
    // (or Coolify) already had sitting in the environment, and the CLI reads
    // that — so a deployment whose config says thinking is OFF would quietly
    // run and bill for it because a stray variable outvoted the config.
    MAX_THINKING_TOKENS:
      config.maxThinkingTokens > 0 ? String(config.maxThinkingTokens) : undefined,
    CLAUDE_CODE_EXTRA_BODY:
      Object.keys(config.agentExtraBody).length > 0
        ? JSON.stringify(config.agentExtraBody)
        : undefined,
  };

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

interface AssistantBlock {
  type?: string;
  text?: string;
}
/** The SDK's per-model usage record, in the fields we actually report on. */
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: { content?: AssistantBlock[] };
  /** Keyed by the model that actually answered — see TurnStats.servedModel. */
  modelUsage?: Record<string, ModelUsage>;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
}

function isRecord(v: unknown): v is StreamMessage {
  return typeof v === "object" && v !== null;
}

/**
 * What one turn cost and who served it. Collected from the SDK's terminal
 * `result` message, which carries the only trustworthy record of what actually
 * happened — the request we sent is not evidence, because an
 * Anthropic-compatible endpoint may ignore or substitute what it will not honour
 * and still answer 200.
 */
export interface TurnStats {
  /**
   * The model that answered, read from the keys of `modelUsage`. Asserted
   * against the configured model rather than assumed: DeepSeek resolves an
   * unrecognised model id to its own default SILENTLY, so a typo produces a
   * perfectly good reply from the wrong model.
   */
  servedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * The SDK's own cost estimate, from a compiled-in ANTHROPIC price table. It
   * is wrong for any other provider — hence the name. Real per-provider cost is
   * computed in the comparison harness from token counts.
   */
  estimatedCostUsdAnthropicTable?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  /**
   * How the turn ENDED, straight from the SDK's terminal message: "success",
   * or an error subtype such as the turn cap being exhausted.
   *
   * Recorded because only "success" carries a final answer. Without it, a turn
   * that burned twelve tool calls and produced no reply is indistinguishable in
   * the log from one that answered — same duration, same token counts, and the
   * line still reads "agent turn complete".
   */
  resultSubtype?: string;
  /** Tools the turn actually invoked, in order. Empty means it answered from the prompt. */
  tools?: string;
}

interface TurnResult {
  reply: string;
  sessionId?: string;
  stats: TurnStats;
}

/** Pull the usage record out of a terminal `result` message. */
function readStats(raw: StreamMessage): TurnStats {
  // One entry in practice; if a turn ever spans models, the joined key makes
  // that visible instead of quietly reporting whichever came first.
  const servedModel = raw.modelUsage ? Object.keys(raw.modelUsage).join(",") : undefined;
  const usage = Object.values(raw.modelUsage ?? {}).reduce<ModelUsage>(
    (acc, u) => ({
      inputTokens: (acc.inputTokens ?? 0) + (u.inputTokens ?? 0),
      outputTokens: (acc.outputTokens ?? 0) + (u.outputTokens ?? 0),
      cacheReadInputTokens: (acc.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens:
        (acc.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
    }),
    {},
  );

  return {
    servedModel: servedModel || undefined,
    ...usage,
    estimatedCostUsdAnthropicTable: raw.total_cost_usd,
    durationMs: raw.duration_ms,
    durationApiMs: raw.duration_api_ms,
    numTurns: raw.num_turns,
  };
}

/**
 * One pass through the Agent SDK. Collects the reply and the session id but
 * writes nothing: the caller decides what to persist, because a failed attempt
 * must leave the stored session untouched for the fallback to reason about.
 */
async function runQuery(
  deps: AgentDeps,
  ctx: TurnContext,
  definition: AgentDefinition,
  incomingText: string,
  resumeId: string | undefined,
): Promise<TurnResult> {
  const { config, ports, log } = deps;
  // Exactly `definition.tools[]`, in the order the definition lists them. The
  // role on the context selects nothing here any more.
  const { server, toolNames } = buildToolServer({ definition, ctx, ports });
  // Names in call order. The turn summary reports them, because "it took 52
  // seconds" is not actionable and "it called search_catalog nine times" is.
  const toolsUsed: string[] = [];

  let capturedSessionId: string | undefined;
  let resultText = "";
  let stats: TurnStats = {};
  const assistantText: string[] = [];

  const response = query({
    prompt: incomingText,
    options: {
      model: config.model,
      env: buildAgentEnv(config),
      ...(config.maxThinkingTokens > 0 ? { maxThinkingTokens: config.maxThinkingTokens } : {}),
      systemPrompt: composePrompt(definition),
      mcpServers: { [MCP_SERVER_NAME]: server },
      // REMOVE every built-in tool from the model's context. This is the option
      // that actually restricts what exists; allowedTools only auto-approves,
      // and the SDK says so: "To restrict which tools are available, use the
      // `tools` option instead."
      //
      // Denying a built-in at execution time is far too late. The model still
      // SEES Bash, Read and Edit, picks one, and burns a whole turn discovering
      // it is refused — then picks it again. Observed against a real store:
      // twelve turns, every one of them a denied Bash call, no answer produced,
      // and 52 seconds of the owner's time spent on it.
      tools: [],
      // Our own tools still need auto-approval, or each one would wait on a
      // permission prompt that nothing in this process can answer.
      allowedTools: toolNames,
      // Defence in depth, and the only place every call is logged. Nothing
      // should reach the deny branch now — if something does, that is worth
      // seeing.
      // Reached ONLY by a tool that needs a permission decision. Our own tools
      // are in allowedTools, so they are auto-approved and never arrive here —
      // which is why the tool log is taken from the assistant stream above and
      // not from this hook.
      canUseTool: async (toolName, input) => {
        if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) {
          return { behavior: "allow", updatedInput: input };
        }
        // Was silent, and a denial is exactly what someone debugging an agent
        // that "did nothing" needs to see.
        log.warn({ phone: ctx.phone, tool: toolName }, "denied a tool outside this assistant's set");
        return { behavior: "deny", message: "This tool is not available to this assistant." };
      },
      // Was a bare literal before agent.yaml existed; both shipped definitions
      // still say 12, so there is no behaviour change — the point is that
      // there is now exactly one copy of the number, not two that can drift.
      maxTurns: definition.model.maxTurns,
      ...(resumeId ? { resume: resumeId } : {}),
    },
  });

  for await (const raw of response) {
    if (!isRecord(raw)) continue;
    if (typeof raw.session_id === "string") capturedSessionId = raw.session_id;
    if (raw.type === "assistant" && raw.message?.content) {
      for (const block of raw.message.content) {
        if (block.type === "text" && typeof block.text === "string") assistantText.push(block.text);
        // The AUTHORITATIVE record of what the model called.
        //
        // NOT canUseTool: that hook only fires for a tool that needs a
        // permission DECISION, and allowedTools auto-approves ours — so it
        // never sees them. Counting there reported `tools: (none)` for turns
        // that had just searched the catalog, which reads as an agent
        // inventing product facts rather than a broken counter.
        if (block.type === "tool_use" && typeof block.name === "string") {
          const short = block.name.startsWith(`mcp__${MCP_SERVER_NAME}__`)
            ? block.name.slice(`mcp__${MCP_SERVER_NAME}__`.length)
            : block.name;
          toolsUsed.push(short);
          log.info(
            { phone: ctx.phone, tool: short, input: compactInput(block.input) },
            `tool ${toolsUsed.length}: ${short}`,
          );
        }
      }
    }
    if (raw.type === "result") {
      // Read on EVERY result subtype, not just success: a turn that hit the
      // turn cap or errored mid-execution still burned tokens and still tells
      // us which endpoint served it.
      stats = readStats(raw);
      if (typeof raw.subtype === "string") stats.resultSubtype = raw.subtype;
      if (raw.subtype === "success" && typeof raw.result === "string") {
        resultText = raw.result;
      }
    }
  }

  return {
    reply: (resultText || assistantText.join("\n")).trim(),
    sessionId: capturedSessionId,
    stats: { ...stats, tools: toolsUsed.join(",") },
  };
}

/**
 * A tool's arguments, short enough to sit on a log line.
 *
 * The values here are product names, SKUs, prices and counts — nothing private
 * — but a create_product payload is long enough to bury every other line.
 */
function compactInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    return "(unserialisable)";
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Host of the configured endpoint, for logs. Never the credential. */
function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * One structured line per turn: which endpoint and model served it, what it
 * cost in tokens, how long it took, and whether thinking was on.
 *
 * `utcHour` is recorded because DeepSeek is reported to be moving to peak /
 * off-peak pricing on UTC windows. That schedule is NOT on their official rate
 * card and we could not confirm it, so this deliberately captures the data to
 * correlate spend against later — and builds no scheduling on an unconfirmed
 * claim.
 */
function logTurn(
  log: Pick<FastifyBaseLogger, "info">,
  config: Config,
  ctx: TurnContext,
  stats: TurnStats,
  startedAt: Date,
): void {
  log.info(
    {
      phone: ctx.phone,
      role: ctx.role,
      // Which assistant answered. Two of them share this log, and "the owner's
      // turn resumed nothing" is otherwise indistinguishable from a session
      // filed under the other agent's id.
      agentId: ctx.agentId,
      endpointHost: endpointHost(config.agentBaseUrl),
      configuredModel: config.model,
      smallFastModel: config.smallFastModel,
      // Compare these two: a mismatch means the endpoint substituted a model.
      servedModel: stats.servedModel,
      maxThinkingTokens: config.maxThinkingTokens,
      extraBody: config.agentExtraBody,
      startedAt: startedAt.toISOString(),
      utcHour: startedAt.getUTCHours(),
      ...stats,
    },
    "agent turn complete",
  );
}

/**
 * Run one agent turn for an inbound message and RETURN the reply. Sending it is
 * the caller's job — a turn does not know who is asking, only what to answer.
 * Resumes the (agentId, conversationKey) session when one exists and persists
 * the new session id.
 *
 * FALLBACK: the session id lives in SQLite (on a volume, survives a redeploy)
 * but the SDK's transcript lives under its home directory, so a container whose
 * home is ephemeral resumes an id whose transcript no longer exists — the
 * subprocess exits 1 and every conversation breaks after a deploy. When a
 * resume was in play we retry ONCE with a fresh session, so the customer still
 * gets an answer (losing the conversation history, not the reply).
 *
 * The retry is deliberately gated on resumeId rather than on the error text:
 * the SDK reports every failure as a generic "exited with code 1", so matching
 * the message buys no precision but would silently stop working if the wording
 * changed. Without a resume there is nothing stale to recover from — the
 * failure is real (API down, bad key) and must surface rather than cost a
 * second turn on every request of an outage.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  ctx: TurnContext,
  incomingText: string,
): Promise<string> {
  const { db, config, definitions, log } = deps;
  const definition = definitions[ctx.agentId];
  if (!definition) {
    // Would mean a definition failed to load at boot and the process kept
    // running anyway, or the router produced an agentId nothing declared. Both
    // are configuration bugs; surfacing here beats sending a person a reply
    // composed from nothing.
    throw new Error(`No agent definition loaded for agentId "${ctx.agentId}"`);
  }
  // The definition's own value wins when it declares one; otherwise this
  // agent falls back to the deployment-wide knob. Neither shipped definition
  // sets one TODAY, on purpose — see session.maxAgeDays' comment in
  // definition.ts for why hard-coding the current default would be a
  // behaviour change disguised as a data move.
  const sessionMaxAgeDays = definition.session.maxAgeDays ?? config.sessionMaxAgeDays;
  const resumeId = getSessionId(db, ctx.agentId, ctx.conversationKey, sessionMaxAgeDays);
  const startedAt = new Date();

  let result: TurnResult;
  try {
    result = await runQuery(deps, ctx, definition, incomingText, resumeId);
  } catch (err) {
    if (!resumeId) throw err;
    // Drop the id BEFORE retrying: if the retry also fails, a replayed inbox
    // row must not resume the same dead session all over again.
    clearSessionId(db, ctx.agentId, ctx.conversationKey);
    log.warn(
      { err, phone: ctx.phone, sessionId: resumeId },
      "agent session could not be resumed; starting a fresh session",
    );
    result = await runQuery(deps, ctx, definition, incomingText, undefined);
  }

  logTurn(log, config, ctx, result.stats, startedAt);

  // A publish ends the unit of work: drop the session instead of persisting
  // the new id, so the next owner message starts clean — history stays lean
  // and one product's details cannot bleed into the next one. The flag is not
  // reset between the resume-failure attempts above: if attempt 1 published
  // and then died, the publish still happened and the reset must stick.
  if (ctx.sessionAfterTurn === "reset") {
    clearSessionId(db, ctx.agentId, ctx.conversationKey);
  } else if (result.sessionId) {
    setSessionId(db, ctx.agentId, ctx.conversationKey, result.sessionId);
  }
  // A turn that produced no words STILL owes the person an answer.
  //
  // Only the "success" subtype carries a final reply, so a turn that exhausts
  // maxTurns — twelve tool calls, a minute of latency, thousands of tokens —
  // arrives here with an empty string. Returning it settles the inbox batch as
  // done and leaves the person waiting forever for a message that no longer
  // exists anywhere: the same silence AUDIO_FALLBACK exists to prevent on the
  // voice-note path, reached from the other end.
  //
  // The substitution happens HERE rather than in the caller because a caller
  // that has to remember it is a caller that will not: the runtime is what
  // knows the turn came back empty, and every door has the same debt to the
  // person waiting.
  //
  // Observed in the field: numTurns=12, 9253 output tokens, 52 seconds, and not
  // one byte delivered.
  const reply = result.reply.length > 0 ? result.reply : NO_ANSWER_FALLBACK;
  if (result.reply.length === 0) {
    log.error(
      {
        phone: ctx.phone,
        role: ctx.role,
        agentId: ctx.agentId,
        subtype: result.stats.resultSubtype,
        tools: result.stats.tools,
      },
      "agent turn produced NO reply; answering with the fallback instead of silence",
    );
  }
  return reply;
}
