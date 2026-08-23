# Adapting Vitrina to a Shopify inventory

> **Status update.** This was written as an exploration, before any code.
> **Milestone 1 is now built** — phases 0–6 of §10, minus the checkout (§5D),
> which was deferred with the rest of the customer-buys path. Where the
> implementation departed from the plan below, the departure is noted inline.
> `README.md` and `CLAUDE.md` describe what actually exists; this file is kept
> as the reasoning behind it, and §9 and §11 are still the open questions.

**Originally: exploration, nothing built.** This is the map of what a
Shopify-backed Vitrina would cost and what it would break, written before any
code, so the expensive surprises are on paper rather than in a branch.

The short answer: **the pipeline transfers almost entirely, the catalog does
not.** Everything between "a WhatsApp message arrives" and "the agent decides
what to do" — bridge, HMAC webhook, inbox durability, batching, per-phone
serialization, rate limits, sessions, transcription — is domain-free and moves
across unchanged. What has to be rebuilt is the layer underneath the agent's
tools: `server/src/data/repo.ts`, the tool schemas in `server/src/agent/tools.ts`,
and the two system prompts in `server/src/agent/agent.ts`.

---

## 1. The decisions this document assumes

| | Choice | Consequence |
|---|---|---|
| **Source of truth** | Shopify | No sync layer, no reconciliation, no drift. Every catalog read is a network call. |
| **Owner can** | adjust stock and prices; create products with photos | Needs `write_products`, `write_inventory`, `read_locations` |
| **Customer can** | search, get a checkout link, leave a lead | Needs `read_products`, `write_draft_orders`; leads stay local |
| **Storefront** | Shopify's own | `web/` is deleted from the fork. So are anonymous share links. |
| **Repo** | fork, real estate untouched | The pipeline gets maintained twice. Accepted deliberately. |

---

## 2. What survives, what dies, what is new

This is the honest inventory. "Survives" means *copied across with no edit
beyond imports*.

### Survives untouched (~70% of `server/src`)

| Area | Files |
|---|---|
| Transport | all of `bridge/` (Go), `server/src/whatsapp/*` |
| Ingestion | `inbox/webhook.ts`, `inbox/whatsmeow.ts`, `inbox/batcher.ts`, `inbox/queue.ts`, `inbox/rate-limit.ts`, `inbox/alerts.ts` |
| Agent plumbing | `agent/agent.ts`'s `buildAgentEnv` / `runQuery` / `runAgentTurn` / `TurnStats`, `agent/preflight.ts`, `agent/transcribe.ts` |
| Ops | `data/backup.ts`, `data/transcripts.ts`, `data/purge*.ts`, housekeeping in `index.ts` |
| Config | `config.ts`'s helpers (`required`, `optionalInt`, `optionalBool`, `normalizePhone`, `isOwner`, `loadDotEnv`) and the entire owner-allowlist role model |

14 of the 19 unit test files in `server/test/` come across green with no edit:
`batcher`, `inbox`, `queue`, `rate-limit`, `alerts`, `webhook`,
`extract-inbound`, `bridge`, `config`, `preflight`, `purge`, `transcripts`,
`agent-env`, and the session-fallback half of `agent.test.ts`.

### Deleted in the fork

- `web/` entirely — Shopify serves the storefront. With it go
  `agent/anon-token.ts`, `agent/preview.ts`, `web/lib/anon.ts`,
  `anon-token.test.ts`, `preview.test.ts`, and the `ANON_*` /
  `STOREFRONT_BASE_URL` config.
- `server/src/seed/` and `propiedad_1/`, `propiedad_2/` — the seed is a
  hand-written real-estate fixture loader, not a generic importer. Shopify
  already holds the data.
- The product half of `data/repo.ts` and its `products` / `product_photos` /
  `product_changes` tables.
- `server/src/tools/tasks.ts`'s real-estate scoring fixtures.

### Rewritten

| File | What changes |
|---|---|
| `server/src/agent/tools.ts` | Every tool's schema and body. Role boundary logic is kept verbatim. |
| `server/src/agent/agent.ts` | Only `systemPrompt()` — both branches. The rest is untouched. |
| `shared/index.d.ts` | `ProductAttributes` → a retail shape (or dropped in favour of metafields) |
| `server/src/config.ts` | New Shopify block; `STOREFRONT_BASE_URL` / `ANON_*` removed |
| `server/src/data/db.ts` | Product tables dropped; `inbox`, `sessions`, `leads`, `contacts`, `pending_media` stay |

