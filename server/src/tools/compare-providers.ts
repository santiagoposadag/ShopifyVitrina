/**
 * Runs the same task set through the currently configured provider and reports
 * quality, tool-call success, latency and token usage.
 *
 *   ./scripts/with-secrets.sh --profile anthropic npm run compare -w server
 *   ./scripts/with-secrets.sh --profile deepseek  npm run compare -w server
 *
 * One profile per invocation, on purpose: switching providers mid-process means
 * mutating the environment the SDK's subprocess inherits, and a half-applied
 * switch would silently attribute one provider's results to the other. Each run
 * writes a JSON file; pass the two files back in to diff them:
 *
 *   npm run compare -w server -- --diff out/anthropic.json out/deepseek.json
 *
 * THE METRIC IS COST PER SUCCESSFUL TASK, not cost per token. A model half the
 * price that fails a third of the time is more expensive, and the failures are
 * wrong prices on a public storefront rather than a line on an invoice.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runAgentTurn } from "../agent/agent.js";
import { resolveDataPath, type Config } from "../config.js";
import { loadOfflineConfig } from "./offline-config.js";
import { openDb, type DB } from "../data/db.js";
import type { TurnContext } from "../types.js";
import type { WhatsAppChannel } from "../whatsapp/channel.js";
import { TASKS, type CompareTask } from "./tasks.js";

const OWNER = "573001112233";
const CUSTOMER = "573009998877";

/**
 * Per-million-token rates, in USD.
 *
 * ⚠️ EVERY COST HERE IS A LOWER BOUND, and by an amount that differs per
 * provider. Measured against real dashboards on 2026-07-25, same 87-task run:
 *
 *     Anthropic  dashboard $1.99   this model $1.26   (63% — off by $0.73)
 *     DeepSeek   dashboard $0.61   this model $0.54   (89% — off by $0.07)
 *
 * The cause is the SDK's usage reporting, not these rates. `modelUsage`
 * surfaced 101,752 cache-WRITE tokens for that run, while the missing $0.73
 * corresponds to roughly 690k of them at $1.25/MTok — about what 87 fresh
 * sessions each writing an ~8KB system prompt would produce. Cache writes the
 * SDK does not report, we cannot bill for. (The SDK's own `total_cost_usd`
 * came back zero throughout, so it offers no cross-check either.)
 *
 * The asymmetry is what matters: a provider whose spend is concentrated in
 * cache OPERATIONS is under-measured far more than one whose spend is
 * concentrated in fresh input tokens. So this model systematically FLATTERS
 * cache-heavy providers, and a ratio computed from it understates their real
 * cost. Use it to itemise and to compare tasks against each other; use the
 * provider dashboards to decide.
 *
 * Peak/off-peak pricing is REPORTED for DeepSeek but absent from their official
 * rate card, so nothing here models it; the per-turn log records utcHour so
 * real spend can be correlated later.
 */
interface Rate {
  inputMiss: number;
  inputHit: number;
  /** Cache WRITE. Priced above inputMiss wherever a provider bills it separately. */
  cacheWrite: number;
  output: number;
}

const RATES_PER_MTOK: Record<string, Rate> = {
  // Anthropic, from the official docs pricing table (verified 2026-07-25).
  // Cache read is 0.1x base input and a 5-minute cache WRITE is 1.25x — which
  // is why cacheWrite is priced above inputMiss and must not be folded into it.
  "claude-haiku-4-5": { inputMiss: 1.0, inputHit: 0.1, cacheWrite: 1.25, output: 5.0 },
  // DeepSeek V4, published rates 2026-07. Their prefix caching is automatic
  // with no explicit write step to bill, so cacheWrite matches inputMiss.
  "deepseek-v4-flash": { inputMiss: 0.14, inputHit: 0.0028, cacheWrite: 0.14, output: 0.28 },
  "deepseek-v4-pro": { inputMiss: 0.435, inputHit: 0.003625, cacheWrite: 0.435, output: 0.87 },
};

interface TurnStatsRecord {
  servedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  estimatedCostUsdAnthropicTable?: number;
  durationMs?: number;
  numTurns?: number;
  utcHour?: number;
}

