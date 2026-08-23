# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vitrina: a WhatsApp-native inventory assistant for a **Shopify** store. One npm workspace plus a Go sidecar:

- `server/` — Fastify + Claude Agent SDK. Receives WhatsApp webhooks, runs agent turns, talks to the Shopify Admin API, and owns a small SQLite schema.
- `bridge/` — Go sidecar (whatsmeow). The WhatsApp transport; **not** an npm workspace. See "The WhatsApp transport" below.

**The catalog is Shopify.** There is no local products table, no storefront of our own, and no sync layer. SQLite holds only what Shopify has no place for: the durable inbox, agent sessions, contacts, captured leads, and inbound photos on their way to a product. A previous incarnation of this repo was a real-estate assistant with its own Next.js storefront and a SQLite catalog; `docs/shopify-adaptation.md` records what that transformation cost and why each piece landed where it did.

Milestone 1 is inventory: full CRUD over products, variants, stock and photos. There is no checkout — the customer path answers questions and captures leads.

## Commands

```bash
npm run test -w server                 # vitest suite (from repo root)
npx vitest run test/rank.test.ts       # single file (run from server/)
npx vitest run -t "idempotency"        # tests matching a name
npm run build -w server                # tsc --noEmit + emit build to dist/
npx tsc --noEmit                       # typecheck (run in server/)
npm run dev:server                     # local dev (tsx watch)

go test ./...                          # bridge suite (run from bridge/)
go build ./... && go vet ./...         # bridge typecheck
```

Docker: **`docker compose up`/`run` MUST go through `./scripts/with-secrets.sh`** — it injects the ANTHROPIC, BRIDGE and SHOPIFY secrets from gopass. `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_TOKEN` are interpolated with no default, so a bare `up` starts a server that fails its boot check. `docker compose build` works bare. Non-secret per-deploy config lives in `.env` (auto-loaded by compose; see `env.sample`). The bridge is never published and never gets a Coolify domain — anyone who can reach `/send` can send WhatsApp messages as the business.

## Message pipeline (the core architecture)