### New

- `server/src/shopify/client.ts` — a thin GraphQL client over native `fetch`.
- `server/src/shopify/catalog.ts` — the product/inventory operations.
- `server/src/shopify/cache.ts` — a short-lived read-through catalog cache
  (see §6, this is the piece that keeps search usable).
- Optionally `server/src/shopify/webhooks.ts` — inbound Shopify webhooks for
  proactive owner alerts (see §9).

---

## 3. Architecture after the swap

```
Customer / Owner (WhatsApp)
        │
        ▼
  bridge (Go, whatsmeow) ──webhook (HMAC, one event)──►  server (Fastify)
        ▲            │                                    verify · dedupe · ACK
        │            └── decrypts media ──► /data/inbound        │
        │                                   (shared volume)      ▼  async worker
        └──── POST /send ◄─────────────────────────────┐   Claude Agent SDK
                                                       │        │
                                                       │        ▼
                                                       │   MCP tools (in-process)
                                                       │        │
                                       ┌───────────────┘        ├──► SQLite
                                       │  reply                 │    inbox · sessions
                                       │                        │    leads · contacts
                                       │                        │    pending_media
                                       │                        │
                                       │                        └──► Shopify Admin API
                                       │                             (GraphQL, 2026-01)
                                       │                              products · variants
                                       │                              inventory · media
                                       │                              draft orders
                                       │
   Shopify ──webhook (HMAC)──► server ─┘   orders/create, inventory_levels/update
   (optional, §9)                           → proactive owner alerts
```

The seam is `server/src/shopify/`. It follows the pattern already proven twice
in this repo (`agent/transcribe.ts`, `agent/preflight.ts`): a plain `fetch`,
config narrowed with `Pick<Config, …>`, and an injectable `fetchImpl` so the
whole tool suite can be tested with a fake — no network, no store, no casts.
That is the same trick `WhatsAppChannel` plays for the bridge, and it is what
makes the existing suite fast.

---

## 4. Concept mapping — and the four places it does not fit

| Vitrina today | Shopify | Fit |
|---|---|---|
| `products.code` (owner-assigned, e.g. `1912`) | `handle`, variant `sku`, or a unique metafield | **Needs a decision.** See below. |
| `products.title` / `description` | `title` / `descriptionHtml` | Clean |
| `products.price` (INTEGER COP) | `variants[].price` (decimal string) | **Mismatch.** See below. |
| `products.status` (draft/active/sold/inactive) | `status` (ACTIVE/DRAFT/ARCHIVED) + publication | **Mismatch.** See below. |
| `products.attributes` (free JSON) | metafields | Mostly clean; typed, needs definitions |
| `product_photos` | product media (`productCreateMedia`) | Clean, but photos now leave the network. §7. |
| `product_changes` (audit) | — | Stays local. Shopify's own event log is not queryable the same way. |
| no variants, no quantity | variants + inventory levels per location | **New concept the agent has never had.** |
| `leads`, `contacts` | Shopify customers (partially) | Keep local. Simpler and already tested. |

### 4.1 `code` — the identity anchor

The whole product depends on the owner saying *"el código ya es 1912"* and the
agent finding the right record. Three candidates:

- **variant `sku`** — the natural retail equivalent, already how the owner
  thinks about stock, and searchable via `productVariants(query: "sku:…")`.
  **Recommended.**
- **`handle`** — unique and directly addressable, but it is also the storefront
  URL, so an owner renaming a code rewrites a public link.
- **a unique metafield**, addressed through `ProductSetIdentifiers.customId` —
  cleanest conceptually. Confirm it is supported in the pinned API version
  before relying on it.

Whatever is chosen, it must be a **single** anchor: today `getProductByCode` is
one indexed lookup, and every tool depends on it being unambiguous.

> **As built:** all three, in a fixed order — gid, then SKU, then handle
> (`catalog.ts` `resolveProduct`). The requirement turned out to be
> unambiguity, not singularity: each form is unique on its own, the order is
> deterministic, and nothing falls through to a text search, so a reference
> either resolves to exactly one product or returns null. SKU is tried before
> handle because it names a single *variant*, which is what a stock or price
> question is actually about.

