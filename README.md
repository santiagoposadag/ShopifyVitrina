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
package.json          # workspaces: ["server", "web"]
env.sample            # copy to .env and fill in  (see note below)
server/               # Fastify + Claude Agent SDK + SQLite  (the brain + WhatsApp transport)
web/                  # Next.js App Router storefront (reads the same SQLite file)
data/                 # created at runtime: vitrina.db + media/  (git-ignored)
```

```
Customer / Owner (WhatsApp)
        │
        ▼
   Kapso.ai  ──webhook (HMAC, ACK<10s, idempotent)──►  server (Fastify)
   WhatsApp Cloud API                                    1. verify + dedupe
        ▲                                                2. download media (token ~4 min)
        └──────── REST send (text, image, buttons) ───── 3. enqueue per-phone, ACK
                                                              │  async worker
                                                              ▼
                                                     Claude Agent SDK
                                                     session per phone (resumable)
                                                     role: owner | customer
                                                     in-process tools ↓
                                                              │
                                             ┌────────────────┴───────────────┐
                                             ▼                                 ▼
                                        SQLite (better-sqlite3)          MEDIA_DIR (photos)
                                             ▲
                                             │ read-only
                                        Next.js storefront (landing + catalog)
```

### server/ — the brain

- `src/config.ts` — env loading and role detection (`OWNER_PHONE_NUMBERS` allowlist).
- `src/db.ts` — SQLite (WAL), schema created on boot.
- `src/repo.ts` — all catalog/lead/session queries.
- `src/kapso.ts` — Kapso REST client: `sendText`, `sendImage`, `sendInteractiveButtons`, `downloadMedia`.
- `src/webhook.ts` — `POST /webhook`: HMAC verify (raw body), batch envelope, persisted inbox (dedupe + at-least-once: unfinished messages are replayed on boot), immediate media download, fast ACK.
- `src/batcher.ts` — coalesces each phone's message burst into ONE agent turn (`BATCH_DEBOUNCE_MS` of silence, `BATCH_MAX_WAIT_MS` ceiling) and settles its inbox rows.
- `src/queue.ts` — in-process FIFO with per-phone serialization.
- `src/agent.ts` — Claude Agent SDK integration: resume per-phone session (idle sessions expire after `SESSION_MAX_AGE_DAYS`; an unresumable session falls back once to a fresh one), run tools, reply in Spanish.
- `src/rate-limit.ts` — cost protection: per-phone sliding-hour limit + global daily cap for customer turns (owners exempt).
- `src/alerts.ts` — notifies the owner's WhatsApp after consecutive agent failures.
- `src/backup.ts` — consistent SQLite snapshot (online backup API) with pruning.
- `src/tools.ts` — in-process MCP tools. Customer: `search_catalog`, `get_product`, `send_product_photos`, `save_lead`. Owner (allowlist): the above plus `upsert_product`, `attach_pending_photos`, `list_products`, `list_leads`.
- `src/media.ts` — serves `MEDIA_DIR` under `/media/*`; saves inbound media.
- `src/seed.ts` — parses the two example properties and inserts them as **active** with photos.
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
| `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` | Send messages / download media via Kapso. |
| `KAPSO_WEBHOOK_SECRET` | Verify inbound webhook signatures. |
| `OWNER_PHONE_NUMBERS` | Comma-separated allowlist (E.164 digits, no `+`) that gets the owner toolset. |
| `DB_PATH`, `MEDIA_DIR` | Shared by server and web. Relative paths resolve to the **repo root**, so both apps agree regardless of the workspace they run from. |
| `PUBLIC_BASE_URL` | Public URL of the server (a tunnel) — used to build photo URLs WhatsApp can fetch. |
| `STOREFRONT_BASE_URL` | Public URL of the **storefront** (a different host from `PUBLIC_BASE_URL`) — used to build the owner's private draft-preview links (default `http://localhost:3000`). |
| `RATE_LIMIT_PER_PHONE_PER_HOUR`, `RATE_LIMIT_GLOBAL_PER_DAY` | Cost protection for customer agent turns (defaults 20/hour per phone, 500/day global; owners exempt). |
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

### 5. Expose the server and register the webhook

WhatsApp/Kapso must reach your server, and photo URLs must be public:

```bash
# example with cloudflared (or use ngrok)
cloudflared tunnel --url http://localhost:3001
```

Set `PUBLIC_BASE_URL` in `.env` to the tunnel URL and restart the server. Then in
the Kapso dashboard, point the webhook at `https://<tunnel>/webhook` and set the
webhook secret to match `KAPSO_WEBHOOK_SECRET`.

---

## Sandbox testing walkthrough

Kapso provides a shared sandbox number for development.

1. Start the server, open a tunnel, set `PUBLIC_BASE_URL`, register the webhook.
2. Add your own phone number to `OWNER_PHONE_NUMBERS` to test the **owner** flow,
   or leave it out to test the **customer** flow.
3. Message the sandbox number from WhatsApp.

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

### Sandbox limitations

- **Text + interactive only.** The sandbox cannot send WhatsApp **templates**, so
  proactive/re-engagement messages ("a new listing matches your search") can only be
  validated on a real, verified production number.
- Media on the sandbox behaves like production: inbound media download tokens are
  short-lived (~4 minutes), which is why the server downloads media at webhook
  receipt, before running the agent.

---

## Testing, building, running

```bash
npm test          # server unit tests (vitest) — no network, Kapso/Claude mocked
npm run build     # server typecheck + tsc build (dist/) + next build
npm run seed      # (re)seed the catalog
```

Tests cover: webhook signature verification (valid / wrong-secret / tampered / missing),
inbox dedupe + at-least-once lifecycle (replay of unfinished rows, TTL cleanup),
batch-envelope parsing, inbound message extraction (text / image / interactive /
outbound-ignored), per-phone queue ordering (including on failure) and cross-phone
concurrency, rate limiting (sliding window, global cap, notice throttling), failure
alerting, session expiry, the owner/customer tool privilege boundary, `search_catalog`
filtering, `upsert_product` merge + audit trail, `attach_pending_photos`, and
listing-parser sanity (including the 008→1912 correction).

---

## Docker

`compose.yaml` runs `server` (Fastify) and `web` (Next.js) as separate images sharing
one SQLite database + media directory over a named volume. Works the same for local
testing and for a copy-paste deploy onto a real server.

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
  plain `docker compose up`. It needs no Kapso/Anthropic keys, only `DB_PATH` /
  `MEDIA_DIR` / `PUBLIC_BASE_URL` (all provided by compose or defaulted).
- `NEXT_PUBLIC_BRAND_NAME` and `NEXT_PUBLIC_WHATSAPP_NUMBER` are inlined into the web
  bundle at **build** time. Set them in `.env` before `docker compose build`, not just in
  the running container's environment — otherwise the WhatsApp CTA silently breaks.
- On a real server, `PUBLIC_BASE_URL` (in `.env`, used by the `server` and `seed`
  services) must point at the public tunnel/domain that Kapso/WhatsApp can reach —
  never `localhost` — or WhatsApp cannot fetch photo URLs.
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

## Assumptions to verify in sandbox

External API details were checked against live docs (Kapso `send-messages/*`,
`webhooks/*`; Claude Agent SDK TypeScript reference) and are isolated behind
`src/kapso.ts`, `src/webhook.ts`, and `src/agent.ts`. Confirm these against a real
sandbox before production:

1. **Webhook signature basis.** Kapso docs express the signed content as
   `JSON.stringify(payload)`; we verify the HMAC-SHA256 over the **raw request body**
   (the robust choice — re-serializing can reorder keys). For Kapso-generated requests
   these are identical. If Kapso ever signs a re-serialized form, adjust
   `verifySignature` in `src/webhook.ts`. We accept both a bare hex digest and a
   `sha256=`-prefixed value.
2. **Inbound webhook envelope.** We read the message from `event.message`,
   `event.data.message`, or the event itself, and unwrap the batch envelope
   (`{ batch: true, data: [...] }`). Verify the exact nesting your Kapso account emits
   (`extractInbound` / `normalizeEvents`).
3. **Inbound media URL + auth.** We download from `message.kapso.media_data.url` (falling
   back to `kapso.media_url`) and send `X-API-Key`. Confirm the field and whether the
   signed token needs the header (`downloadMedia` in `src/kapso.ts`).
4. **Interactive replies.** We read `interactive.button_reply` / `interactive.list_reply`.
   Confirm inbound shape for list replies.
5. **Agent session id.** We capture `session_id` from the SDK result message and resume
   with it per phone. Confirm resume behavior across long gaps in your account.

## Notable implementation notes / deviations from the brief

- **`pending_media` table (added).** The brief lists `product_photos` but
  `attach_pending_photos` needs somewhere to hold inbound photos before they are tied to
  a product. Inbound media is stored **only for owner phones** (customers' images are
  acknowledged in the agent context but never stored/served); the owner tool moves
  matching rows for that phone into `product_photos`. Unattached pending media older than
  48h is purged on boot and hourly.
- **Webhook hardening.** Every inbound message is persisted to an `inbox` table BEFORE
  processing: the unique per-event dedupe key (WhatsApp message id, else a content hash)
  absorbs Kapso's 10/40/90s retries, and rows left unfinished by a crash are re-enqueued
  on the next boot (at-least-once delivery instead of silent loss). Inbound media download
  is bounded by a ~6s shared budget and is non-fatal, so the 200 ACK never waits on an
  unbounded network call. Media downloads (which carry the API key) are refused unless the
  URL host is `kapso.ai` or a `*.kapso.ai` subdomain.
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
