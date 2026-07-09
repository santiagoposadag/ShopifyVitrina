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
- `src/webhook.ts` — `POST /webhook`: HMAC verify (raw body), idempotency dedupe, batch envelope, immediate media download, per-phone enqueue, fast ACK.
- `src/queue.ts` — in-process FIFO with per-phone serialization.
- `src/agent.ts` — Claude Agent SDK integration: resume per-phone session, run tools, reply in Spanish.
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
idempotency dedupe, batch-envelope parsing, inbound message extraction (text / image /
interactive / outbound-ignored), per-phone queue ordering (including on failure) and
cross-phone concurrency, `search_catalog` filtering, `upsert_product` merge + audit trail,
`attach_pending_photos`, and listing-parser sanity (including the 008→1912 correction).

---

## Docker

`compose.yaml` runs `server` (Fastify) and `web` (Next.js) as separate images sharing
one SQLite database + media directory over a named volume. Works the same for local
testing and for a copy-paste deploy onto a real server.

```bash
cp env.sample .env                                    # fill in the values first
docker compose build
docker compose --profile seed run --rm seed           # one-time: seed the catalog
docker compose up -d
docker compose logs -f                                # tail both services
docker compose down                                   # stop (add -v to also drop the data volume)
```

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
- **Webhook hardening.** Dedupe is per-event with a stable fallback key (WhatsApp message
  id, else a content hash) in addition to the request-level `x-idempotency-key`, so retries
  are idempotent even without the header. Inbound media download is bounded by a ~6s shared
  budget and is non-fatal, so the 200 ACK never waits on an unbounded network call. Media
  downloads (which carry the API key) are refused unless the URL host is `kapso.ai` or a
  `*.kapso.ai` subdomain.
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