### 4.2 Money

`products.price` is an `INTEGER` of whole COP. Shopify returns money as a
decimal string with a currency code. COP conventionally carries no cents, but
the API will still hand back `"1150000.00"`. Parse to a minor-unit integer at
the client boundary — once, in `shopify/client.ts` — and never let a float
reach a tool result. Rounding a price in an agent reply that a customer then
pays is the kind of bug that gets noticed by the person paying.

### 4.3 Status

Four states collapse into three, and one of them is not a status at all:

| Vitrina | Shopify |
|---|---|
| `draft` | `status: DRAFT` |
| `active` | `status: ACTIVE` **and** published to the Online Store publication |
| `sold` | not a status — it is `inventoryQuantity == 0` |
| `inactive` | `status: ARCHIVED` (or ACTIVE but unpublished) |

Two consequences worth stating plainly:

- **`status: ACTIVE` alone does not make a product visible.** Publication to a
  sales channel is a separate operation. A publish flow that sets ACTIVE and
  reports success to the owner, while the product is invisible on the store,
  is the single most likely wrong-but-plausible bug in this migration.
- **"sold" becomes a live number, not a state.** That is an improvement — real
  estate had one unit, retail has a count — but it means the customer prompt
  must talk about availability rather than status, and `search_catalog` must be
  able to exclude out-of-stock results.

`isPublishTransition()` in `tools.ts` still applies: the moment a product goes
live is still the moment the agent's conversation should reset, because
product N must not bleed into product N+1.

---

## 5. The five functional flows

### A. Owner: check and adjust stock

**Tools:** `get_inventory(sku)`, `adjust_inventory(sku, delta | set_to, reason)`

> — ¿cuántas camisetas negras talla M me quedan?
> — Quedan 4 en Bodega Centro y 1 en Punto Envigado.
> — vendí 3 de las de bodega
> — Listo, quedan 1 en Bodega Centro.

Two different mutations, and picking the wrong one is a real bug:

- `inventoryAdjustQuantities` takes a **`delta`** — the right call for *"vendí
  3"*. It accepts an `@idempotent(key:)` directive.
- `inventorySetQuantities` takes an absolute **`quantity`** plus an optional
  `compareQuantity` — the right call for *"quedan 11"*, and `compareQuantity`
  gives optimistic concurrency: if someone sold one at the counter between the
  read and the write, the mutation fails instead of silently overwriting.

> **This is the sharpest new risk in the whole migration.** Vitrina's delivery
> is *at-least-once* by design: `inbox` rows are replayed on boot and a failed
> batch retries up to `MAX_BATCH_ATTEMPTS`. Today a retried batch re-runs an
> `upsert_product`, which is idempotent by construction — writing the same
> fields twice is the same as writing them once. **A stock `delta` is not
> idempotent.** A retry after a partial failure decrements the same three
> shirts twice, and nothing in the system will ever notice.
>
> The fix exists and is cheap: derive the mutation's `@idempotent` key from the
> `inbox` row's existing `dedupe_key`, which is already UNIQUE and already
> survives restarts. Prefer `inventorySetQuantities` with `compareQuantity`
> wherever the absolute number is knowable. This has to be designed in from
> the first line, not added after the first miscount.

Also needed: **locations**. Every inventory operation is per-location. A
single-location store can default to the first location and never mention it;
a multi-location store means the agent must ask *which* one, and the prompt
must never guess. `read_locations` scope.

### B. Owner: create a product with photos

The existing flow transfers directly. Photos arrive in a burst, land in
`pending_media` keyed by phone, and the owner later says *"esas son de la
camiseta negra"* → `attach_pending_photos`. `attachPendingPhotos()` in
`repo.ts` already preserves WhatsApp arrival order as gallery order, and the
bridge's strictly sequential outbox is what guarantees that order — both stay.

What changes is the destination. Instead of `insertPhoto` into SQLite:

1. `stagedUploadsCreate` → returns an upload URL + form parameters
2. multipart POST of the staged file bytes to that URL
3. `productCreateMedia(productId, media: [{ originalSource: resourceUrl }])`

Product creation itself looked like `productSet` — one mutation that creates or
updates a product *with* its options and variants, which is exactly the shape of
"the owner just described a product with three sizes".