One inbound WhatsApp message travels: `inbox/webhook.ts` (HMAC verify over raw body → persist to `inbox` table with UNIQUE dedupe key → fast ACK) → `inbox/batcher.ts` (`InboxBatcher` debounces a phone's burst into ONE agent turn; the window is adaptive — bursts containing photos wait much longer because WhatsApp uploads photo sets in waves) → `inbox/queue.ts` (`PerPhoneQueue` serializes turns per phone; **this serialization is what makes `claimInboxBatch` safe** — batches for one phone must never overlap) → `agent/agent.ts` (`runAgentTurn`) → reply via `whatsapp/bridge.ts`, which POSTs to the sidecar's `/send`.

Delivery is at-least-once: rows are `pending`/`processing`/`done`/`failed`; unfinished rows are replayed on boot (`replayPending`), and a failed batch retries with backoff up to `MAX_BATCH_ATTEMPTS` total attempts tracked in `inbox.attempts` (incremented at claim time, so the cap survives restarts and stops poison-message boot loops). User-facing failure side effects (apology) fire only on the terminal attempt via the batcher's `onBatchFailure` hook in `index.ts`.

## The Shopify layer (`server/src/shopify/`)

- **`client.ts`** — GraphQL over native `fetch`, `fetchImpl` injectable (the pattern `agent/transcribe.ts` and `agent/preflight.ts` already established), so the whole tool suite is testable against a plain function with no network and no casts. It exists to handle two failure shapes that are easy to miss, because **both arrive as HTTP 200**: cost throttling (`errors[].extensions.code === "THROTTLED"`, retried with backoff) and business-rule rejection (`userErrors`, a *response field* — `assertNoUserErrors` must be called on every mutation payload or a rejected price change is reported to the owner as success).
- **`catalog.ts`** — the operations. Reads flatten Shopify's connections into our own types; money is passed through as the decimal **string** Shopify returned, and `toMoneyString` is the only place a number becomes money, so no stored price is ever rebuilt from a float.
- **`rank.ts`** — the Spanish relevance scorer, ported from the real-estate build. Shopify's `products(query:)` has no accent folding, no typo tolerance and **no comparable score**, so it ranks a fetched set instead. This is what puts `match=NN%` on every result line and raises the `APPROXIMATE MATCHES ONLY` warning.
- **`cache.ts`** — a short-lived read-only catalog snapshot, used ONLY as a corpus for `rank.ts`. Not a mirror: no write-back, no reconciliation, disposable. `catalog.refreshProducts` re-reads price and stock live for the products actually shown.

## Role boundary (owner vs customer)

`OWNER_PHONE_NUMBERS` (env allowlist, E.164 digits without `+`) decides the role in `config.isOwner`. The boundary is enforced twice, and both layers have pinning tests. It matters more here than it did over a read-only storefront: an owner tool reaching a customer is a stranger repricing a live store, or deleting a product out of it.

- **Tools** (`agent/tools.ts` `buildToolServer`): customers get `search_catalog`, `get_product`, `save_lead` and nothing else; owner tools are added only for the owner role. Pinned in `test/tools.test.ts`, including a prefix check so a future `set_price` cannot slip into the customer set unnoticed.
- **Persona** (`agent/agent.ts` `systemPrompt`): the customer branch explicitly refuses inventory conversations and ignores "I am the owner" claims — role comes from the phone number, never from what the person says. Pinned in `test/agent.test.ts`.

`get_product` is one tool name with two closures, chosen by `ctx.role`: the customer's returns "no product found" for a non-`ACTIVE` product, because confirming that a hidden product exists is itself a leak.

`CUSTOMER_AGENT_ENABLED=false` disables the customer path entirely (static reply, no Claude call). Owners are exempt from it and from rate limits.

## Agent sessions

The per-phone session id lives in SQLite (`sessions` table), but the Agent SDK's transcripts live under the container's home dir — persisted by the `vitrina-sessions` volume. If a resume fails, `runAgentTurn` clears the id and retries ONCE fresh (only when a resume was in play — without one the failure is real and must surface).

Sessions are isolated by phone (`sessions.phone` is the primary key) and expire after `SESSION_MAX_AGE_DAYS` of **silence** — a sliding window, since `setSessionId` refreshes `updated_at` every turn. Context growth is bounded by the SDK's own auto-compaction, so do NOT build a compaction layer. Dropping a session id orphans its transcript, so `runHousekeeping` sweeps transcripts that no session row references AND that are past the expiry window — the age check closes a race, since a turn in flight has no row pointing at it yet. `data/purge-sessions.ts` is the ops lever that drops customer histories on demand; it keeps owner sessions, because an owner mid-listing would lose in-progress work.

Tools communicate back to `runAgentTurn` only through the shared mutable `TurnContext` (`ctx.sessionAfterTurn = "reset"` — set on a publish transition, applied AFTER the turn; a mid-turn `clearSessionId` would be clobbered by the post-turn persist). Publishing resets the conversation so product N cannot bleed into product N+1.

## Invariants that are easy to break

- **A stock `delta` is not idempotent, and delivery is at-least-once.** A retried batch would remove six shirts where the owner sold three, with nothing recording it. Two defences and both are load-bearing: `TurnContext.turnKey` (minted in `batcher.ts` from the FIRST inbox row of the batch — stable across retries even as the batch absorbs newer messages) becomes Shopify's `@idempotent` key, and the owner prompt prefers `set_to` (a compare-and-set against the current count) whenever the owner's words give the resulting number. The key is suffixed with a per-turn counter, because two adjustments in one turn would otherwise share it and Shopify would discard the second as a duplicate.
- **`status: ACTIVE` does not publish.** Putting a product on the storefront is a separate operation (`publishToOnlineStore` → `publishablePublish`). A flow that sets ACTIVE, reports success, and leaves the product invisible is the most plausible wrong-but-plausible bug here — which is why the tool reports which of the two actually happened, and why `publishToOnlineStore` returns `false` rather than throwing (the status change already succeeded; throwing would replay the whole turn over a reporting detail).
- **`update_product` is a merge, not a rewrite.** Only keys present in the input are sent. `tags` is the exception — it REPLACES the whole list, which the tool description and the prompt both say, because an agent that does not know it will silently drop every other tag.
- **`createProduct` deliberately does NOT use `productSet`.** `productSet` is declarative over the whole product: variants absent from the input are deleted. Right for a sync job, exactly wrong behind a chat agent, where a model re-sending a payload it half remembers would silently drop every variant it forgot to mention.
- **`resolveProduct` never falls through to a text search.** gid → SKU → handle, then `null`. A fuzzy match that then feeds `delete_product` is how the wrong product gets deleted; `delete_product` additionally requires the caller to echo the product's exact handle.
- **`rank.ts` filters on numbers and SCORES on text, and the two must not converge.** Price and stock exclude outright — an item at five times the budget is the wrong item, and one that is sold out cannot be bought at any relevance. `query` only ranks, because prose arrives however the person happened to say it. Results carry a `match` percentage precisely because a hit is a candidate, not proof, and the tool result says so on every call, since a system prompt sits far back in a resumed transcript.
- **Photos upload strictly one at a time.** Arrival order is the order the owner shot them in and the first becomes the product's cover; a concurrent map would be faster and would silently shuffle the gallery. `listPendingMedia` deliberately does not claim rows — only the ids that actually uploaded are marked, so a partial failure leaves the rest claimable.
- **`config.ts` must stay at `src/` root.** It computes `REPO_ROOT` from `import.meta.url` with a hardcoded parent-segment count (`../../`). Moving it changes the depth and silently breaks every data path at runtime, not at compile time.
- **`buildAgentEnv` writes every knob it owns, including to `undefined`.** A conditional spread leaves whatever the shell already had sitting in the environment and the CLI reads that — so a deployment whose config says thinking is OFF would quietly run and bill for it because a stray variable outvoted the config. Same reasoning as the credential pair right above it.
- **ESM with explicit `.js` extensions** in all server imports; `server/tsconfig.build.json` has `rootDir: "src"`. No barrel files.
- **Entry-point paths are referenced outside the code**: `server/dist/data/backup.js` and `server/dist/data/purge-sessions.js` appear in `compose.yaml` commands and `server/package.json` scripts. Moving an entry point means updating both.
- **`AGENT_TRANSCRIPTS_DIR` must never get a default.** The Agent SDK stores transcripts at `$HOME/.claude/projects/<cwd-with-slashes-as-dashes>/`, which on a developer's machine is the same directory as *their own* Claude Code history for this repo — a default would make the transcript sweep delete real work. Compose sets it explicitly; unset, the sweep is inert (`data/transcripts.ts`).
- **`loadDotEnv` anchors at `REPO_ROOT`, not the cwd**, and swallows a missing file. `npm run <script> -w server` runs from `server/`, so a cwd-relative `.env` silently misses and every variable falls back to its default — which for `OWNER_PHONE_NUMBERS` means an empty allowlist and every phone reading as a customer. The purge tool refuses to run on an empty allowlist for exactly this reason.
- **A LID is not a phone number.** WhatsApp addresses senders as `<id>@lid`, and those digits look exactly like a phone number to `normalizePhone` — so a LID reaching the server misses `OWNER_PHONE_NUMBERS` and the owner silently reads as a *customer*, while a reply addressed back to it goes to whoever really owns those digits. `bridge/inbound.go` `resolvePhone` tries `Sender`, then `SenderAlt`, then whatsmeow's LID map, and **drops the message** rather than guessing. Its sub-stores are nil until the device is paired, so the LID map must be looked up per call, never captured at construction.
- **The bridge container runs as uid 1000**, matching the server image's `node` user, because both mount the staging volume: the bridge creates files there and the server unlinks them once read. Unlinking needs write permission on the *directory*, so mismatched uids mean the server reads every photo fine and silently leaks all of them (`releaseMedia` swallows errors by design).
- The webhook must ACK fast: the bridge's outbox is strictly sequential, so a slow handler stalls every message behind it. Debouncing, agent work and every Shopify call happen on the async worker path only.
- Agent replies and prompts are Spanish; code, comments, docs and prompt *instructions* are English.

## The WhatsApp transport (`bridge/`)

Messages travel through a Go sidecar that pairs as a **linked device** and speaks the WhatsApp Web multidevice protocol via [whatsmeow](https://github.com/tulir/whatsmeow). No WhatsApp Business onboarding, no per-conversation fee, and **no official standing with Meta** — the paired number carries real ban risk, and it is unlinked whenever the primary phone stays offline past WhatsApp's window. That last one is a *silent* failure: the process keeps running and simply stops receiving, so watch the bridge's `/status`, not its `/health`.

The sidecar knows nothing about products, owners, or agents. It POSTs inbound events to the server's `/webhook` (HMAC-SHA256 over the raw body) and accepts replies on an internal `/send`.

**`WhatsAppChannel`** (`whatsapp/channel.ts`) is the seam: `sendText` + `downloadMedia(ref)`, plus optional `releaseMedia`. `BridgeChannel` is its only implementation, and the interface stays because it is what lets the whole pipeline be tested with a plain object — no HTTP client, no paired device, no casts.

**Media never crosses HTTP between our own services.** whatsmeow decrypts it in the sidecar, which writes the plaintext into a staging directory both containers mount and hands over a *path*. `isAllowedMediaPath` confines that path to the staging directory — the ref arrives in a signed body, but a signature proves origin, not good behaviour, and the value is fed straight to `readFile`. (It does now cross the network on the way OUT, to Shopify — see the photo-order invariant above.)

The bridge owns an **outbox** (`bridge/outbox.go`) because whatsmeow acks to WhatsApp the moment an event is handled: anything not durable at that instant is lost, and it never reaches the `inbox` table for `replayPending` to recover. Delivery is strictly sequential by insertion id — photo order is listing order, and a concurrent dispatcher would silently reorder the owner's photo set. One event per POST, which is why the server's webhook handles a single event rather than a batch.

## Testing conventions

Vitest in `server/test/`, in-memory SQLite (`openDb(":memory:")`) per test. Nothing reaches the network: the Shopify suites drive a fake `fetch` and assert on the **recorded calls**, because what this layer gets wrong is not parsing a response, it is sending the wrong mutation or dropping a field. `agent.test.ts` mocks only the SDK's `query` (`vi.hoisted` + `vi.mock`) so the real MCP tool server still builds, and gives it a `fetch` that throws — if a change ever does reach the network from there, it fails loudly instead of hitting a real store.

The batcher suite uses `vi.useFakeTimers()` + `advanceTimersByTimeAsync` and a `harness()` with injectable `onMessage`/`onBatchFailure`. Its voice-note group must `drain()` the `PerPhoneQueue` rather than guess a tick count: the flush awaits a real `unlink()`, which is libuv I/O that fake timers do not control, and guessing made the whole group order-dependent.

Behavior-motivated regression tests are the house style — e.g. the batcher pins the real 37-photo burst timeline that motivated the adaptive window, including a negative test proving the rejected 30s window would have split it.

The bridge has its own Go suite (`go test ./...` from `bridge/`), covering the outbox's ordering and durability and every branch of LID resolution. One fixture spans both languages: the HMAC vector in `bridge/delivery_test.go` and `server/test/webhook.test.ts` is the same secret, body, and signature, because the bridge signs in Go and the server verifies in Node — nothing else proves the two agree, and a one-sided change would break every inbound message with both suites still green.