interface TaskOutcome {
  id: string;
  intent: string;
  role: string;
  /** short | long — long conversations are where the cache economics show. */
  shape: string;
  /** Messages sent to the agent, i.e. how many times the prompt prefix was re-sent. */
  userTurns: number;
  ok: boolean;
  detail: string;
  /** Set when the turn threw — a crash is a distinct failure from a wrong answer. */
  error?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /**
   * Cache WRITES, billed ABOVE the base input rate. Recorded because omitting
   * it made reported cost impossible to reconcile against reported tokens: one
   * Anthropic task showed 975 output tokens and $0.063, an order of magnitude
   * off its neighbours, entirely from writing ~18k tokens of cache.
   */
  cacheCreationInputTokens: number;
  servedModels: string[];
  costUsd: number;
  /** How costUsd was derived, so two providers are never silently compared across methods. */
  costBasis: "rate-table" | "sdk-anthropic-table";
  utcHours: number[];
  reply: string;
}

interface Report {
  profile: {
    endpoint: string;
    model: string;
    smallFastModel: string;
    maxThinkingTokens: number;
    extraBody: Record<string, unknown>;
  };
  startedAt: string;
  /**
   * With startedAt, the exact UTC window to select in a provider's usage
   * dashboard. Billing is ground truth; the rate table below is only a model of
   * it, so a run that cannot be located in the dashboard cannot be checked.
   */
  finishedAt: string;
  outcomes: TaskOutcome[];
  totals: {
    tasks: number;
    passed: number;
    successRate: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
    costBasis: "rate-table" | "sdk-anthropic-table" | "mixed";
    costPerSuccessfulTaskUsd: number | null;
    medianLatencyMs: number;
    /** Set when the SDK's Anthropic price table does not cover this model. */
    costNote: string;
  };
}

/**
 * Cost for one turn, from our own rate table wherever we have one.
 *
 * Falling back to the SDK's figure is a LAST RESORT and is flagged in the
 * report, because it makes a cross-provider comparison span two different
 * methods — the SDK computes from a compiled-in Anthropic table we cannot
 * inspect, so its number cannot be reconciled against the token counts beside
 * it. Add the model to RATES_PER_MTOK rather than relying on this branch.
 */
function turnCost(stats: TurnStatsRecord): { usd: number; fromTable: boolean } {
  const model = (stats.servedModel ?? "").split(",")[0] ?? "";
  const rate = RATES_PER_MTOK[model];
  if (!rate) return { usd: stats.estimatedCostUsdAnthropicTable ?? 0, fromTable: false };

  // inputTokens and cacheReadInputTokens are DISJOINT, not nested — measured,
  // because getting this backwards silently under-bills by roughly the cache
  // ratio, which on this workload is most of the prompt. Against DeepSeek an
  // identical 28,810-token prefix reports input_tokens=28810/cache_read=0 on
  // the first call and input_tokens=10/cache_read=28800 on the second: the
  // fresh count DROPS to just the new turn. Subtracting one from the other
  // would price nearly the whole prompt at the cache-hit rate.
  const cached = stats.cacheReadInputTokens ?? 0;
  const written = stats.cacheCreationInputTokens ?? 0;
  const fresh = stats.inputTokens ?? 0;
  const usd =
    (fresh * rate.inputMiss +
      cached * rate.inputHit +
      written * rate.cacheWrite +
      (stats.outputTokens ?? 0) * rate.output) /
    1_000_000;
  return { usd, fromTable: true };
}

function collectingChannel(sent: string[]): WhatsAppChannel {
  return {
    sendText: async (_phone: string, text: string) => {
      sent.push(text);
    },
    downloadMedia: async () => {
      throw new Error("comparison tasks are text-only");
    },
  } as WhatsAppChannel;
}