> **As built: not `productSet`.** It is declarative over the whole product —
> variants absent from the input are *deleted*. That is right for a sync job and
> exactly wrong behind a chat agent, where a model re-sending a payload it half
> remembers would silently drop every variant it forgot to mention. Creation is
> `productCreate` + `productVariantsBulkCreate`; updates are `productUpdate` +
> `productVariantsBulkUpdate`, which merge.

> **The zero-bytes invariant is gone.** Today a 37-photo owner burst moves zero
> image bytes between services: the bridge decrypts into a shared volume and
> hands the server a *path*. That still holds between our own containers — but
> every one of those 37 photos now uploads to Shopify. That is 37 staged
> uploads inside one agent turn, against a rate-limited API, on a connection
> the owner is waiting on. Uploading must happen on the batcher's async worker
> with its own retry, not inline in a tool call — otherwise a slow upload
> stalls the reply and a failed one poisons the batch.

The variant question is new and unavoidable: real estate had one unit per
product; a shirt has sizes and colours. The owner prompt must be able to run a
short structured intake ("¿qué tallas? ¿mismo precio todas?") without turning
into a form — which is exactly what the current owner prompt's
"ONE question per message" rule is already tuned for.

### C. Customer: search the catalog

This is the hardest thing to preserve and it deserves its own section (§6).

### D. Customer: buy

**Tool:** `create_checkout(sku | product_code, quantity)`

`draftOrderCreate` returns an **`invoiceUrl`** — a secure Shopify checkout link
the customer opens and pays on. The agent sends the URL over WhatsApp. Payment,
taxes, shipping rates, and fraud checks all stay inside Shopify, which is the
entire reason to have chosen Shopify as the source of truth.

Scope: `write_draft_orders`.

Three things the prompt has to get right:

- **A draft order does not reserve stock.** Two customers can be handed links
  for the last unit. Shopify resolves it at checkout, but the agent must never
  promise "es tuyo" — only "aquí está tu link".
- **Availability must be checked at link time**, not from a cached search
  result three messages earlier.
- **The customer is a phone number, not an email.** Draft orders can carry a
  phone; `draftOrderInvoiceSend` is an *email* path and is the wrong tool here.
  Send `invoiceUrl` over the channel the conversation is already on.

### E. Customer: leave a lead

Unchanged. `save_lead` and the `leads` table stay local — they are already
tested, already cheap, and Shopify's customer object is a worse fit for "asked
about X, did not buy". The `type` enum changes from
`inquiry | visit_request` to something retail-shaped
(`inquiry | back_in_stock | abandoned`), which is a one-line `CHECK` constraint.

---

## 6. The one thing that genuinely gets worse: search

Vitrina's `searchCatalog` is not a database query. It is a Spanish-tuned
scorer in `data/repo.ts` that:

- normalizes accents (NFD, strip combining marks) so *"baños"* matches
  *"banos"*;
- strips Spanish catalog stopwords;
- builds a haystack of words **plus every adjacent pair glued together** —
  which is the fix for the real bug that motivated it: *"Llano Grande"*
  finding nothing while the catalog held *"Llanogrande"*;
- fuzzy-matches with a Levenshtein ratio ≥ 0.8 on tokens of 4+ characters, but
  never on pure digits (so `1912` never fuzzy-matches `1913`);
- returns a **normalized score**, which becomes `match=NN%` on every result
  line, and triggers a hard `APPROXIMATE MATCHES ONLY` warning prepended to the
  tool result when the best hit scores below `CONFIDENT_MATCH_SCORE = 0.8`.

That last point is a safety property, not a nicety. A system prompt sits far
back in a resumed transcript; the warning rides on *every* tool result, which
is why the agent does not confidently offer a house that merely resembles what
was asked for.

**Shopify's `products(query:)` gives none of this.** It is prefix/keyword
matching with no accent folding, no fuzzy tolerance, and — decisively — **no
comparable normalized score**. Pointing the tool straight at it silently
deletes the `match=NN%` contract and the approximate-match guard rail.

### Recommendation: keep the scorer, move the corpus

Shopify stays the source of truth. But `rankProducts()` — which is already a
pure function over `Product[]`, with no SQL in it — gets fed from a
**short-lived read-through cache** of the catalog rather than from SQLite:

