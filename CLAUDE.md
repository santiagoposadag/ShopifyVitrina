# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vitrina: a WhatsApp-native sales & inventory assistant for a real-estate pilot. One npm-workspaces monorepo, three workspaces:

- `server/` — Fastify + Claude Agent SDK. Receives WhatsApp webhooks (via Kapso), runs agent turns, owns the SQLite schema.
- `web/` — Next.js 15 storefront (App Router, Tailwind v4). Reads the **same SQLite file** directly, read-only; there is no API between them.
- `shared/` — **types-only** package (`@vitrina/shared`, a single `.d.ts`). It has no `main` on purpose: a runtime import must fail. Import from it with `import type` only.

## Commands

```bash
npm run test -w server                 # vitest suite (from repo root)
npx vitest run test/batcher.test.ts    # single file (run from server/)
npx vitest run -t "publish"            # tests matching a name
npm run build -w server                # tsc --noEmit + emit build to dist/
npx tsc --noEmit                       # typecheck (run in server/ or web/)
npm run dev:server / npm run dev:web   # local dev (tsx watch / next dev)
npm run seed -w server                 # seed catalog from propiedad_1/, propiedad_2/
```

Docker: **`docker compose up`/`run` MUST go through `./scripts/with-secrets.sh`** — it injects ANTHROPIC/KAPSO secrets from gopass. A bare `up` recreates the server with blank secrets and it crash-loops. `docker compose build` works bare. Non-secret per-deploy config lives in `.env` (auto-loaded by compose; see `env.sample`; `env.txt` is a gitignored scratch template). `NEXT_PUBLIC_*` are **build args**: changing them requires rebuilding the web image.

## Message pipeline (the core architecture)

