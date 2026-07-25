# Deploying this branch to Coolify — the delta from `main`

What is additional relative to what `main` already has deployed.

> **Read this first.** `main` contains **no `compose.yaml`, no Dockerfiles, and no `bridge/` directory.** Whatever is running from `main` was not deployed through this stack. So this is not "add a few variables to the provider swap" — this branch introduces the whole containerised deployment, replaces the WhatsApp transport, and adds a new service that must be paired by hand with a phone in reach.
>
> The provider swap (Anthropic → DeepSeek) is the small part. The WhatsApp transport change is the risky part.

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
| `STOREFRONT_BASE_URL` | Public URL of the **web** app — a different host. Used for owner preview links. |
| `NEXT_PUBLIC_BRAND_NAME` | **Build arg.** |
| `NEXT_PUBLIC_WHATSAPP_NUMBER` | **Build arg.** E.164 digits, no `+`. |

`NEXT_PUBLIC_*` are inlined by Next.js at **build** time. In Coolify they must be set as build variables, and changing them later requires a **rebuild of the web image**, not a restart.

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
