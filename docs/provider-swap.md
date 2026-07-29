# Provider swap: Anthropic ⇄ DeepSeek

The agent runs on the Claude Agent SDK, which spawns a bundled Claude Code CLI and reads its endpoint, credential and model tiers from the environment. Routing to an Anthropic-compatible provider therefore needs **no abstraction layer and no code change** — only the right variables.

Configuring the swap is the easy part. Verifying it is the work, and everything below distinguishes what was **measured** from what was **read in documentation**.

> **For the evaluation result and the cost evidence, see [provider-swap-findings.md](./provider-swap-findings.md).** This document is the operational reference: variables, profiles, and parity gaps.

---

## Quick start

```bash
# Anthropic (default)
./scripts/with-secrets.sh --profile anthropic npm run dev -w server

# DeepSeek
./scripts/with-secrets.sh --profile deepseek  npm run dev -w server
./scripts/with-secrets.sh --profile deepseek  docker compose up -d
```

A profile is a committed, **secret-free** file at the repo root (`env.anthropic`, `env.deepseek`) holding routing config. The credential still comes from gopass, chosen by profile:

| profile | gopass entry | exported as |
| --- | --- | --- |
| `anthropic` | `vitrina/anthropic_api_key` | `ANTHROPIC_API_KEY` (`x-api-key`) |
| `deepseek` | `vitrina/deepseek_api_key` | `ANTHROPIC_AUTH_TOKEN` (`Bearer`) |

`with-secrets.sh` unsets the *other* credential. Leaving both set hands the SDK two credentials for one endpoint, and which one wins is not something you want deployed.

---

## Environment variables

