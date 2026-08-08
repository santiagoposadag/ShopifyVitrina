# Deploying to Coolify

> **Sections 1 and 4 have already happened.** They described the one-time move off Kapso onto the containerised stack, and `main` now carries `compose.yaml`, the three Dockerfiles and `bridge/`. They are kept as the record of how the deployment got its shape — read them to understand why the bridge exists and why its volume is the one that matters, not as steps to perform. **Sections 2, 3 and 5 stay live** and are what a deploy is checked against.
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

### URLs and build args

| Variable | Notes |
| --- | --- |
| `PUBLIC_BASE_URL` | Public URL of the **server**. Baked into photo URLs WhatsApp fetches. |
| `STOREFRONT_BASE_URL` | Public URL of the **branded** web domain — a different host from the server. Owner preview links and the `/propiedad/<code>` links customers receive. |
| `ANON_BASE_URL` | Public URL of the **anonymous** web domain (`/ver/<token>` links). Optional; empty falls back to `STOREFRONT_BASE_URL`. See "Two domains, one web container" below. |
| `NEXT_PUBLIC_BRAND_NAME` | **Build arg.** |
| `NEXT_PUBLIC_WHATSAPP_NUMBER` | **Build arg.** E.164 digits, no `+`. |

`NEXT_PUBLIC_*` are inlined by Next.js at **build** time. In Coolify they must be set as build variables, and changing them later requires a **rebuild of the web image**, not a restart.

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

Three long-running services. `seed`, `backup` and `purge-sessions` sit behind compose profiles and never start with `up`.

| Service | Port | Domain | Volumes |
| --- | --- | --- | --- |
| `server` | 3001 | yes → `PUBLIC_BASE_URL` | `vitrina-data:/data`, `vitrina-sessions:/home/node/.claude` |
| `web` | 3000 | yes → `STOREFRONT_BASE_URL` | `vitrina-data:/data` |
| **`bridge`** | 3002 | **NO DOMAIN, NO PUBLISHED PORT** | `vitrina-whatsapp:/session`, `vitrina-data:/data` |

> 🔒 **The bridge must never be reachable from the internet.** It has no authentication beyond `BRIDGE_API_TOKEN`, and anyone who can reach `/send` can send WhatsApp messages as the business. It needs to reach the server on the internal network and nothing else. If Coolify offers to assign it a domain, decline.

### Volumes

All three must be **persistent**, not ephemeral:

- **`vitrina-whatsapp`** — the pairing and the delivery outbox. **The one volume that is not disposable.** Losing it unlinks the number and someone re-pairs by hand.
- `vitrina-data` — SQLite database, media, and the staging directory the bridge and server share.
- `vitrina-sessions` — Agent SDK transcripts. Disposable: losing it costs conversation history, not business data.

Use named volumes, not host bind mounts. The images create these directories owned by a non-root user and a named volume inherits that ownership; a bind mount lands root-owned on most hosts and the process cannot write to it.

The bridge runs as **uid 1000**, matching the server image's `node` user, because both mount `vitrina-data`. The bridge writes decrypted photos there and the server unlinks them after reading. Unlinking needs write permission on the *directory* — mismatched uids mean the server reads every photo fine and silently leaks all of them.

### Two domains, one web container

The `web` service answers on **two** domains, both routed to the same container by Host header:

| Domain | Serves | Set as |
| --- | --- | --- |
| the branded one | `/`, `/catalogo`, `/propiedad/<code>`, `/preview/<code>` | `STOREFRONT_BASE_URL` |
| the anonymous one | `/ver/<token>` and its photos, nothing else | `ANON_BASE_URL` |

Add both under the `web` service's domains in Coolify. Both variables are **runtime** env, not build args — changing a domain is a restart, not a rebuild (unlike `NEXT_PUBLIC_*`).

