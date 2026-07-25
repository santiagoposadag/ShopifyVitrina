# Vitrina

A WhatsApp-native sales & inventory assistant. One WhatsApp number becomes a full
sales channel: an AI assistant (Claude) answers customer questions from a live
catalog, sends photos, captures leads, and schedules visits — while the business
owner manages inventory **through WhatsApp itself**, in natural language. A public
storefront (landing + catalog) is generated automatically from the same catalog.

First vertical: real estate. The pilot ships with two seed properties.

> **Language:** the assistant and the storefront speak neutral, professional Spanish.
> All code, identifiers, and comments are in English.

---

## Architecture

Monorepo with npm workspaces:

```
package.json          # workspaces: ["server", "web", "shared"]
env.sample            # copy to .env and fill in  (see note below)
server/               # Fastify + Claude Agent SDK + SQLite  (the brain)
web/                  # Next.js App Router storefront (reads the same SQLite file)
shared/               # types-only package (@vitrina/shared) — no runtime code
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
                                        SQLite (better-sqlite3)          MEDIA_DIR (photos)
                                             ▲
                                             │ read-only
                                        Next.js storefront (landing + catalog)
```

The bridge pairs a real number as a **linked device**. That means no WhatsApp
Business onboarding and no per-conversation fee — and no official standing with
Meta, so the number carries genuine ban risk and is unlinked if the primary
phone stays offline too long. See `bridge/` and CLAUDE.md.

### server/ — the brain