```
search_catalog(query)
  → cache.getCatalog()          # in-memory, TTL ~60s, or a SQLite scratch table
      └─ miss → Shopify products(first: N) [+ bulk operation for large catalogs]
  → rankProducts(products, filters)     # unchanged, still pure, still tested
  → renderSearchHits(...)               # match=NN% and the warning survive
```

Then the *specific* facts that must never be stale — price and stock — are
re-read live from Shopify for the handful of products actually being shown,
and again at checkout-link time.

This is not the SQLite-mirror architecture that was rejected. There is no
write-back, no conflict resolution, no reconciliation job: the cache is
read-only, disposable, and rebuilt on a TTL or on a Shopify `products/update`
webhook. It costs one class (`shopify/cache.ts`) and it preserves the two
things that took real debugging to get right.

Above a few thousand products the full-catalog fetch stops being reasonable,
and the right move becomes a hybrid: Shopify's `query:` narrows the candidate
set, `rankProducts` scores what comes back. Worth measuring against the actual
catalog size before building either.

---

## 7. Operational realities that are new

| Concern | Detail |
|---|---|
| **Rate limits** | GraphQL Admin API is a leaky bucket of calculated query cost: **100 points/s** on Standard, 200 on Advanced, 1000 on Plus, and no single query may exceed 1,000 points. A 37-photo upload burst plus a catalog fetch inside one turn is well within reach of it. The client needs cost-aware backoff — the existing 30s batch-level retry is too coarse to be the only defence. |
| **Latency** | Every catalog read is now a round trip. Today `searchCatalog` is a local SQLite scan measured in microseconds. Budget it: the batcher already waits 8–45s for a burst, so one added second is invisible — five are not. |
| **Partial failure** | `productSet` can succeed while `productCreateMedia` fails, leaving a product with no photos. `userErrors` is a *response field*, not an HTTP error: a 200 OK with a populated `userErrors` array is a failure, and a client that only checks `res.ok` will report success on it. |
| **API versioning** | Shopify versions quarterly and deprecates on a rolling schedule. Pin the version in the client (`2026-01`) and treat a bump as a change with its own test run. |
| **Credentials** | A custom app installed from the store admin yields an Admin API access token, sent as `X-Shopify-Access-Token`. It goes in gopass alongside the others and flows through `scripts/with-secrets.sh` — same path as `ANTHROPIC_API_KEY` today. Scope it to exactly what the tools use. |
| **Blast radius** | Real estate's worst case was a wrong listing on a storefront. Retail's worst case is a wrong *price* or a wrong *stock count* on a live store that takes money. The owner-only tool boundary in `buildToolServer` — and its pinning test in `tools.test.ts` — matters more here than it did before, not less. |

---

## 8. New config surface

```bash
SHOPIFY_STORE_DOMAIN=mitienda.myshopify.com   # required
SHOPIFY_ADMIN_TOKEN=shpat_...                 # required, from gopass
SHOPIFY_API_VERSION=2026-01                   # pinned default
SHOPIFY_LOCATION_ID=gid://shopify/Location/…  # optional; default location
SHOPIFY_WEBHOOK_SECRET=...                    # optional, only for §9
CATALOG_CACHE_TTL_MS=60000                    # optional, §6
```

Removed: `STOREFRONT_BASE_URL`, `ANON_BASE_URL`, `ANON_SHARE_SECRET`,
`MEDIA_DIR`'s storefront role (it stays, but only as the staging area between
WhatsApp and Shopify, with a much shorter TTL).

`config.ts`'s existing helpers cover all of these — `required`, `optional`,
`optionalInt`. Note the invariant that `config.ts` must stay at `src/` root:
it computes `REPO_ROOT` from `import.meta.url` with a hardcoded parent-segment
count.

---

## 9. What Shopify makes possible that is not possible today

These are not required by the four decisions above, but they are the reason
this migration is more than a lateral move:

- **The store already exists.** No storefront to build, host, brand, or keep in
  sync — and checkout, taxes, and payments are solved rather than deferred.
  Vitrina's current design explicitly has no payments.
