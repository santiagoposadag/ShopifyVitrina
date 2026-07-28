# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vitrina: a WhatsApp-native sales & inventory assistant for a real-estate pilot. One npm-workspaces monorepo, three workspaces plus a Go sidecar:

- `server/` — Fastify + Claude Agent SDK. Receives WhatsApp webhooks, runs agent turns, owns the SQLite schema.
- `web/` — Next.js 15 storefront (App Router, Tailwind v4). Reads the **same SQLite file** directly, read-only; there is no API between them.
- `shared/` — **types-only** package (`@vitrina/shared`, a single `.d.ts`). It has no `main` on purpose: a runtime import must fail. Import from it with `import type` only.
- `bridge/` — Go sidecar (whatsmeow). The alternative WhatsApp transport; **not** an npm workspace. See "WhatsApp providers" below.

## Commands

```bash
npm run test -w server                 # vitest suite (from repo root)
npx vitest run test/batcher.test.ts    # single file (run from server/)
npx vitest run -t "publish"            # tests matching a name
npm run build -w server                # tsc --noEmit + emit build to dist/
npx tsc --noEmit                       # typecheck (run in server/ or web/)
npm run dev:server / npm run dev:web   # local dev (tsx watch / next dev)
npm run seed -w server                 # seed catalog from propiedad_1/, propiedad_2/

go test ./...                          # bridge suite (run from bridge/)
go build ./... && go vet ./...         # bridge typecheck
```

Docker: **`docker compose up`/`run` MUST go through `./scripts/with-secrets.sh`** — it injects the ANTHROPIC and BRIDGE secrets from gopass. A bare `up` recreates the server with blank secrets and it crash-loops. `docker compose build` works bare. Non-secret per-deploy config lives in `.env` (auto-loaded by compose; see `env.sample`; `env.txt` is a gitignored scratch template). `NEXT_PUBLIC_*` are **build args**: changing them requires rebuilding the web image. The bridge is never published and never gets a Coolify domain — anyone who can reach `/send` can send WhatsApp messages as the business.

## Message pipeline (the core architecture)