- `src/config.ts` — env loading and role detection (`OWNER_PHONE_NUMBERS` allowlist).
- `src/data/db.ts` — SQLite (WAL), schema created on boot.
- `src/data/repo.ts` — all catalog/lead/session queries.
- `src/whatsapp/channel.ts` — the transport seam: `sendText`, `downloadMedia(ref)`, optional `releaseMedia`. Outbound is text-only on purpose — photos are relayed as a storefront link, never pushed into the chat.
- `src/whatsapp/bridge.ts` — the one implementation: posts replies to the sidecar, reads staged media off the shared volume (`isAllowedMediaPath` confines it), sweeps files orphaned by a crash.
- `src/inbox/whatsmeow.ts` — parses the bridge's event shape into an `InboundMessage`.
- `src/inbox/webhook.ts` — `POST /webhook`: HMAC verify (raw body), persisted inbox (dedupe + at-least-once: unfinished messages are replayed on boot), media handoff, fast ACK.
- `src/inbox/batcher.ts` — coalesces each phone's message burst into ONE agent turn (`BATCH_DEBOUNCE_MS` of silence, `BATCH_MAX_WAIT_MS` ceiling) and settles its inbox rows.
- `src/inbox/queue.ts` — in-process FIFO with per-phone serialization.
- `src/agent/agent.ts` — Claude Agent SDK integration: resume per-phone session (idle sessions expire after `SESSION_MAX_AGE_DAYS`; an unresumable session falls back once to a fresh one), run tools, reply in Spanish.
- `src/inbox/rate-limit.ts` — cost protection: per-phone sliding-hour limit + global daily cap for customer turns (owners exempt).
- `src/inbox/alerts.ts` — notifies the owner's WhatsApp after consecutive agent failures.
- `src/data/backup.ts` — consistent SQLite snapshot (online backup API) with pruning.
- `src/data/transcripts.ts` — the Agent SDK's transcripts on disk: delete one session's, or sweep the ones no session row can resume any more. Inert unless `AGENT_TRANSCRIPTS_DIR` is set, which it deliberately does not default (see the file's header).
- `src/data/purge.ts` / `src/data/purge-sessions.ts` — ops lever: drop every **customer** conversation history so they start fresh; owner sessions are kept. `docker compose --profile purge run --rm purge-sessions`, or `npm run purge:sessions -w server`.
- `src/agent/tools.ts` — in-process MCP tools. Customer: `search_catalog`, `get_product`, `save_lead`. Owner (allowlist): the above plus `upsert_product`, `attach_pending_photos`, `list_products`, `list_leads`. The tool server has no WhatsApp channel: tools read and write data, they never message the chat.
- `src/agent/preview.ts` — the storefront URL shapes: `/propiedad/<code>` for customers (active only), `/preview/<code>` for the owner's pre-publish review. Both ride back on tool results, since the agent may only state what a tool returned.
- `src/whatsapp/media.ts` — serves `MEDIA_DIR` under `/media/*`; saves inbound media.
- `src/seed/seed.ts` — parses the two example properties and inserts them as **active** with photos.
- `src/index.ts` — wires everything; `GET /health`.

### web/ — the storefront

Next.js 15 (App Router) + Tailwind v4, reading the **same** SQLite file directly via
`better-sqlite3` (read-only, dynamic rendering — no static caching of DB reads).

- `/` — brand hero + featured properties + WhatsApp CTA.
- `/catalogo` — grid of all active products.
- `/propiedad/[code]` — photo gallery, attributes, description, and the key CTA:
  a `wa.me` deep link prefilled with `Hola, me interesa la propiedad con código <code>`.
- `/preview/[code]` — the owner's view of a property in **any** status, so a draft can
  be reviewed before publishing. Unlisted and `noindex`; not in the catalog.
- `/media/[file]` — serves product photos from `MEDIA_DIR` (so the storefront is
  self-contained and does not depend on the WhatsApp server being reachable).

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
| `DB_PATH`, `MEDIA_DIR` | Shared by server and web. Relative paths resolve to the **repo root**, so both apps agree regardless of the workspace they run from. |
| `PUBLIC_BASE_URL` | Public URL of the server (a tunnel) — used to build photo URLs WhatsApp can fetch. |
| `STOREFRONT_BASE_URL` | Public URL of the **storefront** (a different host from `PUBLIC_BASE_URL`) — used to build the owner's private draft-preview links (default `http://localhost:3000`). |
| `RATE_LIMIT_PER_PHONE_PER_HOUR`, `RATE_LIMIT_GLOBAL_PER_DAY` | Cost protection for customer agent turns (defaults 20/hour per phone, 500/day global; owners exempt). |
| `CUSTOMER_AGENT_ENABLED` | Kill switch for the customer path (default `true`). `false` auto-replies that the assistant is unavailable — non-owner messages never reach the agent or spend a Claude call. |
| `SESSION_MAX_AGE_DAYS` | Conversations idle longer than this start a fresh agent session (default 7). |
| `BATCH_DEBOUNCE_MS`, `BATCH_MAX_WAIT_MS` | How long a phone's messages are coalesced into one agent turn: silence that ends a burst (default 8000) and the ceiling from its first message (default 45000). |
| `BATCH_MEDIA_DEBOUNCE_MS`, `BATCH_MEDIA_MAX_WAIT_MS` | The same two knobs once a burst contains photos (defaults 45000 / 120000) — WhatsApp delivers a photo set in waves tens of seconds apart. |

### 3. Seed the catalog

```bash
npm run seed
```

Inserts the two example properties as **active** with their photos copied into
`MEDIA_DIR`:

- Código **916** — house in Rionegro (Barro Blanco), 230 m², 3 levels, $1.150.000.000, no admin fee.
- Código **1912** — apartment in Belén Rosales (Malibú), 78 m², 3 bed / 2 bath, floor 8 with elevator, admin $270.000, estrato 5, $670.000.000 negotiable.

  (The seed applies the seller's correction: the apartment's code is **1912**, not 008.)

### 4. Run

```bash
npm run dev:server     # Fastify on :3001
npm run dev:web        # Next.js on :3000  (open http://localhost:3000)
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

A tunnel is still needed for **outbound links**, not for messages: the storefront
URLs the assistant sends must resolve on the recipient's phone. Set
`PUBLIC_BASE_URL` / `STOREFRONT_BASE_URL` to public addresses.

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
You:  Hola, busco apartamento en Belén hasta 700 millones
Bot:  (searches the catalog) Tenemos el código 1912 en Belén Rosales (Malibú): 78 m²,
      3 habitaciones, 2 baños, piso 8 con ascensor. Precio $670.000.000 negociable.
      ¿Querés ver fotos o agendar una visita?
You:  Mandame fotos
Bot:  (sends up to 4 photos) …
You:  Quiero visitarlo el sábado, soy Ana
Bot:  (saves a visit_request lead) ¡Listo Ana! Registré tu solicitud de visita para el
      código 1912. Un asesor te contacta para coordinar el sábado.
```

**Owner example (ingestion + correction)** — from a number in `OWNER_PHONE_NUMBERS`:

```
You:  📣 VENDO CASA PARA ESTRENAR … 📐 Área: 230 metros cuadrados … 💲 Precio: 1.150.000.000
Bot:  (parses it) Cargué un borrador. Para publicarlo necesito el código. ¿Cuál es?
You:  Código 916
Bot:  (upsert_product) Guardé el código 916. ¿Lo publico en la vitrina?
You:  Sí
Bot:  Publicado. Ya aparece en el catálogo.
You:  El código 008 no es. Ya es código 1912
Bot:  (upsert_product) Corregido: el apartamento ahora tiene el código 1912.
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
npm test                        # server unit tests (vitest) — no network, SDK mocked
npm run build                   # server typecheck + tsc build (dist/) + next build
npm run seed                    # (re)seed the catalog
cd bridge && go test ./...      # bridge suite (Go)
```

Server tests cover: webhook signature verification (valid / wrong-secret / tampered /
missing), inbox dedupe + at-least-once lifecycle (replay of unfinished rows, TTL
cleanup), inbound message extraction (text / image / interactive / foreign-provider),
staging-path confinement and media release, per-phone queue ordering (including on
failure) and cross-phone concurrency, rate limiting (sliding window, global cap, notice
throttling), failure alerting, session expiry, the owner/customer tool privilege
boundary, `search_catalog` filtering, `upsert_product` merge + audit trail,
`attach_pending_photos`, and listing-parser sanity (including the 008→1912 correction).

Bridge tests cover: outbox ordering, durability across a restart, retry with backoff,
and poison-row discard; every branch of LID→phone resolution including the unpaired
device; and delivery's retry-vs-discard classification. The HMAC fixture is duplicated
into `server/test/webhook.test.ts` on purpose — the bridge signs in Go and the server
verifies in Node, and nothing else would catch the two drifting apart.

---

## Docker

`compose.yaml` runs `server` (Fastify), `web` (Next.js), and `bridge` (Go) as separate
images. The server and web share one SQLite database + media directory over a named
volume; the bridge shares that same volume to hand over decrypted media, plus its own
volume for the pairing. Works the same for local testing and for a copy-paste deploy
onto a real server.

```bash
docker compose build
docker compose --profile seed run --rm seed               # one-time: seed the catalog
./scripts/with-secrets.sh docker compose up -d             # secrets injected from gopass
docker compose logs -f                                     # tail both services
docker compose down                                        # stop (add -v to also drop the data volume)
```

Without gopass, the fallback still works: `cp env.sample .env`, fill in the
values, and run `docker compose up -d` directly — Compose interpolates the
repo-root `.env` into the same variables.

Notes:

- `seed` only runs when explicitly invoked with `--profile seed` — it never runs on a
  plain `docker compose up`. It needs no secrets, only `DB_PATH` / `MEDIA_DIR` /
  `PUBLIC_BASE_URL` (all provided by compose or defaulted).
- **`vitrina-whatsapp` is the one volume you cannot recreate.** It holds the pairing
  and the delivery outbox. Dropping it (`docker compose down -v`) unlinks the number
  and someone has to re-pair by hand, phone in reach.
- The `bridge` is deliberately unpublished — no `ports:`, and no domain on Coolify.
  Anyone who can reach `/send` can send WhatsApp messages as the business.
- `NEXT_PUBLIC_BRAND_NAME` and `NEXT_PUBLIC_WHATSAPP_NUMBER` are inlined into the web
  bundle at **build** time. Set them in `.env` before `docker compose build`, not just in
  the running container's environment — otherwise the WhatsApp CTA silently breaks.
- On a real server, `PUBLIC_BASE_URL` (in `.env`, used by the `server` and `seed`
  services) must point at a public domain — never `localhost` — or the photo URLs and
  storefront links the assistant sends will not resolve on the recipient's phone.
- The data volume (`vitrina-data`) is a Docker-managed named volume, not a host bind
  mount, so it already has the right ownership for the containers' non-root user.
- The `web` container mounts the data volume read-write even though it only reads: SQLite
  in WAL mode writes the `-shm` / `-wal` sidecar files even for read-only connections.

### Backups

The catalog and every captured lead live in one SQLite file — back it up. Snapshots
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
- **Draft previews.** The catalog renders only `active` products, so an owner could
  otherwise review a new listing only as a text summary over WhatsApp — or by publishing
  it to customers first, which defeats the point of a draft. `/preview/<code>` renders the
  real page (photos included) for any status, and the assistant includes the link in its
  `upsert_product` result while the product is not active. The page is **unlisted, not
  private**: no token, no access control — a deliberate pilot tradeoff, since the catalog
  holds no sensitive data. It IS `noindex`'d, which is not about secrecy but about data
  quality: a draft is unreviewed (the assistant has invented an attribute on a real
  listing before), and a wrong fact about a real property indexed by a search engine
  outlives the draft.
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
- **Storefront photo serving.** Rather than copying `MEDIA_DIR` into `web/public`, the
  web app serves photos through its own `/media/[file]` route reading `MEDIA_DIR`
  directly — robust and independent of the server process.
- **Agent runtime.** `@anthropic-ai/claude-agent-sdk` bundles its own runtime (`cli.js`),
  so no separate Claude Code install is required — only Node and `ANTHROPIC_API_KEY`. The
  agent is locked down: it can call **only** the in-process Vitrina tools (every built-in
  tool is denied), and the system prompt forbids stating any product fact not returned by
  a tool.
- **SQLite + JSON attributes** keeps the catalog product-agnostic (real estate is just the
  first attribute template); a future vertical is a new template, not new tables.
```