async function runTask(config: Config, task: CompareTask): Promise<TaskOutcome> {
  // A fresh in-memory database per task, so one task's writes cannot make the
  // next one's assertion pass for the wrong reason.
  const db = openDb(":memory:");
  const sent: string[] = [];
  const stats: TurnStatsRecord[] = [];
  const phone = task.role === "owner" ? OWNER : CUSTOMER;

  task.seed?.(db, OWNER);

  const deps = {
    db,
    config,
    channel: collectingChannel(sent),
    log: {
      info: (obj: unknown) => {
        if (obj && typeof obj === "object") stats.push(obj as TurnStatsRecord);
      },
      warn: () => undefined,
    } as never,
  };

  const ctx: TurnContext = { phone, role: task.role };
  const started = Date.now();
  let error: string | undefined;
  try {
    for (const message of task.messages) {
      await runAgentTurn(deps, ctx, message);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Date.now() - started;

  const reply = sent.join("\n");
  // A thrown turn is a failure regardless of what the checker would say about
  // whatever state happened to be left behind.
  const verdict = error
    ? { ok: false, detail: `turn threw: ${error}` }
    : task.check(db, reply, sent);

  const sum = (pick: (s: TurnStatsRecord) => number | undefined) =>
    stats.reduce((acc, s) => acc + (pick(s) ?? 0), 0);

  return {
    id: task.id,
    intent: task.intent,
    role: task.role,
    shape: task.shape,
    userTurns: task.messages.length,
    ok: verdict.ok,
    detail: verdict.detail,
    ...(error ? { error } : {}),
    latencyMs,
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    cacheReadInputTokens: sum((s) => s.cacheReadInputTokens),
    cacheCreationInputTokens: sum((s) => s.cacheCreationInputTokens),
    servedModels: [...new Set(stats.map((s) => s.servedModel).filter(Boolean) as string[])],
    costUsd: stats.reduce((acc, s) => acc + turnCost(s).usd, 0),
    costBasis: stats.every((s) => turnCost(s).fromTable) ? "rate-table" : "sdk-anthropic-table",
    utcHours: [...new Set(stats.map((s) => s.utcHour).filter((h) => h !== undefined) as number[])],
    reply,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function summarise(
  config: Config,
  outcomes: TaskOutcome[],
  startedAt: string,
  finishedAt: string,
): Report {
  const passed = outcomes.filter((o) => o.ok).length;
  const costUsd = outcomes.reduce((a, o) => a + o.costUsd, 0);
  const servedModels = new Set(outcomes.flatMap((o) => o.servedModels));
  const anyOffTable = [...servedModels].some((m) => !RATES_PER_MTOK[m.split(",")[0] ?? ""]);

  return {
    profile: {
      endpoint: config.agentBaseUrl,
      model: config.model,
      smallFastModel: config.smallFastModel,
      maxThinkingTokens: config.maxThinkingTokens,
      extraBody: config.agentExtraBody,
    },
    startedAt,
    finishedAt,
    outcomes,
    totals: {
      tasks: outcomes.length,
      passed,
      successRate: outcomes.length ? passed / outcomes.length : 0,
      inputTokens: outcomes.reduce((a, o) => a + o.inputTokens, 0),
      outputTokens: outcomes.reduce((a, o) => a + o.outputTokens, 0),
      cacheReadInputTokens: outcomes.reduce((a, o) => a + o.cacheReadInputTokens, 0),
      cacheCreationInputTokens: outcomes.reduce((a, o) => a + o.cacheCreationInputTokens, 0),
      costUsd,
      costBasis: outcomes.every((o) => o.costBasis === "rate-table")
        ? "rate-table"
        : outcomes.every((o) => o.costBasis === "sdk-anthropic-table")
          ? "sdk-anthropic-table"
          : "mixed",
      // The headline number. Null rather than Infinity when nothing passed:
      // "no successful tasks" is a finding, not a very large price.
      costPerSuccessfulTaskUsd: passed > 0 ? costUsd / passed : null,
      medianLatencyMs: median(outcomes.map((o) => o.latencyMs)),
      costNote: anyOffTable
        ? `NOT COMPARABLE ACROSS PROVIDERS: cost for ${[...servedModels].filter((m) => !RATES_PER_MTOK[m.split(",")[0] ?? ""]).join(", ")} came from the SDK's built-in Anthropic price table, which cannot be reconciled against the token counts here. Add the model to RATES_PER_MTOK before comparing costs.`
        : "cost computed from this file's published per-provider rates (input, cache read, cache write, output)",
    },
  };
}

const usd = (n: number) => `$${n.toFixed(6)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function renderMarkdown(report: Report): string {
  const { profile, totals } = report;
  const lines = [
    `# Provider comparison — ${profile.endpoint}`,
    "",
    `- model: \`${profile.model}\` (small/fast: \`${profile.smallFastModel}\`)`,
    `- thinking: maxThinkingTokens=${profile.maxThinkingTokens}, extraBody=\`${JSON.stringify(profile.extraBody)}\``,
    `- started: ${report.startedAt}`,
    "",
    "| task | shape | turns | ok | latency | in | out | cache read | cache write | cost |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const o of report.outcomes) {
    lines.push(
      `| \`${o.id}\` | ${o.shape} | ${o.userTurns} | ${o.ok ? "✅" : "❌"} | ${o.latencyMs}ms | ${o.inputTokens} | ${o.outputTokens} | ${o.cacheReadInputTokens} | ${o.cacheCreationInputTokens} | ${usd(o.costUsd)} |`,
    );
  }
  lines.push(
    "",
    "## Totals",
    "",
    `- **tool-call success rate: ${pct(totals.successRate)}** (${totals.passed}/${totals.tasks})`,
    `- **cost per successful task: ${totals.costPerSuccessfulTaskUsd === null ? "n/a — nothing passed" : usd(totals.costPerSuccessfulTaskUsd)}**`,
    `- total cost: ${usd(totals.costUsd)} · median latency: ${totals.medianLatencyMs}ms`,
    `- tokens: ${totals.inputTokens} in / ${totals.outputTokens} out / ${totals.cacheReadInputTokens} read from cache / ${totals.cacheCreationInputTokens} written to cache`,
    `- cost basis: **${totals.costBasis}** — ${totals.costNote}`,
  );

  // Everything needed to check this run against the provider's own billing.
  // The rate table above is a MODEL of the invoice; the dashboard is the
  // invoice. Where they disagree, the dashboard is right.
  // Split by conversation shape. A blended average hides the thing that
  // decides this comparison: long chats re-send the whole system prompt every
  // turn, so they are almost entirely cached prefix, and the two providers
  // cache that prefix very differently. If the two rows below disagree, the
  // right provider depends on how long your conversations actually run.
  lines.push("", "## By conversation shape", "");
  lines.push("| shape | tasks | turns | fresh in | cache read | cache write | out | cost | $/task |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const shape of ["short", "long"] as const) {
    const group = report.outcomes.filter((o) => o.shape === shape);
    if (group.length === 0) continue;
    const g = (pick: (o: TaskOutcome) => number) => group.reduce((a, o) => a + pick(o), 0);
    const cost = g((o) => o.costUsd);
    lines.push(
      `| ${shape} | ${group.length} | ${g((o) => o.userTurns)} | ${g((o) => o.inputTokens)} | ${g((o) => o.cacheReadInputTokens)} | ${g((o) => o.cacheCreationInputTokens)} | ${g((o) => o.outputTokens)} | ${usd(cost)} | ${usd(cost / group.length)} |`,
    );
  }

  lines.push(
    "",
    "## Dashboard reconciliation",
    "",
    `- UTC window: \`${report.startedAt}\` → \`${report.finishedAt}\``,
    `- billable tokens: ${totals.inputTokens} input · ${totals.cacheReadInputTokens} cache read · ${totals.cacheCreationInputTokens} cache write · ${totals.outputTokens} output`,
    `- predicted spend: **${usd(totals.costUsd)}**`,
    "",
    "Select that window in the provider's usage dashboard for the key this run used.",
    "For the comparison to mean anything, that key must have served NO other traffic",
    "in the window — the live parity suites bill the same key and would inflate it.",
    "",
    "**Expect the dashboard to exceed the prediction, and to exceed it by MORE for a",
    "cache-heavy provider.** The SDK under-reports cache-write tokens, so predicted",
    "spend is a lower bound (measured 2026-07-25: 63% of actual on Anthropic, 89% on",
    "DeepSeek). Decide on the dashboard figures; use the tables above to see WHERE",
    "the money went, not HOW MUCH.",
  );

  const failures = report.outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const f of failures) lines.push(`- \`${f.id}\` — ${f.detail}`);
  }
  return lines.join("\n");
}

