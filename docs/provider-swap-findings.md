# Provider evaluation: Anthropic vs DeepSeek

**Date:** 2026-07-25 · **Models:** `claude-haiku-4-5` vs `deepseek-v4-flash` · **Status:** evaluation complete, production not cut over

Vitrina's agent can now be pointed at either provider by environment variables alone. This is the evidence behind that change: what was measured, what it cost, and what is still unproven.

Operational detail — env vars, profiles, parity gaps — lives in [provider-swap.md](./provider-swap.md).

---

## Headline

| | `claude-haiku-4-5` | `deepseek-v4-flash` | |
| --- | ---: | ---: | --- |
| **billed cost** (dashboard) | **$1.99** | **$0.61** | **3.3× cheaper** |
| cost per *successful* task | $0.0262 | $0.0074 | 3.6× cheaper |
| task success | 87% (76/87) | 95% (83/87) | see caveat |
| median latency | **5,774 ms** | 9,126 ms | 1.6× slower |
| agent-loop parity suite | 13/13 | 13/13 | — |
| wire parity suite | 8/8 | 10/10 | — |

Costs are **real billed spend read from each provider's dashboard** for the exact run window — not estimates. The workload was 87 tasks (29 scenarios × 3 passes) per provider, identical set, identical order.

> **The two runs were not symmetric on reasoning.** DeepSeek ran with `{"output_config":{"effort":"high"}}` and thinking active on every turn; Anthropic ran with extended thinking **off** (`maxThinkingTokens: 0`, `extraBody: {}`). Verified from the recorded run config, and the transmission path is pinned by a live test (`actually transmits AGENT_EXTRA_BODY into the request body`).
>
> This is not a flaw in the cost result — DeepSeek did strictly *more* work per turn and still cost a third as much. It does mean **most of the latency gap is reasoning Anthropic simply wasn't doing.** Note also that DeepSeek's thinking is on by default with a floor of `high`, so an empty `AGENT_EXTRA_BODY` would have produced much the same run; setting it made the configuration explicit, not different.

**DeepSeek runs our workload for roughly a third of the cost, at no worse quality.** Latency is the one real regression.

---

## 1. Cost

### Where the money actually goes

| | Anthropic | DeepSeek |
| --- | ---: | ---: |
| fresh input tokens | **2,060** | 3,400,950 |
| cache read tokens | 7,389,470 | 5,827,200 |
| cache write tokens | 101,752 | 0 |
| output tokens | 77,495 | 172,293 |
| **cache hit rate** | **99.97%** | **63%** |

The expectation going in was that Anthropic's prompt caching would close the price gap. **It does not, and the reason is the opposite of intuitive.**

Anthropic caches almost perfectly — 2,060 uncached input tokens across 87 tasks, because it honours the `cache_control` breakpoints the SDK puts on the system prompt and tool schemas. DeepSeek ignores those breakpoints and relies on automatic prefix caching, so it pays full price on 3.4 million tokens.

Anthropic still costs 3.3× more, because the *rate* dominates the *hit rate*:

| | Anthropic | DeepSeek |
| --- | ---: | ---: |
| cache read | $0.10/MTok | **$0.0028/MTok** (36× cheaper) |
| cache write | $1.25/MTok | n/a — caching is automatic, no write step |
| fresh input | $1.00/MTok | $0.14/MTok |
| output | $5.00/MTok | $0.28/MTok |

Anthropic caches more and charges far more for what it cached. Caching is not the escape from the price gap — it is where most of Anthropic's bill lands.

### The gap widens with conversation length

Harness figures (see the accuracy caveat in §3 — these understate Anthropic):

| shape | tasks | turns | Anthropic $/task | DeepSeek $/task | gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| short (1–2 turns) | 72 | 90 | $0.0106 | $0.0057 | 1.9× |
| **long (4–10 turns)** | 15 | 93 | **$0.0328** | $0.0086 | **3.8×** |

Every turn re-sends the whole system prompt and tool schemas, so a long chat is almost entirely repeated prefix. On Anthropic that prefix is cached but billed at $0.10/MTok; on DeepSeek it is largely cached and billed at $0.0028. The longer the conversation, the wider the gap — which matters, because real owner listings and customer discovery chats are long.

---

## 2. Quality

### Both providers pass the functional bar

The agent-loop suite runs the real `runAgentTurn` unmocked, through the real MCP tool server, asserting on database state rather than on reply text. **13/13 on both.**

This settled the one genuine risk. DeepSeek's compatibility table lists *"MCP tools: Not Supported"*, and this application is nothing but its tools. That line refers to the Messages API's server-side connector, **not** the SDK's in-process `createSdkMcpServer`, which marshals our tools into ordinary `tools` entries. Verified working: multi-turn tool chains, merge-not-rewrite semantics, `0`/`false` preservation, explicit-null attribute clearing, publish-and-reset, session resume, and both role-boundary guards.

### The 87% vs 95% gap is mostly measurement error

Running each scenario 3× separated real defects from noise:

