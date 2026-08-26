# Vitrina

A WhatsApp-native **inventory assistant for a Shopify store**. One WhatsApp
number becomes the store's admin panel: the owner creates products, changes
prices, moves stock and uploads photos by chatting in natural language, and
customers search the same catalog and get answers grounded in live data.

The catalog is **Shopify**. There is no local products table and no storefront
of our own — the store already is one. SQLite keeps only what Shopify has no
place for: the durable inbox, agent sessions, captured leads, and inbound photos
on their way to a product.

> **Language:** the assistant replies in neutral, professional Spanish.
> All code, identifiers, comments and docs are in English.

> **Milestone 1** is inventory: full CRUD over products, variants, stock and
> photos. There is no checkout — the customer path answers questions and captures
> leads. See `docs/shopify-adaptation.md` for what comes after.

---

## Architecture

Monorepo with npm workspaces:

```
package.json          # workspaces: ["server"]
env.sample            # copy to .env and fill in  (see note below)
server/               # Fastify + Claude Agent SDK + SQLite  (the brain)
bridge/               # Go sidecar: the WhatsApp transport (whatsmeow)
data/                 # created at runtime: vitrina.db + media/  (git-ignored)
```

```
Customer / Owner (WhatsApp)
        │
        ▼
  bridge (Go, whatsmeow) ──webhook (HMAC, one event)──►  server (Fastify)
  linked device, not the Cloud API                        1. verify + dedupe
        ▲            │                                    2. read staged media
        │            └── decrypts media ──► /data/inbound  3. enqueue per-phone, ACK
        │                                   (shared volume)     │  async worker
        └──── POST /send (text) ◄──────────────────────────┐    ▼
              internal network only                        │  Claude Agent SDK
                                                           │  session per phone (resumable)
                                                           │  role: owner | customer
                                                           │  in-process tools ↓
                                                           │         │
                                             ┌─────────────┴─────────┴────────┐
                                             ▼                                 ▼
                                    SQLite (better-sqlite3)         Shopify Admin API
                                    inbox · sessions · leads        products · variants
                                    pending photos                  inventory · media
```

The bridge pairs a real number as a **linked device**. That means no WhatsApp
Business onboarding and no per-conversation fee — and no official standing with
Meta, so the number carries genuine ban risk and is unlinked if the primary
phone stays offline too long. See `bridge/` and CLAUDE.md.

### server/ — the brain