/** Side-by-side diff of two saved reports. */
function renderDiff(a: Report, b: Report): string {
  const row = (label: string, left: string, right: string) => `| ${label} | ${left} | ${right} |`;
  const byId = new Map(b.outcomes.map((o) => [o.id, o]));

  // Two guards, because both failure modes produce a table that LOOKS fine.
  const warnings: string[] = [];
  if (a.totals.costBasis !== b.totals.costBasis) {
    warnings.push(
      `⚠️ **Cost columns are not comparable**: A was priced by \`${a.totals.costBasis}\`, B by \`${b.totals.costBasis}\`. ` +
        "Add the missing model to RATES_PER_MTOK and re-run before drawing any cost conclusion.",
    );
  }
  const idsA = a.outcomes.map((o) => o.id).join("|");
  const idsB = b.outcomes.map((o) => o.id).join("|");
  if (idsA !== idsB) {
    warnings.push(
      "⚠️ **The two runs did not execute the same task set.** Success rates and totals are not comparable.",
    );
  }

  const lines = [
    "# Provider comparison — side by side",
    "",
    ...(warnings.length > 0 ? [...warnings, ""] : []),
    `Task set: ${a.outcomes.length} tasks, identical in both runs. Cost basis: \`${a.totals.costBasis}\`.`,
    "",
    `| | ${a.profile.model} @ ${a.profile.endpoint} | ${b.profile.model} @ ${b.profile.endpoint} |`,
    "| --- | --- | --- |",
    row("success rate", pct(a.totals.successRate), pct(b.totals.successRate)),
    row(
      "cost / successful task",
      a.totals.costPerSuccessfulTaskUsd === null
        ? "n/a"
        : usd(a.totals.costPerSuccessfulTaskUsd),
      b.totals.costPerSuccessfulTaskUsd === null
        ? "n/a"
        : usd(b.totals.costPerSuccessfulTaskUsd),
    ),
    row("total cost", usd(a.totals.costUsd), usd(b.totals.costUsd)),
    row("median latency", `${a.totals.medianLatencyMs}ms`, `${b.totals.medianLatencyMs}ms`),
    row("fresh input tokens", String(a.totals.inputTokens), String(b.totals.inputTokens)),
    row("cache read tokens", String(a.totals.cacheReadInputTokens), String(b.totals.cacheReadInputTokens)),
    row(
      "cache write tokens",
      String(a.totals.cacheCreationInputTokens),
      String(b.totals.cacheCreationInputTokens),
    ),
    row("output tokens", String(a.totals.outputTokens), String(b.totals.outputTokens)),
    row("UTC window", `${a.startedAt} → ${a.finishedAt}`, `${b.startedAt} → ${b.finishedAt}`),
    "",
    "## Per task",
    "",
    "| task | A | B | note |",
    "| --- | :-: | :-: | --- |",
  ];
  for (const left of a.outcomes) {
    const right = byId.get(left.id);
    // Regressions are what block a cutover, so they get named explicitly rather
    // than left for the reader to spot in two columns of ticks.
    const note =
      left.ok && right && !right.ok
        ? `**REGRESSION** — ${right.detail}`
        : !left.ok && right?.ok
          ? "improvement"
          : (right?.detail ?? left.detail);
    lines.push(
      `| \`${left.id}\` | ${left.ok ? "✅" : "❌"} | ${right ? (right.ok ? "✅" : "❌") : "—"} | ${note} |`,
    );
  }
  return lines.join("\n");
}