| | fails 3/3 (real) | fails 1/3 (noise) |
| --- | --- | --- |
| Anthropic | `owner-sequential-listings`, `customer-unknown-code`, `customer-budget-filter` (2/3) | 3 tasks |
| DeepSeek | `customer-unknown-code` | 1 task |

**Three of those clusters were bugs in the tests, not the providers** — and two penalised Anthropic specifically:

1. `customer-unknown-code` — the regex matched only "no encuentro" and failed **both** providers 3/3 for correctly answering *"No encontré"* and *"No se encontró"*.
2. `owner-sequential-listings` — the scenario omitted a required title. Anthropic **correctly asked** for it and was scored as failing, while creating a placeholder-titled listing passed. The test rewarded the worse behaviour.
3. `customer-budget-filter` — demanded the literal code `1912` and reported "did not surface the listing" about a reply that described it correctly at $450 millones.

All three are fixed in `src/tools/tasks.ts`. The corrected run was **not** executed, so:

> **Read the quality result as near-parity.** Correcting for known test bugs would put Anthropic near 97% and DeepSeek near 99% — an estimate, not a measurement. Nothing here supports a claim that either model reasons better than the other; what is measured is that both clear our functional bar.

---

## 3. A defect in our own measurement

The harness computes cost from the SDK's reported token counts. Against the dashboards:

| | dashboard | harness | accuracy |
| --- | ---: | ---: | ---: |
| Anthropic | $1.99 | $1.2557 | **63%** |
| DeepSeek | $0.61 | $0.5407 | **89%** |

The SDK under-reports **cache-write** tokens: `modelUsage` surfaced 101,752, while the missing $0.73 corresponds to roughly 690k at $1.25/MTok — about what 87 fresh sessions each writing an ~8 KB system prompt would produce. The SDK's own `total_cost_usd` returned **zero** throughout (SDK 0.1.77), so it offered no cross-check.

**The error is not uniform across providers.** A provider whose spend sits in cache *operations* is under-measured far more than one whose spend sits in fresh input tokens. Token-derived cost therefore **flatters cache-heavy providers**, and the harness's 2.3× ratio understated DeepSeek's advantage against the dashboards' 3.3×.

`compare-providers.ts` now carries this warning at the rate table and in every report. **Decide on dashboard figures; use the harness to see where spend went, not how much.**

---

## 4. What is not proven

- **Latency is a real regression** — 5,774 ms → 9,126 ms median, and structural rather than tunable: DeepSeek reasons by default and its effort floor is `high` (`low`/`medium` are silently promoted). Likely acceptable behind the batcher's existing 8–45 s debounce, but it should be a decision, not a discovery.
- **Peak/off-peak pricing is unconfirmed.** Reported for DeepSeek by third parties, absent from their official rate card. Every figure here comes from a single ~35-minute window, so it reflects one point on any such schedule. The per-turn log records `utcHour` so real spend can be correlated later; no scheduling is built on an unconfirmed claim.
- **One run, three passes.** Enough to separate a 3× cost gap from noise. Not enough to resolve a 20% difference, and not enough to characterise tail behaviour.
- **Provider risk.** A second external dependency, on a rate card that deprecated two model ids this month (`deepseek-chat`, `deepseek-reasoner`, both 2026-07-24).
- **No vision.** DeepSeek's endpoint rejects `image` blocks. Harmless today — the agent never sees an image, only a text placeholder and a storefront link — but it forecloses any future feature that would.

## 5. A bug this work surfaced (unrelated to the swap)

`search_catalog` advertises *"free-text search"* but `repo.searchCatalog` substring-matches the entire `query` string:

| filter | result |
| --- | --- |
| `neighborhood: "Laureles", bedrooms: 3` | ✅ finds `1912` |
| `query: "apartamento 3 alcobas Laureles"` | ❌ **nothing** |

A customer asking naturally can be told "no tenemos nada" about a property that exists, whenever the model fills the prose `query` instead of structured filters. **This reproduces on Anthropic**, is pre-existing, and was deliberately left unfixed here — fixing it changes production search behaviour and belongs in its own change.

> **Resolved since.** It did bite in production first: an owner asked for "Llano Grande" and was told there was nothing, over a listing stored as "Llanogrande". `repo.searchCatalog` now scores relevance per word instead of matching the whole string, and both shapes of the question above return `1912` at 100%. See `server/test/catalog.test.ts`.

---

## Recommendation

Adopt DeepSeek for the agent, on the evidence that it runs our real workload at ~⅓ the cost with no functional regression and a widening advantage on the long conversations we actually have.

Before cutting over:

1. Accept the latency trade explicitly (5.8 s → 9.1 s median).
2. Re-run the comparison with the corrected tests to replace the estimated near-parity with a measured one.
3. Run once in a different UTC window to sanity-check the peak-pricing question.
4. Watch `servedModel` in the logs for the first day — DeepSeek resolves an unrecognised model id to its own default *silently*, so a typo in `MODEL` yields good replies from the wrong model.

Rollback is a one-line change: `--profile anthropic`.