The split is not cosmetic. The anonymous page already hides the logo, the footer and the WhatsApp button; the domain is the last thing it cannot hide, since the colleague's client reads the address bar before the page renders. So the web app **404s every branded route on the anonymous host** — a client who truncates `…/ver/<token>` down to `/` gets nothing, not the company's catalog.

That 404 is deliberate and must not be softened into a redirect: redirecting to the branded domain would announce the company to exactly the person the anonymous link exists to hide it from. Links already sent to customers are grandfathered **at the edge** instead — a Cloudflare redirect rule on the anonymous host:

```
(http.host eq "<anon-host>" and
 (starts_with(http.request.uri.path, "/propiedad/") or http.request.uri.path eq "/catalogo"))
→ 301: concat("https://<branded-host>", http.request.uri.path)
```

Path-specific policy belongs at the edge; the app keeps one rule it cannot get wrong.

The new domain also needs its **own** TLS: a Cloudflare Origin Certificate is issued per hostname list, so the one covering the old domain does not cover this one. Either issue a second origin cert and install it, or create the DNS record **grey-clouded (DNS only)** first so Coolify's Let's Encrypt challenge resolves, then switch it to proxied.

Leaving `ANON_BASE_URL` empty collapses everything back to one domain and turns every host check inert — the correct state for a local or single-domain deployment.

---

## 4. Pairing the WhatsApp number

Nothing works until this is done, and it cannot be scripted from here.

1. Set `BRIDGE_PAIR_PHONE` to the number's bare E.164 digits (no `+`). Leave it unset to pair by QR code instead, rendered into the logs.
2. Deploy and open the bridge's container logs.
3. The bridge prints an 8-character pairing code.
4. On the phone: **WhatsApp → Settings → Linked devices → Link with phone number**, enter the code.
5. Confirm it took: `/status` on the bridge, **not** `/health`.

**`/health` is liveness only and ignores the WhatsApp connection on purpose** — a restart cannot fix being unlinked, and failing health on it would crash-loop over the real problem.

That distinction matters operationally: WhatsApp unlinks a device when the primary phone stays offline past its window, and that failure is **silent**. The process keeps running and simply stops receiving. Monitor `/status`.

---

## 5. Deploy order

1. Remove the three `KAPSO_*` variables.
2. Add the variables from §2. Set `CUSTOMER_AGENT_ENABLED=false` for the first deploy if you want only the owner path live.
3. Create the three persistent volumes.
4. Deploy `bridge` first, with no domain, and pair the number (§4).
5. Deploy `server`, then `web`.
6. Check the server's startup log for the credential preflight. Against DeepSeek it will report **`unknown`, not `valid`** — DeepSeek serves `/v1/messages` but answers 404 on `/v1/models`. That is expected and is not an error.
7. Send one owner message. In the server log, confirm `servedModel` on the `agent turn complete` line reads `deepseek-v4-flash`.

Step 7 is not optional. **DeepSeek resolves an unrecognised model id to its own default silently**, so a typo in `MODEL` produces perfectly good replies from a model you did not choose. `servedModel` is the only evidence of what actually answered.

Seed the catalog if this is a fresh database:

```bash
docker compose --profile seed run --rm seed
```

---

## 6. Rollback

- **Provider only** — set `ANTHROPIC_BASE_URL`, `MODEL`, `SMALL_FAST_MODEL`, `AGENT_EXTRA_BODY` empty and `ANTHROPIC_API_KEY` to an Anthropic key. Restart. No rebuild.
- **Whole branch** — redeploying `main` means going back to Kapso, so those credentials must still be live. The bridge's pairing survives in `vitrina-whatsapp`; do not delete that volume while a rollback is still possible.

---

## Related

- [provider-swap.md](./provider-swap.md) — every provider variable and the parity gaps
- [provider-swap-findings.md](./provider-swap-findings.md) — the cost and quality evidence
- [secrets-management.md](./secrets-management.md) — gopass, for local runs. Coolify holds its own copies; `scripts/with-secrets.sh` is a developer convenience and is not used in deployment.