function readReport(path: string): Report {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const diffAt = args.indexOf("--diff");
  if (diffAt !== -1) {
    const [left, right] = [args[diffAt + 1], args[diffAt + 2]];
    if (!left || !right) throw new Error("--diff needs two report paths");
    console.log(renderDiff(readReport(left), readReport(right)));
    return;
  }

  const config = loadOfflineConfig();

  const onlyAt = args.indexOf("--only");
  const only = onlyAt !== -1 ? args[onlyAt + 1]?.split(",") : undefined;
  const selected = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  if (selected.length === 0) throw new Error(`no tasks matched --only ${only?.join(",")}`);

  // An LLM is not deterministic, so one pass over the set is one sample. Repeats
  // are what make a small cost or success-rate gap mean anything; without them
  // a 20% difference is indistinguishable from luck. Ids are suffixed so each
  // pass stays individually visible in the report rather than being averaged
  // away — the failures cluster, and that pattern is the signal.
  const repeatAt = args.indexOf("--repeat");
  const repeat = repeatAt !== -1 ? Math.max(1, Number.parseInt(args[repeatAt + 1] ?? "1", 10)) : 1;
  const tasks =
    repeat === 1
      ? selected
      : Array.from({ length: repeat }, (_, pass) =>
          selected.map((t) => (pass === 0 ? t : { ...t, id: `${t.id}#${pass + 1}` })),
        ).flat();

  const outAt = args.indexOf("--out");
  const outPath = resolveDataPath(
    args[outAt + 1] && outAt !== -1
      ? args[outAt + 1]!
      : `./data/compare/${new URL(config.agentBaseUrl).hostname}-${config.model}.json`,
  );

  const startedAt = new Date().toISOString();
  console.error(`Running ${tasks.length} tasks against ${config.agentBaseUrl} (${config.model})…`);

  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    // Sequential on purpose: concurrent turns against one account make latency
    // and prompt-cache behaviour meaningless, and both are being measured.
    process.stderr.write(`  ${task.id} … `);
    const outcome = await runTask(config, task);
    outcomes.push(outcome);
    console.error(
      `${outcome.ok ? "ok" : `FAIL (${outcome.detail})`} ${outcome.latencyMs}ms ${usd(outcome.costUsd)}`,
    );
  }

  const report = summarise(config, outcomes, startedAt, new Date().toISOString());
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(renderMarkdown(report));
  console.error(`\nJSON written to ${outPath}`);
  console.error(`Diff two runs with:  npm run compare -w server -- --diff <a.json> <b.json>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