- **Inbound Shopify webhooks** (`orders/create`, `inventory_levels/update`,
  `products/update`) let the agent become *proactive* — "se vendió la última
  camiseta negra M", "quedan 2 de X" — pushed to the owner over WhatsApp
  without them asking. The server already has an HMAC-verified webhook
  endpoint and a durable inbox; this is the same shape with a different
  signature scheme.
- **Order history per customer** turns `save_lead` into something with
  follow-through: back-in-stock notifications, reorder prompts.
- **Multi-location stock** — a real question for a shop with a warehouse and a
  counter, and one the current single-unit product model cannot express at all.

One option worth *evaluating* rather than assuming: Shopify publishes its own
MCP tooling. Since the agent already speaks MCP, pointing it at an external
Shopify MCP server is conceivable — but it would hand the model a tool surface
nobody in this repo controls, and the owner/customer boundary in
`buildToolServer` is enforced precisely by controlling which tools exist per
role. Verify what is actually offered before treating it as a shortcut; the
in-process tool server is the safer default.

---

## 10. Shape of the work

Rough sizing, in the order the pieces depend on each other. These are
estimates for focused work, not commitments.

| Phase | Work | Rough size |
|---|---|---|
| 0 | Fork the repo, delete `web/`, `seed/`, `propiedad_*`, the product tables and the real-estate fixtures. Get the surviving 14 test files green. | ~½ day |
| 1 | `shopify/client.ts`: GraphQL over `fetch`, injectable `fetchImpl`, money parsing, `userErrors` handling, cost-aware backoff. Unit tests with a fake `fetch`. | ~1 day |
| 2 | Read path: `get_product`, `list_products`, `search_catalog` + `shopify/cache.ts`, `rankProducts` ported over. This is where the `match=NN%` contract is either preserved or lost. | ~1½ days |
| 3 | Write path: `upsert_product` → `productSet`; `adjust_inventory` with the idempotency key wired to `inbox.dedupe_key`; publish transition including sales-channel publication. | ~2 days |
| 4 | Media: staged uploads on the async worker, `attach_pending_photos` retargeted, retry and partial-failure handling. | ~1 day |
| 5 | Checkout: `create_checkout` → `draftOrderCreate` → `invoiceUrl`. Availability re-check at link time. | ~½ day |
| 6 | Prompts: rewrite both branches of `systemPrompt()` for retail. Re-pin `agent.test.ts`'s persona assertions. Rebuild `tools/tasks.ts` as a retail scoring set and run the provider comparison. | ~1½ days |
| 7 | Optional: Shopify inbound webhooks for proactive owner alerts. | ~1 day |

**Roughly 8–9 days to a working pilot**, with phases 2 and 3 carrying nearly
all the risk.

## 11. What to decide before starting

1. **The identity anchor** — `sku`, `handle`, or metafield (§4.1). Everything
   downstream assumes one unambiguous lookup.
2. **Catalog size and locations.** Both change the search design (§6) and the
   inventory prompt (§5A). A 50-product single-location shop and a
   5,000-product two-warehouse shop are different builds.
3. **Whether the customer agent sells or refers.** A checkout link is a
   commitment to getting availability right in real time; a link to the product
   page on the store is not. Both are supported by the plan; the first is
   strictly more work and more risk.
4. **Whether the fork is really a fork.** `PROPOSAL.md` already describes the
   configurable-vertical target ("a tenant = one business", "launching a new
   vertical = writing a new template, not new code"). It was never built. The
   fork is the right call for a pilot, but the second time a bug is fixed twice
   in `batcher.ts` is the moment to reconsider.

---

## Sources

- [Shopify GraphQL Admin API reference](https://shopify.dev/docs/api/admin-graphql/latest)
- [`productSet`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/productSet) ·
  [`productUpdate`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/productUpdate)
- [`inventoryAdjustQuantities`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventoryAdjustQuantities) ·
  [`inventorySetQuantities`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventorySetQuantities)
- [`stagedUploadsCreate`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/stagedUploadsCreate) ·
  [`productCreateMedia`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/productCreateMedia)
- [`draftOrderCreate` payload](https://shopify.dev/docs/api/admin-graphql/2026-01/payloads/DraftOrderCreatePayload) ·
  [`draftOrderInvoiceSend`](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/draftOrderInvoiceSend)
- [Shopify API rate limits](https://shopify.dev/docs/api/usage/limits)
- [Access tokens for custom apps](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin)