- `src/config.ts` — env loading, role detection (`OWNER_PHONE_NUMBERS` allowlist), and the Shopify block. Fails fast: a missing store domain or token dies at boot rather than on the owner's first message.
- `src/data/db.ts` — SQLite (WAL), schema created on boot. No catalog tables.
- `src/data/repo.ts` — leads, contacts, sessions, the inbox, and pending photos.
- `src/whatsapp/channel.ts` — the transport seam: `sendText`, `downloadMedia(ref)`, optional `releaseMedia`. Outbound is text-only on purpose — photos go to Shopify, never back into the chat. `WHATSAPP_PROVIDER` picks which implementation runs.
- `src/whatsapp/cloud.ts` — Meta's official Business Cloud API: sends through Graph, resolves a media id to a short-lived URL and downloads it (`isAllowedMediaHost` keeps the access token on Meta hosts), and names error 131047 for what it is — a reply outside the 24h window.
- `src/whatsapp/bridge.ts` — the linked-device sidecar: posts replies to it, reads staged media off the shared volume (`isAllowedMediaPath` confines it), sweeps files orphaned by a crash.
- `src/inbox/cloud.ts` — parses Meta's payload into `InboundMessage[]` (one POST can carry many), skips delivery statuses, and surfaces the failed ones.
- `src/inbox/whatsmeow.ts` — parses the bridge's event shape into an `InboundMessage`.
- `src/inbox/webhook.ts` — `POST /webhook`: HMAC verify (raw body), persisted inbox (dedupe + at-least-once: unfinished messages are replayed on boot), and a fast ACK. It records a *reference* to any inbound file and downloads nothing — the fetch happens on the worker (`batcher.resolveMedia`), because both transports punish a slow handler. Plus `GET /webhook`, Meta's verification handshake, registered only on the Cloud API.
- `src/inbox/batcher.ts` — coalesces each phone's message burst into ONE agent turn (`BATCH_DEBOUNCE_MS` of silence, `BATCH_MAX_WAIT_MS` ceiling) and settles its inbox rows. Also mints the turn key that makes a stock adjustment safe to retry.
- `src/inbox/queue.ts` — in-process FIFO with per-phone serialization.
- `src/agent/agent.ts` — Claude Agent SDK integration: resume per-phone session (idle sessions expire after `SESSION_MAX_AGE_DAYS`; an unresumable session falls back once to a fresh one), run tools, reply in Spanish. `systemPrompt` holds both personas.
- `src/inbox/rate-limit.ts` — cost protection: per-phone sliding-hour limit + global daily cap for customer turns (owners exempt).
- `src/inbox/alerts.ts` — notifies the owner's WhatsApp after consecutive agent failures.
- `src/data/backup.ts` — consistent SQLite snapshot (online backup API) with pruning.
- `src/data/transcripts.ts` — the Agent SDK's transcripts on disk: delete one session's, or sweep the ones no session row can resume any more. Inert unless `AGENT_TRANSCRIPTS_DIR` is set, which it deliberately does not default (see the file's header).
- `src/data/purge.ts` / `src/data/purge-sessions.ts` — ops lever: drop every **customer** conversation history so they start fresh; owner sessions are kept. `docker compose --profile purge run --rm purge-sessions`, or `npm run purge:sessions -w server`.
- `src/agent/tools.ts` — in-process MCP tools, listed below. The tool server has no WhatsApp channel: tools read and write data, they never message the chat.
- `src/whatsapp/media.ts` — serves `MEDIA_DIR` under `/media/*`; saves inbound media.
- `src/index.ts` — wires everything; `GET /health`.

### server/src/shopify/ — the catalog

- `client.ts` — GraphQL over native `fetch` with an injectable implementation, so the whole tool suite is testable against a plain function. Handles the two failure modes that are easy to miss: cost **throttling arrives as a 200 OK** with `THROTTLED` in the errors array, and **`userErrors` is a response field**, so a rejected write also arrives as a 200.
- `catalog.ts` — the operations: resolve by SKU / handle / gid, list and page, create (`productCreate` + `productVariantsBulkCreate`), update (a merge — `productUpdate` and `productVariantsBulkUpdate`), delete, publish to the Online Store channel, locations, stock reads and writes, and staged photo uploads.
- `rank.ts` — the Spanish relevance scorer. Shopify's `products(query:)` has no accent folding, no typo tolerance and no comparable score, so it ranks a fetched set instead: this is what puts `match=NN%` on every result line and raises the approximate-match warning.
- `cache.ts` — a short-lived, read-only catalog snapshot for ranking. Not a mirror: no write-back, no reconciliation. Price and stock are re-read live for the products actually shown.

### The tools

| Tool | Role | What it does |
|---|---|---|
| `search_catalog` | both | Rank what is for sale, with live prices and stock |
| `get_product` | both | One product by SKU, handle or id (owners also see drafts) |
| `save_lead` | both | Capture an inquiry, a back-in-stock request, or a follow-up |
| `list_products` | owner | Inventory report across every status |
| `create_product` | owner | New product with options, variants, prices, opening stock |
| `update_product` | owner | Merge fields, change a variant's price/SKU, publish, archive |
| `delete_product` | owner | Permanent — guarded by a handle confirmation |
| `get_inventory` | owner | Live stock per variant, per location |
| `adjust_inventory` | owner | `set_to` (compare-and-set) or `delta` (idempotent per turn) |
| `attach_pending_photos` | owner | Upload this chat's photos, in arrival order |
| `list_locations` | owner | The store's inventory locations |
| `list_leads` | owner | What customers asked for |

Customers get the first three and nothing else. That boundary is structural —
the owner tools are never built for a customer turn — and pinned in
`test/tools.test.ts`.

---

## Setup

Requires **Node 20+** (developed on Node 25). No payments anywhere; no calendar integration.

### 1. Install

```bash
npm install
```

### 2. Environment

Preferred: secrets live GPG-encrypted in [gopass](https://github.com/gopasspw/gopass)
and are injected at runtime by the wrapper script — no `.env` needed for them
(setup in `docs/secrets-management.md`):

```bash
./scripts/with-secrets.sh npm run dev -w server
```

Fallback: a plain `.env` file still works everywhere:

```bash
cp env.sample .env      # then edit .env
```

> `env.sample` is the environment template. It is shipped as `env.sample` (not
> `.env.example`) only because this sandbox blocks writing `.env*` files — rename
> it to `.env.example` in your own repo if you prefer that convention.

Every variable is documented in `env.sample`. Key ones:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Runs the Claude model via the Agent SDK. |
| `BRIDGE_WEBHOOK_SECRET` | Shared with the bridge: it signs inbound events, the server verifies them. |
| `BRIDGE_API_TOKEN` | Bearer token for the bridge's `/send`. Anyone holding it can message as the business. |
| `BRIDGE_URL`, `BRIDGE_STAGING_DIR` | Where the sidecar lives, and the shared directory it stages decrypted media in. Set by compose. |
| `BRIDGE_PAIR_PHONE` | The number to pair, bare E.164 digits. Set it to pair by code instead of QR. |
| `OWNER_PHONE_NUMBERS` | Comma-separated allowlist (E.164 digits, no `+`) that gets the owner toolset. |
| `SHOPIFY_STORE_DOMAIN` | **Required.** The store's myshopify domain. A scheme and trailing slash are stripped, so pasting the address bar works. |
| `SHOPIFY_ADMIN_TOKEN` | **Required.** Admin API token from a custom app in the store admin. Scope it to `read/write_products`, `read/write_inventory`, `read_locations` — its blast radius is the whole catalog of a live store. |
| `SHOPIFY_API_VERSION` | Pinned Admin API version (default `2026-01`). Deliberate, not `latest`: an unpinned version is an agent that changes behaviour without a deploy. |
| `SHOPIFY_LOCATION_ID` | Default inventory location. Only needed with more than one — with several and this unset, the agent asks instead of guessing. |
| `CATALOG_CACHE_TTL_MS` | How long a fetched catalog stays usable for **ranking** (default 60000; `0` never caches). Price and stock are always re-read live for the products shown. |
| `DB_PATH`, `MEDIA_DIR` | Relative paths resolve to the **repo root**, so every workspace script agrees regardless of where it runs from. |
| `PUBLIC_BASE_URL` | Public URL of the server (a tunnel). Only used to serve inbound owner photos while they wait to be uploaded. |
| `RATE_LIMIT_PER_PHONE_PER_HOUR`, `RATE_LIMIT_GLOBAL_PER_DAY` | Cost protection for customer agent turns (defaults 20/hour per phone, 500/day global; owners exempt). |
| `CUSTOMER_AGENT_ENABLED` | Kill switch for the customer path (default `true`). `false` auto-replies that the assistant is unavailable — non-owner messages never reach the agent or spend a Claude call. |
| `SESSION_MAX_AGE_DAYS` | Conversations idle longer than this start a fresh agent session (default 7). |
| `BATCH_DEBOUNCE_MS`, `BATCH_MAX_WAIT_MS` | How long a phone's messages are coalesced into one agent turn: silence that ends a burst (default 8000) and the ceiling from its first message (default 45000). |
| `BATCH_MEDIA_DEBOUNCE_MS`, `BATCH_MEDIA_MAX_WAIT_MS` | The same two knobs once a burst contains photos (defaults 45000 / 120000) — WhatsApp delivers a photo set in waves tens of seconds apart. |

### 3. Connect the store

Create a **custom app** in the Shopify admin (Settings → Apps and sales channels
→ Develop apps), give it the four scopes above, install it, and copy the Admin
API access token into `SHOPIFY_ADMIN_TOKEN`.

There is nothing to seed: the catalog is whatever the store already holds. A
quick check that the credentials work:

```bash
curl -s -X POST \
  "https://$SHOPIFY_STORE_DOMAIN/admin/api/2026-01/graphql.json" \
  -H "X-Shopify-Access-Token: $SHOPIFY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ shop { name } products(first: 3) { nodes { handle title } } }"}'
```

An `errors` array naming a field means the token lacks that scope; a 401 means
the token is wrong.

### 4. Run

```bash
npm run dev:server     # Fastify on :3001
```

### 5. Pair the WhatsApp number

There is **no inbound webhook to expose and no dashboard to register**: the bridge
runs beside the server and posts to it over the internal network. Nothing from
the internet needs to reach `/webhook`.

```bash
# in .env
BRIDGE_PAIR_PHONE=573001112233        # bare E.164 digits, no '+'

./scripts/with-secrets.sh docker compose up -d --build
docker compose logs -f bridge          # an 8-character pairing code appears here
```

On the phone: **WhatsApp → Settings → Linked devices → Link with phone number**,
then type the code. It expires in about 160 seconds, so have the phone ready
before you start. Leave `BRIDGE_PAIR_PHONE` empty to get a QR code in the logs
instead.

Confirm it took:

```bash
docker compose exec bridge /bridge -status
# {"connected":true,"loggedOut":false,"pairedAs":"57300...:12@s.whatsapp.net",...}
```

The binary probes itself because the bridge publishes no port and the image has
no shell — there is nothing to `curl`, from outside or in. `-healthcheck` is the
same idea for liveness, and is what Docker runs.

> **You cannot test by messaging the paired number from that same number.**
> Those arrive with `IsFromMe` set and the bridge drops them, exactly as it drops
> its own outgoing messages — otherwise every reply would loop back in as a new
> message. Pair one number, message it from a different phone.

No tunnel is needed for messages, and none is needed for links either: product
URLs point at the Shopify store, which is already public. `PUBLIC_BASE_URL` only
matters for the `/media` route that holds inbound owner photos in transit.

---

## Testing walkthrough

Pair a **disposable number**, not the business line — this is an unofficial
client and a ban takes the number with it.

1. Pair as above and confirm `/status` shows `connected: true`.
2. Add your own phone number to `OWNER_PHONE_NUMBERS` to test the **owner** flow,
   or leave it out to test the **customer** flow.
3. Message the paired number from WhatsApp.

**Customer example**

```
You:  Hola, tienen camisetas negras en talla M?
Bot:  (searches the catalog) Sí, la Camiseta negra manga corta en talla M está
      disponible: $80.000, quedan 5. Te paso el link: https://…
You:  Y en L?
Bot:  (checks the variant) En L está agotada por ahora. ¿Te aviso cuando vuelva?
You:  Sí, soy Ana
Bot:  (saves a back_in_stock lead) Listo Ana, te escribimos apenas entre la talla L.
```

**Owner example (create, correct, publish)** — from a number in `OWNER_PHONE_NUMBERS`:

```
You:  Voy a subir una camiseta negra, 80 mil, tallas S M L
Bot:  (asks for what is missing) ¿Cuántas unidades tienes de cada talla?
You:  10 de cada una
Bot:  (create_product) Creé "Camiseta negra" como borrador con S, M y L a $80.000,
      10 de cada una. ¿La publico?
You:  (sends 4 photos)
Bot:  (attach_pending_photos) Subí 4 fotos a camiseta-negra.
You:  Publícala
Bot:  (update_product, status ACTIVE + publish) Listo, camiseta-negra ya está
      publicada en la tienda.
You:  Vendí 3 de la M
Bot:  (adjust_inventory) Ajusté CAM-NEG-M: quedan 7.
```

### Limitations of a linked device

- **Text only.** Interactive buttons and list messages are a Cloud API feature;
  a linked device cannot render them reliably on consumer WhatsApp. Outbound is
  `sendText` and nothing else — which is what the product wanted anyway, since
  photos are relayed as a storefront link.
- **No templates**, so proactive re-engagement ("a new listing matches your
  search") is not possible on this transport at all.
- **The primary phone must stay reachable.** WhatsApp unlinks companion devices
  after a long stretch with the main phone offline. The failure is silent: the
  bridge keeps running and stops receiving. Watch `/status`, not `/health`.
- **Ban risk is real.** Automated linked-device clients are detected
  automatically, without anyone complaining. Pair a number you can afford to
  lose.

---

## Testing, building, running

```bash
npm test                        # server unit tests (vitest) — no network, SDK and Shopify faked
npm run build                   # server typecheck + tsc build (dist/)
cd bridge && go test ./...      # bridge suite (Go)
```

Server tests cover: webhook signature verification (valid / wrong-secret / tampered /
missing), inbox dedupe + at-least-once lifecycle (replay of unfinished rows, TTL
cleanup), inbound message extraction (text / image / interactive / foreign-provider),
staging-path confinement and media release, per-phone queue ordering (including on
failure) and cross-phone concurrency, rate limiting (sliding window, global cap, notice
throttling), failure alerting, session expiry, the owner/customer tool privilege
boundary, and both halves of the Shopify layer: the client's throttle retry and
`userErrors` handling, the catalog's resolve order and query escaping, the
idempotency key on a stock delta and the compare-and-set on an absolute count,
photo upload order and partial failure, the relevance scorer (accents, glued
word breaks, digits that never fuzzy-match), and the catalog cache's TTL,
keying and concurrent-miss collapsing.

Bridge tests cover: outbox ordering, durability across a restart, retry with backoff,
and poison-row discard; every branch of LID→phone resolution including the unpaired
device; and delivery's retry-vs-discard classification. The HMAC fixture is duplicated
into `server/test/webhook.test.ts` on purpose — the bridge signs in Go and the server
verifies in Node, and nothing else would catch the two drifting apart.

---

## Docker

`compose.yaml` runs `server` (Fastify) and `bridge` (Go) as separate images. They
share a named volume so the bridge can hand over decrypted media by path; the
bridge has a second volume for the pairing. Works the same for local testing and
for a copy-paste deploy onto a real server.

```bash
docker compose build
./scripts/with-secrets.sh docker compose up -d             # secrets injected from gopass
docker compose logs -f                                     # tail both services
docker compose down                                        # stop (add -v to also drop the data volume)
```

Without gopass, the fallback still works: `cp env.sample .env`, fill in the
values, and run `docker compose up -d` directly — Compose interpolates the
repo-root `.env` into the same variables.

Notes:

- **`vitrina-whatsapp` is the one volume you cannot recreate.** It holds the pairing
  and the delivery outbox. Dropping it (`docker compose down -v`) unlinks the number
  and someone has to re-pair by hand, phone in reach.
- The `bridge` is deliberately unpublished — no `ports:`, and no domain on Coolify.
  Anyone who can reach `/send` can send WhatsApp messages as the business.
- `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_TOKEN` are interpolated with **no
  default**, so a bare `docker compose up` starts the server with blank values and
  it fails its boot check. That is the intent — use `./scripts/with-secrets.sh`,
  which exports the token from gopass.
- The data volume (`vitrina-data`) is a Docker-managed named volume, not a host bind
  mount, so it already has the right ownership for the containers' non-root user.

### Backups

The catalog is in Shopify and backed up by Shopify. What lives only here is the
inbox, the agent sessions and every captured lead — back that up. Snapshots
use SQLite's online backup API (consistent even while the server is writing) and are
pruned to the `BACKUP_KEEP` most recent (default 14):

```bash
./scripts/backup.sh                              # snapshot copied to ./backups on the host
docker compose --profile backup run --rm backup  # snapshot inside the data volume only
npm run backup -w server                         # local (non-Docker) development
```

Schedule the host script daily, e.g. with cron:

```
30 3 * * * cd /path/to/vitrina && ./scripts/backup.sh >> backups/backup.log 2>&1
```

---

## Assumptions to verify against a paired number

The wire format between the bridge and the server is **ours**, so it needs no
guessing — both ends are in this repo and pinned by a shared HMAC fixture. What
remains unverified is whatsmeow's behaviour against live WhatsApp, which no unit
test can cover:

1. **Outbound send.** `POST /send` → `client.SendMessage` has never run against a
   real session; it needs a paired device to exercise at all.
2. **LID addressing.** `resolvePhone` prefers `SenderAlt` and falls back to
   whatsmeow's LID map. Confirm which of the three branches your contacts actually
   take — if messages start getting dropped, the log line is
   `dropping message <id>: could not resolve sender`.
3. **Media types.** Only `ImageMessage` is downloaded; video, audio, documents, and
   stickers currently fall through to `other`. Confirm that matches what owners send.
4. **Reconnection and unlinking.** whatsmeow reconnects on its own, but the
   `LoggedOut` path has only been reasoned about, not observed. Watch `/status`.
5. **Agent session id.** We capture `session_id` from the SDK result message and resume
   with it per phone. Confirm resume behavior across long gaps.

## Notable implementation notes / deviations from the brief

- **`pending_media` table (added).** The brief lists `product_photos` but
  `attach_pending_photos` needs somewhere to hold inbound photos before they are tied to
  a product. Inbound media is stored **only for owner phones** (customers' images are
  acknowledged in the agent context but never stored/served); the owner tool moves
  matching rows for that phone into `product_photos`. Unattached pending media older than
  48h is purged on boot and hourly.
- **Webhook hardening.** Every inbound message is persisted to an `inbox` table BEFORE
  processing: the unique per-event dedupe key (WhatsApp message id, else a content hash)
  absorbs the bridge's outbox retries, and rows left unfinished by a crash are re-enqueued
  on the next boot (at-least-once delivery instead of silent loss). Reading staged media
  is bounded and non-fatal, so the ACK never waits on a wedged filesystem, and the path is
  refused unless it resolves inside the staging directory.
- **At-least-once, twice over.** The Cloud API gave us webhook retries for free;
  whatsmeow does not — it acknowledges to WhatsApp the instant an event is handled, so an
  event that is not durable at that moment is gone, and it never reaches the `inbox` table
  for the boot-time replay to find. `bridge/outbox.go` is that guarantee moved into our
  own process: durable before delivery, strictly ordered, retried forever, with a
  poison-row escape hatch so one bad payload cannot wedge the queue.
- **Drafts instead of previews.** A new product is created as a Shopify `DRAFT`, so
  the owner reviews it in the Shopify admin — which already renders it properly and
  already has access control — rather than on a page we would have to build and then
  decide how to protect. Publishing is a separate, explicit step, and it is two
  operations rather than one: setting status `ACTIVE` does **not** put a product on
  the storefront, publication to the Online Store sales channel does. The tools do
  both and report which of the two actually succeeded, because reporting "publicado"
  on the strength of the status field is the most plausible wrong-but-plausible bug
  in this integration.
- **Retrying a stock change is not free.** Delivery through this pipeline is
  at-least-once by design, and that is safe for a product update (writing the same
  fields twice is the same as writing them once) but not for a stock `delta`: applied
  twice it removes six shirts where the owner sold three, and nothing anywhere
  records that it happened. Two defences, both needed. The batcher mints a turn key
  from the first inbox row of the batch — stable across retries even as the batch
  absorbs newer messages — and it becomes Shopify's idempotency key, so a replay of
  the same turn is discarded. And the prompt prefers `set_to`, which is a
  compare-and-set against the current count, whenever the owner's words give the
  resulting number.
- **Message coalescing.** People send one thought per WhatsApp message, so a single
  listing can arrive as twenty of them. Rather than one agent turn (and one Claude call)
  per message — each seeing only a fragment of what was said — a phone's burst is
  debounced (`BATCH_DEBOUNCE_MS` of silence, restarted by every new message) and joined
  into ONE turn. `BATCH_MAX_WAIT_MS` caps the wait so someone who never pauses still gets
  a reply. The wait happens on the async worker, never in the request handler, so the ACK
  stays fast; rows stay `pending` until the batch settles, so a crash mid-burst replays it.
  The window is **adaptive**: photos arrive far slower than text — a measured 37-photo
  listing came in two waves 32 seconds apart — so a burst containing media switches to
  `BATCH_MEDIA_DEBOUNCE_MS` / `BATCH_MEDIA_MAX_WAIT_MS` and stays there until it flushes.
- **Session persistence across deploys.** The agent session id lives in SQLite, but the
  Agent SDK keeps the actual transcripts under its home directory — so `compose.yaml`
  mounts `/home/node/.claude` on its own named volume (`vitrina-sessions`). Without it
  the transcripts sit on the container's ephemeral overlay filesystem and every recreate
  leaves SQLite pointing at ids whose transcripts are gone. `server/Dockerfile` must
  create that directory owned by `node`, or the volume mountpoint lands root-owned and
  the non-root process cannot write to it — the same reason `/data` is created there.
  Belt and braces: if a session still cannot be resumed, the agent retries once with a
  fresh one, so a customer gets a reply rather than silence.
- **Cost protection.** Customer agent turns are rate limited (sliding per-phone hourly
  window + global daily circuit breaker; owners exempt) so strangers cannot run up the
  Anthropic bill. Idle sessions expire after `SESSION_MAX_AGE_DAYS` so long-lived contacts
  do not drag months of history — and cost — into every turn. After repeated consecutive
  agent failures the owner is notified on WhatsApp (throttled to once per hour).
- **Photos leave the network now.** In the real-estate build a 37-photo owner burst
  moved zero image bytes between services: the bridge decrypted into a shared volume
  and handed the server a path. That still holds between our own containers, but every
  photo now uploads to Shopify — 37 staged uploads against a rate-limited API. They run
  strictly one at a time, because a concurrent map would be faster and would silently
  shuffle the gallery: arrival order is the order the owner shot them in, and the first
  photo becomes the product's cover.
- **Agent runtime.** `@anthropic-ai/claude-agent-sdk` bundles its own runtime (`cli.js`),
  so no separate Claude Code install is required — only Node and `ANTHROPIC_API_KEY`. The
  agent is locked down: it can call **only** the in-process Vitrina tools (every built-in
  tool is denied), and the system prompt forbids stating any product fact not returned by
  a tool.
- **Relevance stayed local even though the catalog did not.** Shopify is the source of
  truth for every fact, but its product search has no accent folding, no typo tolerance
  and no comparable score — pointing the tool straight at it would silently delete the
  `match=NN%` contract and the approximate-match warning that keeps the agent from
  confidently offering the wrong thing. So the scorer ranks a short-lived read-only
  snapshot (`shopify/cache.ts`), and the two facts that must never be stale — price and
  stock — are re-read live for the products actually shown. No write-back, no
  reconciliation: it is a cache, not a mirror.
```
