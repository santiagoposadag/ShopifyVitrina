# Deploying to Coolify

> **Sections 1 and 4 have already happened.** They described the one-time move off Kapso onto the containerised stack, and `main` now carries `compose.yaml`, both Dockerfiles and `bridge/`. They are kept as the record of how the deployment got its shape — read them to understand why the bridge exists and why its volume is the one that matters, not as steps to perform. **Sections 2, 3 and 5 stay live** and are what a deploy is checked against.
>
> For an existing deployment, the only thing a new merge asks of you is §2: whether it introduces a variable Coolify does not have yet.

## Voice notes: what a deploy needs

The transcription variables in §2 are **optional**. With none of them set the deploy boots fine and a voice note is answered with a request to write instead — the feature is inert, nothing breaks.

Three things that are handled and need no action:

- **Schema.** `openDb` runs an idempotent `ALTER TABLE inbox ADD COLUMN audio_path` at boot (`server/src/data/db.ts`), so a live database migrates itself on the first start.
- **Storage.** `AUDIO_DIR=/data/audio` lives inside the existing `vitrina-data` volume. No new volume.
- **Exposure.** The storefront's `/media/[file]` route resolves `basename()` inside `MEDIA_DIR` only, so nothing under `/data/audio` is reachable over HTTP.

One thing that does need attention: **voice notes changed `bridge/inbound.go`.** The bridge had no `AudioMessage` case, which is where a voice note was first dropped. Its image must be **rebuilt**, not restarted — a cached bridge image with a rebuilt server produces a deploy where transcription is configured, the logs are clean, and audio still never arrives.

---

## 1. What changes

| | `main` | this branch |
| --- | --- | --- |
| WhatsApp transport | **Kapso** (hosted API) | **`bridge/`** — a Go sidecar you host, paired as a linked device |
| Services | server, web | server, web, **bridge** |
| Containerisation | none in repo | `compose.yaml` + 3 Dockerfiles |
| Persistent volumes | — | `vitrina-data`, `vitrina-sessions`, **`vitrina-whatsapp`** |
| LLM provider | Anthropic, hardcoded `claude-haiku-4-5` | either, by env var |

**Kapso is gone.** These three variables are now dead and should be removed from Coolify:

```
KAPSO_API_KEY
KAPSO_PHONE_NUMBER_ID
KAPSO_WEBHOOK_SECRET
```

The number that was served through Kapso must now be **paired to the bridge as a linked device** (§4). That is a manual step, it needs the owner's phone, and the WhatsApp account carries real ban risk — the bridge has no official standing with Meta.

---

## 2. Environment variables to add

`compose.yaml` sets `BRIDGE_URL`, `BRIDGE_STAGING_DIR`, `DB_PATH`, `MEDIA_DIR`, `AGENT_TRANSCRIPTS_DIR` and `PORT` itself. Do **not** set those in Coolify.

### Required — the deploy will not boot without them

| Variable | Value | Notes |
| --- | --- | --- |
| `BRIDGE_WEBHOOK_SECRET` | `openssl rand -hex 32` | Signs inbound events. Server and bridge must see the **same** value or the channel is silently one-way. |
| `BRIDGE_API_TOKEN` | `openssl rand -hex 32` | Guards the bridge's `/send`. Anyone holding it can send WhatsApp messages as the business. |
| `ANTHROPIC_AUTH_TOKEN` | your DeepSeek API key | The Bearer credential. |
| `OWNER_PHONE_NUMBERS` | E.164 digits, no `+`, comma-separated | **An empty value makes every phone read as a customer, the owner included.** |

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are now *individually* optional — at least one must be set. Running DeepSeek, leave `ANTHROPIC_API_KEY` **unset**: two credentials for one endpoint is a coin flip over which the SDK uses.

### Provider routing — DeepSeek profile

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` |
| `MODEL` | `deepseek-v4-flash` |
| `SMALL_FAST_MODEL` | `deepseek-v4-flash` |
| `AGENT_EXTRA_BODY` | `{"output_config":{"effort":"high"}}` |
| `MAX_THINKING_TOKENS` | leave empty — DeepSeek ignores it |

> ⚠️ **`AGENT_EXTRA_BODY`: paste the raw JSON, with NO surrounding quotes.**
> `env.deepseek` wraps it in single quotes because that file is sourced by POSIX `sh`. Coolify passes the field through verbatim, so quotes there become part of the value, `JSON.parse` fails, and the container refuses to boot. That failure is loud and immediate — which is the design — but it will look like a mystery if you have not seen this note.

To stay on Anthropic instead, leave all five unset (the defaults are Anthropic + `claude-haiku-4-5`) and set `ANTHROPIC_API_KEY`.

### Shopify and URLs

| Variable | Notes |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | **Required.** The store's myshopify domain. Interpolated with no default, so a blank value fails the boot rather than crash-looping later. |
| `SHOPIFY_ADMIN_TOKEN` | **Required, secret.** Admin API token from a custom app in the store admin. Scopes: `read/write_products`, `read/write_inventory`, `read_locations`. |
| `SHOPIFY_API_VERSION` | Optional; empty uses the pin in `server/src/config.ts`. Bump it deliberately, with a test run — it changes agent behaviour. |
| `SHOPIFY_LOCATION_ID` | Optional. Only needed when the store has more than one location. |
| `CATALOG_CACHE_TTL_MS` | Optional; empty uses 60000. `0` disables the ranking cache. |
| `PUBLIC_BASE_URL` | Public URL of the **server**. Only the `/media` route for inbound owner photos in transit; product photos live in Shopify. |

There are no build args left: the storefront was Shopify's from the moment the catalog moved there, so nothing is inlined at build time any more. Every variable above is runtime env, and changing one is a restart.

### Voice notes

| Variable | Notes |
| --- | --- |
| `TRANSCRIPTION_API_KEY` | Groq (or any OpenAI-shaped `/audio/transcriptions` endpoint). **Optional** — unset, voice notes are answered with a request to write rather than silence. |
| `TRANSCRIPTION_BASE_URL` | Defaults to `https://api.groq.com/openai/v1` |
| `TRANSCRIPTION_MODEL` | Defaults to `whisper-large-v3-turbo` |
| `TRANSCRIPTION_MAX_BYTES` | Defaults to `26214400` (25 MB). Larger audio is skipped rather than billed. Bounds cost per message; it is **not** a rate limiter — transcription runs before the per-phone limiter. |