One inbound WhatsApp message travels: `inbox/webhook.ts` (HMAC verify over raw body → persist to `inbox` table with UNIQUE dedupe key → fast ACK) → `inbox/batcher.ts` (`InboxBatcher` debounces a phone's burst into ONE agent turn; the window is adaptive — bursts containing photos wait much longer because WhatsApp uploads photo sets in waves) → `inbox/queue.ts` (`PerPhoneQueue` serializes turns per phone; **this serialization is what makes `claimInboxBatch` safe** — batches for one phone must never overlap) → `agent/agent.ts` (`runAgentTurn`) → reply via `whatsapp/bridge.ts`, which POSTs to the sidecar's `/send`.

Delivery is at-least-once: rows are `pending`/`processing`/`done`/`failed`; unfinished rows are replayed on boot (`replayPending`), and a failed batch retries with backoff up to `MAX_BATCH_ATTEMPTS` total attempts tracked in `inbox.attempts` (incremented at claim time, so the cap survives restarts and stops poison-message boot loops). User-facing failure side effects (apology) fire only on the terminal attempt via the batcher's `onBatchFailure` hook in `index.ts`.

## The WhatsApp transport (`bridge/`)

Messages travel through a Go sidecar that pairs as a **linked device** and speaks the WhatsApp Web multidevice protocol via [whatsmeow](https://github.com/tulir/whatsmeow). No WhatsApp Business onboarding, no per-conversation fee, and **no official standing with Meta** — the paired number carries real ban risk, and it is unlinked whenever the primary phone stays offline past WhatsApp's window. That last one is a *silent* failure: the process keeps running and simply stops receiving, so watch the bridge's `/status`, not its `/health`.

The sidecar knows nothing about products, owners, or agents. It POSTs inbound events to the server's `/webhook` (HMAC-SHA256 over the raw body) and accepts replies on an internal `/send`. Everything else stays on the server.

**`WhatsAppChannel`** (`whatsapp/channel.ts`) is the seam: `sendText` + `downloadMedia(ref)`, plus optional `releaseMedia`. `BridgeChannel` is its only implementation, and the interface stays because it is what lets the whole pipeline be tested with a plain object — no HTTP client, no paired device, no casts.

**Media never crosses HTTP.** whatsmeow decrypts it in the sidecar, which writes the plaintext into a staging directory both containers mount and hands over a *path*. A 37-photo owner burst moves zero image bytes between services. `isAllowedMediaPath` confines that path to the staging directory — the ref arrives in a signed body, but a signature proves origin, not good behaviour, and the value is fed straight to `readFile`.

The bridge owns an **outbox** (`bridge/outbox.go`) because whatsmeow acks to WhatsApp the moment an event is handled: anything not durable at that instant is lost, and it never reaches the `inbox` table for `replayPending` to recover. Delivery is strictly sequential by insertion id — photo order is listing order, and a concurrent dispatcher would silently reorder the owner's listing. One event per POST, which is why the server's webhook handles a single event rather than a batch.

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
- **`searchCatalog` filters on numbers and SCORES on text, and the two must not converge.** Price and bedrooms exclude outright — they are constraints someone stated, and a listing at five times the budget is the wrong house, not a 60% match. `query` and `neighborhood` only rank, because prose arrives however the person happened to say it (the bug that motivated this: "Llano Grande" finding nothing while the catalog held "Llanogrande"). Results carry a `match` percentage precisely because a hit is now a candidate, not proof — the tool result says so on every call, since a system prompt sits far back in a resumed transcript.
- **ESM with explicit `.js` extensions** in all server imports; `server/tsconfig.build.json` has `rootDir: "src"`, which is why `shared/` ships a `.d.ts` (declaration files are exempt from rootDir/emit). No barrel files.
- **Entry-point paths are referenced outside the code**: `server/dist/seed/seed.js`, `server/dist/data/backup.js`, and `server/dist/data/purge-sessions.js` appear in `compose.yaml` commands and `server/package.json` scripts. Moving an entry point means updating both.
- **`AGENT_TRANSCRIPTS_DIR` must never get a default.** The Agent SDK stores transcripts at `$HOME/.claude/projects/<cwd-with-slashes-as-dashes>/`, which on a developer's machine is the same directory as *their own* Claude Code history for this repo — a default would make the transcript sweep delete real work. Compose sets it explicitly; unset, the sweep is inert (`data/transcripts.ts`).
- **`loadDotEnv` anchors at `REPO_ROOT`, not the cwd**, and swallows a missing file. `npm run <script> -w server` runs from `server/`, so a cwd-relative `.env` silently misses and every variable falls back to its default — which for `OWNER_PHONE_NUMBERS` means an empty allowlist and every phone reading as a customer. The purge tool refuses to run on an empty allowlist for exactly this reason.
- **Attribute keys are a closed list** duplicated in three places that must agree: `shared/index.d.ts` (`ProductAttributes`), the key list in the owner system prompt (`agent/agent.ts`), and the `upsert_product` tool description (`agent/tools.ts`). Adding an attribute means touching all three plus the storefront renderer (`web/app/components/PropertyDetail.tsx`).
- **A LID is not a phone number.** WhatsApp addresses senders as `<id>@lid`, and those digits look exactly like a phone number to `normalizePhone` — so a LID reaching the server misses `OWNER_PHONE_NUMBERS` and the owner silently reads as a *customer*, while a reply addressed back to it goes to whoever really owns those digits. `bridge/inbound.go` `resolvePhone` tries `Sender`, then `SenderAlt`, then whatsmeow's LID map, and **drops the message** rather than guessing. Its sub-stores are nil until the device is paired, so the LID map must be looked up per call, never captured at construction.
- **The bridge container runs as uid 1000**, matching the server image's `node` user, because both mount the staging volume: the bridge creates files there and the server unlinks them once read. Unlinking needs write permission on the *directory*, so mismatched uids mean the server reads every photo fine and silently leaks all of them (`releaseMedia` swallows errors by design).
- The webhook must ACK fast: the bridge's outbox is strictly sequential, so a slow handler stalls every message behind it. Debouncing and agent work happen on the async worker path only.
- Agent replies and prompts are Spanish; code, comments, and prompt *instructions* are English.

## Testing conventions

Vitest in `server/test/`, in-memory SQLite (`openDb(":memory:")`) per test. The batcher suite uses `vi.useFakeTimers()` + `advanceTimersByTimeAsync` and a `harness()` with injectable `onMessage`/`onBatchFailure`. `agent.test.ts` mocks only the SDK's `query` (`vi.hoisted` + `vi.mock`) so the real MCP tool server still builds. Behavior-motivated regression tests are the house style — e.g. the batcher pins the real 37-photo burst timeline that motivated the adaptive window, including a negative test proving the rejected 30s window would have split it.

The bridge has its own Go suite (`go test ./...` from `bridge/`), covering the outbox's ordering and durability and every branch of LID resolution. One fixture spans both languages: the HMAC vector in `bridge/delivery_test.go` and `server/test/webhook.test.ts` is the same secret, body, and signature, because the bridge signs in Go and the server verifies in Node — nothing else proves the two agree, and a one-sided change would break every inbound message with both suites still green.