Read by **our code** (`server/src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Where `/v1/messages` goes. |
| `ANTHROPIC_API_KEY` | — | `x-api-key` credential. |
| `ANTHROPIC_AUTH_TOKEN` | — | `Authorization: Bearer` credential. |
| `MODEL` | `claude-haiku-4-5` | Model for the agent turn. |
| `SMALL_FAST_MODEL` | falls back to `MODEL` | Model for the SDK's own utility calls. |
| `MAX_THINKING_TOKENS` | `0` (unset) | Thinking budget. `> 0` enables thinking. |
| `AGENT_EXTRA_BODY` | `{}` | JSON merged into every request body. |

**At least one of `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is required.** Neither is individually required — a DeepSeek deployment has no Anthropic key at all — but a boot with neither still dies immediately rather than on the first customer message.

`AGENT_EXTRA_BODY` is parsed and validated at boot. The bundled CLI merely *logs* an error for an unparseable value and carries on, so an unvalidated typo would silently disable the knob for the life of the deploy.

Passed to the SDK subprocess by `buildAgentEnv` (`server/src/agent/agent.ts`):

`ANTHROPIC_BASE_URL` · the chosen credential · `ANTHROPIC_MODEL` · `ANTHROPIC_DEFAULT_HAIKU_MODEL` · `ANTHROPIC_SMALL_FAST_MODEL` · `CLAUDE_CODE_SUBAGENT_MODEL` · `MAX_THINKING_TOKENS` · `CLAUDE_CODE_EXTRA_BODY`

Three notes that are easy to get wrong:

- The SDK's `env` option **replaces** `process.env` rather than merging. `buildAgentEnv` spreads `process.env` first; dropping that spread strips `PATH` and the subprocess never starts.
- The small/fast tier is pinned through **all three** variables because the CLI resolves it via different code paths. An unset one keeps asking for the compiled-in `claude-haiku-4-5` — which DeepSeek answers by silently substituting its own model rather than erroring.
- `config` is the single source of truth. A leftover shell variable cannot outvote it, and the unused credential is deleted outright.

---

## The two model tiers

Our code has always had exactly one model reference. The "Haiku usage" that also exists is **invisible in our source**: the CLI makes its own utility calls (compaction, summarisation, subagents) against a Haiku-tier model it resolves from the environment.

`MODEL` and `SMALL_FAST_MODEL` are kept as separate config values even when they hold the same string, so the tiers can be split again without touching code.

---

## Thinking mode

| | Anthropic | DeepSeek |
| --- | --- | --- |
| `thinking: {type: enabled}` | supported, **`budget_tokens` required** | supported, **`budget_tokens` ignored** |
| `MAX_THINKING_TOKENS` | real budget | inert |
| effort control | via budget | `output_config: {effort}` only |
| effort floor | n/a | **`high`** — `low`/`medium` silently promoted |
| default | off unless requested | **on** |

Two traps, both verified against the shipped SDK bundle and the live API:

1. **DeepSeek's floor is `high`.** There is no way to dial reasoning *down* for the former Haiku-tier calls — only off, with `AGENT_EXTRA_BODY={"thinking":{"type":"disabled"}}`. The reasoning-latency tax on utility calls is otherwise unavoidable.
2. **`CLAUDE_CODE_EFFORT_LEVEL=max` does nothing**, despite DeepSeek's own docs prescribing it. SDK `0.1.77` accepts only `low|medium|high|<int>|unset` there and discards anything else without a word. `AGENT_EXTRA_BODY` bypasses that entirely, which is why the profiles use it.

Anthropic **requires** `budget_tokens` whenever thinking is enabled; DeepSeek ignores it. Sending it satisfies both.

---

## Observability

Every turn logs one structured line (`agent turn complete`) carrying:

`endpointHost` · `configuredModel` · **`servedModel`** · `inputTokens` · `outputTokens` · `cacheReadInputTokens` · `cacheCreationInputTokens` · `durationMs` · `durationApiMs` · `numTurns` · `maxThinkingTokens` · `extraBody` · `startedAt` · `utcHour`

**Compare `configuredModel` against `servedModel` in production.** DeepSeek resolves an unrecognised model id to its own default *silently*, so a typo in `MODEL` produces perfectly good replies from a model you did not choose. `servedModel` is read from the response's usage map and is the only evidence of what actually answered.

`estimatedCostUsdAnthropicTable` is named for what it is: the SDK computes it from a compiled-in **Anthropic** price table, so it is accurate for Anthropic and wrong for anyone else. Real per-provider cost is computed by the comparison harness from raw token counts.

`utcHour` is captured because DeepSeek is *reported* to be moving to peak/off-peak pricing on UTC windows. That schedule is **not on their official rate card** and could not be confirmed — so this records the data to correlate spend against later and builds no scheduling on an unconfirmed claim.

---

## Verifying a swap

```bash
npm run test -w server        # offline, hermetic, no API calls — must stay green

./scripts/with-secrets.sh --profile anthropic npm run test:live -w server
./scripts/with-secrets.sh --profile deepseek  npm run test:live -w server

./scripts/with-secrets.sh --profile anthropic npm run compare -w server -- --out ./data/compare/anthropic.json
./scripts/with-secrets.sh --profile deepseek  npm run compare -w server -- --out ./data/compare/deepseek.json
npm run compare -w server -- --diff data/compare/anthropic.json data/compare/deepseek.json
```

The live suites are **excluded** from the default vitest run (separate `vitest.live.config.ts`) rather than skipped inside it, so `npm test` can never accidentally bill an API.

**`test/live/wire.live.test.ts`** — raw POSTs to `/v1/messages`, no SDK. Answers the primitives: does a `thinking` block actually come back, is the configured `AGENT_EXTRA_BODY` accepted, is an identical long prefix served from cache and under which field names, does a `tool_use`/`tool_result` round trip survive.

**`test/live/agent-loop.live.test.ts`** — the real `runAgentTurn`, unmocked, through the real MCP tool server. Asserts on **database state and the reply the customer would have received**, never on the request we sent. That distinction matters: this endpoint documents several fields as *ignored* rather than rejected, so a request is not evidence of anything.

**`server/src/tools/compare-providers.ts`** — the same 12 tasks through each profile. Success is defined per task as a predicate over the **database**, not "the model responded". A grounded agent that failed to call its tools still answers politely; that is the entire failure mode.

---

## Measured results

All measured 2026-07-25 against `claude-haiku-4-5` and `deepseek-v4-flash`.

### Wire parity

| Question | Anthropic | DeepSeek |
| --- | --- | --- |
| `servedModel` matches what we configured | ✅ | ✅ `deepseek-v4-flash` |
| Thinking block actually returned | ✅ | ✅ (393 chars) |
| Configured `AGENT_EXTRA_BODY` accepted | n/a (empty) | ✅ HTTP 200 |
| Thinking can be turned **off** | ✅ | ✅ 0 thinking blocks |
| Identical long prefix served from cache | ✅ | ✅ |
| `input_tokens` collapses on a cache hit | ✅ | ✅ |
| `tool_use` / `tool_result` round trip | ✅ | ✅ |
| Two tools in one turn, arguments not crossed | ✅ | ✅ |
| `metadata.user_id` accepted | ✅ | ✅ — the reported 400 did **not** reproduce |
| 4 KB system prompt accepted | ✅ | ✅ |

**Wire: 8/8 Anthropic (2 DeepSeek-only probes skipped) · 10/10 DeepSeek.**

### Agent loop — the cutover bar

**13/13 on Anthropic · 13/13 on DeepSeek.**

Both providers passed multi-turn tool chains, merge-not-rewrite, falsy-value preservation, explicit-null clearing, publish-and-reset, session resume, and both role-boundary tests.

**This settles the "MCP tools: Not Supported" question.** That line refers to the Messages API's server-side connector, not the SDK's in-process `createSdkMcpServer`. Our entire tool surface works through DeepSeek's Anthropic endpoint.

### Comparison harness — 29 tasks × 3 passes = 87 tasks, same set through both

Measured 2026-07-25. **Costs below are the provider dashboards** — real billed spend for the exact run window, not an estimate.

| | `claude-haiku-4-5` | `deepseek-v4-flash` |
| --- | --- | --- |
| **billed cost (dashboard)** | **$1.99** | **$0.61** — 3.3× cheaper |
| success rate | 87% (76/87) | 95% (83/87) |
| median latency | **5,774 ms** | 9,126 ms (1.6× slower) |
| fresh input tokens | **2,060** | 3,400,950 |
| cache read tokens | 7,389,470 | 5,827,200 |
| **cache hit rate** | **99.97%** | 63% |

**The caching result is the interesting one, and it inverts the obvious expectation.** Anthropic caches almost perfectly — 2,060 uncached input tokens across 87 tasks. DeepSeek pays full price on 3.4 million. Yet DeepSeek costs a third as much, because the *rate* dominates the *hit rate*:

| | Anthropic | DeepSeek |
| --- | --- | --- |
| cache read | $0.10/MTok | **$0.0028/MTok** (36× cheaper) |
| cache write | $1.25/MTok | n/a (automatic, no write step) |

Anthropic caches more and charges far more for what it cached. Caching does not rescue the price gap; it is where most of Anthropic's bill lands.

**Cost grows with conversation length on Anthropic, and barely on DeepSeek** (harness figures, which understate Anthropic — see the warning below):

| shape | tasks | turns | Anthropic $/task | DeepSeek $/task | gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| short | 72 | 90 | $0.010613 | $0.005710 | 1.9× |
| **long** | 15 | 93 | **$0.032769** | $0.008638 | **3.8×** |

So the longer your conversations run, the wider the gap — the opposite of what better caching would predict.

> ⚠️ **The harness's own cost figures are lower bounds, unevenly.** Against the dashboards for this run it computed 63% of actual on Anthropic and 89% on DeepSeek, because the SDK under-reports cache-write tokens and Anthropic's spend is concentrated in cache operations. The SDK's `total_cost_usd` returned zero throughout and offered no cross-check. **Decide on dashboard figures**; use the harness tables to see where the money went, not how much.

#### Failure clustering — why repeats matter

Running each task 3× separates real defects from noise. On one pass, Anthropic scored 11/12 twice with *different* tasks failing each time.

| | 3/3 (real) | 1/3 (noise) |
| --- | --- | --- |
| Anthropic | `owner-sequential-listings`, `customer-unknown-code`, `customer-budget-filter` (2/3) | 3 tasks |
| DeepSeek | `customer-unknown-code` | 1 task |

**Three of those were bugs in the tests, not the providers** — and two penalised Anthropic specifically: a regex that only matched "no encuentro" failed both providers for correctly answering "No encontré", and `owner-sequential-listings` omitted a required title, so Anthropic *correctly asking* for it scored as a failure while a placeholder-titled listing passed. All three are fixed; the pass rates above predate the fix and understate Anthropic.

**Read the quality result as near-parity, and the cost result as decisive.**

### Earlier run — 12 tasks, same set through both

| | `claude-haiku-4-5` | `deepseek-v4-flash` |
| --- | --- | --- |
| success rate | 92% (11/12) | **100% (12/12)** |
| **cost / successful task** | $0.020021 | **$0.006110** (3.3× cheaper) |
| total cost | $0.220227 | $0.073316 |
| median latency | 8,840 ms | **12,301 ms** (1.4× slower) |
| fresh input tokens | 268 | 469,118 |
| cached input tokens | 790,261 | 542,976 |

**Zero regressions.** No task passes on Anthropic and fails on DeepSeek. One improvement: `customer-save-lead`, which Anthropic failed on this run.

Read the token columns carefully — they are the most interesting result here. Anthropic paid for **268** fresh input tokens across the whole run; DeepSeek paid for **469,118**. Both cache, but differently:

- Anthropic honours our explicit `cache_control` breakpoints, so the system prompt and tool schemas are cached once and read back for the entire run.
- DeepSeek ignores those breakpoints and relies on automatic prefix caching, which warms up *within* a conversation but evidently not across the fresh sessions each task starts with — hence ~38 K fresh tokens per task.

DeepSeek still wins on cost by 3.3× because its per-token rate is far lower. But the gap would be considerably wider if its caching matched Anthropic's, and this is the number to watch if conversations get longer or the system prompt grows.

**Latency is the real trade.** DeepSeek is ~40 % slower at the median, and that is structural, not tunable: reasoning is on by default and cannot be dialled below effort `high`. On a WhatsApp channel already debouncing bursts for 8–45 s this is likely acceptable, but it is a genuine regression, not a rounding error.

---

## Parity gaps

Verified against official documentation and, where marked, against the live API.

| Behaviour | Anthropic | DeepSeek | Impact here |
| --- | --- | --- | --- |
| `cache_control` breakpoints | honoured ✅ *(measured)* | **ignored** *(measured)* | Caching is **not lost** — DeepSeek's automatic prefix caching works and IS reported under Anthropic's own `cache_read_input_tokens`. But it is far less effective on our workload: see the token columns above. |
| `thinking.budget_tokens` | **required** ✅ *(measured)* | **ignored** | Steer effort via `AGENT_EXTRA_BODY`. |
| Reasoning effort floor | n/a | **`high`** | Utility-tier calls cannot be made cheap, only non-thinking. |
| `CLAUDE_CODE_EFFORT_LEVEL=max` | n/a | discarded by SDK 0.1.77 | Use `AGENT_EXTRA_BODY`. |
| `image` content blocks | supported | **not supported** | **No impact.** This agent never sees an image — `batcher.ts` announces photos as a text placeholder and `tools.ts` relays them as a storefront link. The model context is 100% text. |
| `GET /v1/models` | supported ✅ *(measured)* | **404** | Preflight reports `unknown`, never `invalid`, so a healthy DeepSeek boot does not raise a false alarm. |
| `metadata.user_id` | accepted ✅ *(measured)* | accepted ✅ *(measured)* — the reported 400 did not reproduce | Covered by a wire test, kept as a regression guard. |
| `top_k`, `anthropic-beta`, `service_tier` | supported | ignored | Unused here. |
| Server-side MCP connector | supported | not supported | **No impact** *(measured)* — we use the SDK's in-process MCP, which marshals to plain `tools`. 13/13 loop tests pass. |
| Peak/off-peak pricing | n/a | **unconfirmed** | Absent from the official rate card; third-party claim only. `utcHour` is logged so real spend can be correlated later. |

### Effort levels do change behaviour — just not through the SDK's env var

Measured on DeepSeek, same prompt:

| `output_config.effort` | thinking produced |
| --- | --- |
| `high` | 2,195 chars |
| `max` | 5,192 chars |

So `max` **is** a real, accepted value at the API level and produces materially more reasoning. It is only `CLAUDE_CODE_EFFORT_LEVEL` that discards it. Reaching it requires `AGENT_EXTRA_BODY`, which is why the profile uses that route. Note the cost: more thinking is more output tokens, at the output rate.

### Caching: how a too-small probe produced a false negative

An early version of the wire probe used a ~6 K-token prefix and reported `cache_read_input_tokens=0` against DeepSeek — which reads exactly like "caching does not carry over". It was wrong. The prefix was below the provider's minimum cacheable length.

Re-run at ~28 K tokens, the same endpoint reports:

```
call 1: input_tokens=28810  cache_read_input_tokens=0
call 2: input_tokens=10     cache_read_input_tokens=28800
call 3: input_tokens=10     cache_read_input_tokens=28800
```

Two things follow, and both matter for cost accounting:

1. **Caching works and is reported under Anthropic's field names.** DeepSeek's native `prompt_cache_hit_tokens` never appears.
2. **`input_tokens` and `cache_read_input_tokens` are DISJOINT, not nested** — the fresh count collapses to just the new turn. Treating cached tokens as a subset (`fresh = input − cached`) under-bills by roughly the cache ratio, which on this workload is most of the prompt. The harness had exactly that bug and reported DeepSeek ~9× cheaper than it is.

The wire suite now asserts both properties rather than printing them, so neither can regress silently.

### Still unverified

**Peak/off-peak surcharge windows.** Third-party claim only, absent from the official rate card. `utcHour` is logged so real spend can be correlated later; no scheduling is built on it. Note that every figure above was measured in a single ~30-minute window, so it reflects one point on any such schedule.

---

## Known issue this work surfaced (not provider-related)

`search_catalog`'s description advertises *"free-text search over title, description, neighborhood, features"*, but `repo.searchCatalog` substring-matches the whole `query` string:

| filter | result |
| --- | --- |
| `neighborhood: "Laureles", bedrooms: 3` | ✅ finds `1912` |
| `query: "Laureles"` | ✅ finds `1912` |
| `query: "apartamento 3 alcobas Laureles"` | ❌ **nothing** |

So a customer asking normally can be told "no tenemos nada" about a property that exists — whenever the model fills the prose `query` instead of the structured filters. **This reproduces on Anthropic**, is pre-existing, and is orthogonal to the provider swap.

It matters here for one reason: it makes some customer-path outcomes a coin toss, which is noise in a parity comparison. Judge DeepSeek on **regressions against the Anthropic baseline**, not on absolute pass rate. The `--diff` output flags regressions explicitly for this reason.

> **Resolved since.** `repo.searchCatalog` now scores relevance word by word, so all three rows above find `1912` and the coin toss is gone — a live customer-path failure is a real signal again, not a search artefact.

---

## Cutover bar

| # | Criterion | Status |
| --- | --- | --- |
| 1 | `npm run test -w server` green (offline) | ✅ 202 passing |
| 2 | Both live suites run against **both** profiles | ✅ 23/23 Anthropic · 23/23 DeepSeek |
| 3 | `--diff` shows **no regression** | ✅ zero regressions, one improvement |
| 4 | Cost per successful task favours the swap | ✅ 3.3× cheaper |

**All four met.** The swap is technically sound on our real workloads.

Two things the bar does not decide, which are judgement calls rather than measurements:

- **Latency.** ~40 % slower at the median, structurally — DeepSeek reasons by default and its effort floor is `high`. Acceptable on a channel that already debounces bursts for 8–45 s, but it is a real regression and customers feel it.
- **Provider risk.** A second external dependency, a rate card that has already deprecated two model ids this month, and an unconfirmed peak-pricing schedule.

Before flipping production, run one more comparison in a different UTC window to sanity-check the peak-pricing question, and watch `servedModel` in the logs for the first day.

Cost per *token* is never the metric. A model at half the price that fails a third of the time is more expensive, and its failures are wrong prices on a public storefront.