`AUDIO_DIR` is set by compose to `/data/audio` — inside the existing `vitrina-data` volume, but **outside** the publicly served `/data/media`. Do not set it yourself. See [voice-notes.md](./voice-notes.md).

Catalog search needs **no variables at all**: the relevance scoring, its floor and the result caps are constants in `server/src/data/repo.ts`, deliberately not configuration. A relevance threshold that can be tuned per deploy is a threshold nobody can reason about from the code.

### Optional — all have working defaults

`RATE_LIMIT_PER_PHONE_PER_HOUR` (20) · `RATE_LIMIT_GLOBAL_PER_DAY` (500) · `SESSION_MAX_AGE_DAYS` (7) · `CUSTOMER_AGENT_ENABLED` (true) · `BATCH_DEBOUNCE_MS` (8000) · `BATCH_MAX_WAIT_MS` (45000) · `BATCH_MEDIA_DEBOUNCE_MS` (45000) · `BATCH_MEDIA_MAX_WAIT_MS` (120000)

`CUSTOMER_AGENT_ENABLED=false` is the kill switch: non-owners get a static reply and never reach the model. Useful for a first deploy where only the owner path is being exercised.

---

## 3. Service configuration

Two long-running services. `backup` and `purge-sessions` sit behind compose profiles and never start with `up`.

| Service | Port | Domain | Volumes |
| --- | --- | --- | --- |
| `server` | 3001 | yes → `PUBLIC_BASE_URL` | `vitrina-data:/data`, `vitrina-sessions:/home/node/.claude` |
| **`bridge`** | 3002 | **NO DOMAIN, NO PUBLISHED PORT** | `vitrina-whatsapp:/session`, `vitrina-data:/data` |

> 🔒 **The bridge must never be reachable from the internet.** It has no authentication beyond `BRIDGE_API_TOKEN`, and anyone who can reach `/send` can send WhatsApp messages as the business. It needs to reach the server on the internal network and nothing else. If Coolify offers to assign it a domain, decline.

### Volumes

All three must be **persistent**, not ephemeral:

- **`vitrina-whatsapp`** — the pairing and the delivery outbox. **The one volume that is not disposable.** Losing it unlinks the number and someone re-pairs by hand.
- `vitrina-data` — SQLite database, media, and the staging directory the bridge and server share.
- `vitrina-sessions` — Agent SDK transcripts. Disposable: losing it costs conversation history, not business data.

Use named volumes, not host bind mounts. The images create these directories owned by a non-root user and a named volume inherits that ownership; a bind mount lands root-owned on most hosts and the process cannot write to it.

The bridge runs as **uid 1000**, matching the server image's `node` user, because both mount `vitrina-data`. The bridge writes decrypted photos there and the server unlinks them after reading. Unlinking needs write permission on the *directory* — mismatched uids mean the server reads every photo fine and silently leaks all of them.

Step 7 is not optional. **DeepSeek resolves an unrecognised model id to its own default silently**, so a typo in `MODEL` produces perfectly good replies from a model you did not choose. `servedModel` is the only evidence of what actually answered.

There is nothing to seed — the catalog is whatever the Shopify store already
holds. Instead, confirm the store is reachable: send the owner number a
`¿qué productos tengo?` and check the reply against the Shopify admin. A
`Listing products failed` reply means the token or its scopes are wrong.

---

## 6. Rollback

- **Provider only** — set `ANTHROPIC_BASE_URL`, `MODEL`, `SMALL_FAST_MODEL`, `AGENT_EXTRA_BODY` empty and `ANTHROPIC_API_KEY` to an Anthropic key. Restart. No rebuild.
- **Whole branch** — redeploying `main` means going back to Kapso, so those credentials must still be live. The bridge's pairing survives in `vitrina-whatsapp`; do not delete that volume while a rollback is still possible.

---

## Related

- [provider-swap.md](./provider-swap.md) — every provider variable and the parity gaps
- [provider-swap-findings.md](./provider-swap-findings.md) — the cost and quality evidence
- [secrets-management.md](./secrets-management.md) — gopass, for local runs. Coolify holds its own copies; `scripts/with-secrets.sh` is a developer convenience and is not used in deployment.