One inbound WhatsApp message travels: `inbox/webhook.ts` (HMAC verify over raw body → persist to `inbox` table with UNIQUE dedupe key → fast ACK) → `inbox/batcher.ts` (`InboxBatcher` debounces a phone's burst into ONE agent turn; the window is adaptive — bursts containing photos wait much longer because WhatsApp uploads photo sets in waves) → `inbox/queue.ts` (`PerPhoneQueue` serializes turns per phone; **this serialization is what makes `claimInboxBatch` safe** — batches for one phone must never overlap) → `agent/agent.ts` (`runAgentTurn`) → reply via `whatsapp/kapso.ts`.

Delivery is at-least-once: rows are `pending`/`processing`/`done`/`failed`; unfinished rows are replayed on boot (`replayPending`), and a failed batch retries with backoff up to `MAX_BATCH_ATTEMPTS` total attempts tracked in `inbox.attempts` (incremented at claim time, so the cap survives restarts and stops poison-message boot loops). User-facing failure side effects (apology) fire only on the terminal attempt via the batcher's `onBatchFailure` hook in `index.ts`.

## Role boundary (owner vs customer)

`OWNER_PHONE_NUMBERS` (env allowlist, E.164 digits without `+`) decides the role in `config.isOwner`. The boundary is enforced twice, and both layers have pinning tests:

- **Tools** (`agent/tools.ts` `buildToolServer`): customers get search/lead tools only; owner tools (`upsert_product`, `attach_pending_photos`, …) are added only for the owner role. Pinned in `test/tools.test.ts`.
- **Persona** (`agent/agent.ts` `systemPrompt`): the customer branch explicitly refuses inventory conversations and ignores "I am the owner" claims — role comes from the phone number, never from what the person says. Pinned in `test/agent.test.ts`.

`CUSTOMER_AGENT_ENABLED=false` disables the customer path entirely (static reply, no Claude call). Owners are exempt from it and from rate limits.

## Agent sessions

The per-phone session id lives in SQLite (`sessions` table), but the Agent SDK's transcripts live under the container's home dir — persisted by the `vitrina-sessions` volume. If a resume fails, `runAgentTurn` clears the id and retries ONCE fresh (only when a resume was in play — without one the failure is real and must surface).

Sessions are isolated by phone (`sessions.phone` is the primary key) and expire after `SESSION_MAX_AGE_DAYS` of **silence** — a sliding window, since `setSessionId` refreshes `updated_at` every turn. Context growth is bounded by the SDK's own auto-compaction (`compact_metadata.trigger: 'auto'`), so do NOT build a compaction layer; the `PreCompact` hook observes but cannot steer the summary. Dropping a session id orphans its transcript, so `runHousekeeping` sweeps transcripts that no session row references AND that are past the expiry window — the age check closes a race, since a turn in flight has no row pointing at it yet. `data/purge-sessions.ts` is the ops lever that drops customer histories on demand; it keeps owner sessions, because an owner mid-listing would lose in-progress work.

Tools communicate back to `runAgentTurn` only through the shared mutable `TurnContext` (`ctx.sessionAfterTurn = "reset"` — set by `upsert_product` on a publish transition, applied AFTER the turn; a mid-turn `clearSessionId` would be clobbered by the post-turn persist). Publishing resets the conversation so product N cannot bleed into product N+1.

## Invariants that are easy to break

- **`config.ts` must stay at `src/` root.** It (and `seed/seed.ts`) computes `REPO_ROOT` from `import.meta.url` with a hardcoded parent-segment count (`../../` and `../../../` respectively). Moving either file changes the depth and silently breaks every data path at runtime, not at compile time.
- **`upsert_product` is a merge, not a rewrite.** Omitted fields keep their stored value; attributes merge key by key; an explicit `null` is the only way to remove an attribute (`mergeAttributes` in `data/repo.ts`). Falsy values (`0`, `false`) are real data. The agent prompt depends on these exact semantics.
- **ESM with explicit `.js` extensions** in all server imports; `server/tsconfig.build.json` has `rootDir: "src"`, which is why `shared/` ships a `.d.ts` (declaration files are exempt from rootDir/emit). No barrel files.
- **Entry-point paths are referenced outside the code**: `server/dist/seed/seed.js`, `server/dist/data/backup.js`, and `server/dist/data/purge-sessions.js` appear in `compose.yaml` commands and `server/package.json` scripts. Moving an entry point means updating both.
- **`AGENT_TRANSCRIPTS_DIR` must never get a default.** The Agent SDK stores transcripts at `$HOME/.claude/projects/<cwd-with-slashes-as-dashes>/`, which on a developer's machine is the same directory as *their own* Claude Code history for this repo — a default would make the transcript sweep delete real work. Compose sets it explicitly; unset, the sweep is inert (`data/transcripts.ts`).
- **`loadDotEnv` anchors at `REPO_ROOT`, not the cwd**, and swallows a missing file. `npm run <script> -w server` runs from `server/`, so a cwd-relative `.env` silently misses and every variable falls back to its default — which for `OWNER_PHONE_NUMBERS` means an empty allowlist and every phone reading as a customer. The purge tool refuses to run on an empty allowlist for exactly this reason.
- **Attribute keys are a closed list** duplicated in three places that must agree: `shared/index.d.ts` (`ProductAttributes`), the key list in the owner system prompt (`agent/agent.ts`), and the `upsert_product` tool description (`agent/tools.ts`). Adding an attribute means touching all three plus the storefront renderer (`web/app/components/PropertyDetail.tsx`).
- Kapso webhooks have a ~10s ACK deadline: never do slow work in the request handler — debouncing/agent work happens on the async worker path only.
- Agent replies and prompts are Spanish; code, comments, and prompt *instructions* are English.

## Testing conventions

Vitest in `server/test/`, in-memory SQLite (`openDb(":memory:")`) per test. The batcher suite uses `vi.useFakeTimers()` + `advanceTimersByTimeAsync` and a `harness()` with injectable `onMessage`/`onBatchFailure`. `agent.test.ts` mocks only the SDK's `query` (`vi.hoisted` + `vi.mock`) so the real MCP tool server still builds. Behavior-motivated regression tests are the house style — e.g. the batcher pins the real 37-photo burst timeline that motivated the adaptive window, including a negative test proving the rejected 30s window would have split it.
