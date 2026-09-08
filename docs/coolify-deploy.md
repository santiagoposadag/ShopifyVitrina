# Deploying to Coolify — first deployment

This is the runbook for standing Vitrina up on Coolify for the **first time**,
on the **Meta Cloud API** transport (`WHATSAPP_PROVIDER=cloud`). It assumes
nothing is deployed yet: no volumes, no variables, no webhook.

For an existing deployment, the only thing a new merge asks of you is §2 —
whether it introduces a variable Coolify does not have yet.

> **The bridge is not part of this deploy.** On `cloud` the whatsmeow sidecar
> has no job, needs no volume, and its `BRIDGE_*` variables are not read.
> Deploy the `server` service only. §8 covers when you would want the bridge
> back.

---

## 0. Before you touch Coolify

Three things must exist, and none of them are created by the deploy:

| | What | Where it comes from |
| --- | --- | --- |
| **Shopify app** | client id + secret | Shopify **Dev Dashboard**. It must live in the SAME organization as the store, or the token endpoint answers `shop_not_permitted`. |
| **Meta app** | app secret, verify token, phone number id, System User token | Meta app panel. See [whatsapp-cloud-api.md](./whatsapp-cloud-api.md). |
| **Model credential** | a DeepSeek or Anthropic key | The provider. |

> ⚠️ **The Shopify access token is minted, not configured.** Shopify stopped
> allowing new admin-created custom apps in January 2026. A new store has a
> client id and secret; the server exchanges them for a token that expires in
> 24 hours and renews itself 5 minutes early. **Do not** try to paste a
> hand-minted token into `SHOPIFY_ADMIN_TOKEN` — it dies the next day, in the
> middle of live conversations.

> ⚠️ **`WHATSAPP_ACCESS_TOKEN` must be a System User token.** The token the
> panel hands you on the "getting started" screen expires in 24 hours and will
> start failing every reply one day after the deploy.

---

## 1. Application setup in Coolify

Create a **Docker Compose** application pointed at this repo, `main` branch,
compose file `compose.yaml`.

**Deploy only the `server` service.** If Coolify offers to bring up everything
in the file, restrict it: `bridge` has no job here, and `backup`,
`purge-sessions`, `agent-credentials` and `role-assignments` sit behind compose
profiles and never start with `up` anyway.

### Volumes — both persistent, both named

| Volume | Mount | Losing it costs |
| --- | --- | --- |
| `vitrina-data` | `/data` | **Everything that is not in Shopify**: the inbox, sessions table, contacts, captured leads, inbound photos in transit. |
| `vitrina-sessions` | `/home/node/.claude` | Conversation history only. The agent still answers; it just starts fresh. Disposable. |

Use **named volumes, not host bind mounts.** The image creates these
directories owned by the non-root `node` user and a named volume inherits that
ownership. A bind mount lands root-owned on most hosts and the process cannot
write to it — which surfaces as a boot failure with a permissions error, not as
anything about volumes.

### Domain and port

`server` listens on **3001** and needs a public domain: Meta must be able to
POST to it. Note the URL — it is both `PUBLIC_BASE_URL` and the callback URL
you give Meta in §5.

---

## 2. Environment variables

`compose.yaml` sets `DB_PATH`, `MEDIA_DIR`, `AUDIO_DIR`, `PORT`,
`AGENT_TRANSCRIPTS_DIR`, `BRIDGE_URL` and `BRIDGE_STAGING_DIR` itself.
**Do not set those in Coolify.**

### Required — the deploy will not boot without them

| Variable | Value |
| --- | --- |
| `WHATSAPP_PROVIDER` | `cloud` — **without this it defaults to `bridge`** and demands bridge credentials instead. |
| `WHATSAPP_APP_SECRET` | Meta app secret. Signs every inbound webhook. |
| `WHATSAPP_VERIFY_TOKEN` | A string you invent. Echoed back during Meta's GET handshake. |
| `WHATSAPP_PHONE_NUMBER_ID` | From the Meta panel. **The id, not the phone number.** |
| `WHATSAPP_ACCESS_TOKEN` | System User token (see §0). |
| `SHOPIFY_STORE_DOMAIN` | e.g. `awyk1i-b4.myshopify.com`. No scheme. |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app client id. |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app client secret. |
| `ANTHROPIC_AUTH_TOKEN` | Your DeepSeek key (Bearer form). |

> The app secret and the verify token are **different secrets with different
> jobs.** Swapping them rejects every inbound message while producing a
> perfectly valid-looking signature check. Meta re-runs the GET handshake every
> time the callback URL is edited, which is why the verify token has to live in
> config and not in someone's clipboard.

**Credential pairs, and why neither half is individually required:**

- **Shopify** — set `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (current), or
  `SHOPIFY_ADMIN_TOKEN` (legacy). At least one shape must be present or boot
  fails naming both alternatives.
- **Model** — set `ANTHROPIC_AUTH_TOKEN` **or** `ANTHROPIC_API_KEY`, not both.
  Two credentials for one endpoint is a coin flip over which the SDK uses.
  On DeepSeek, leave `ANTHROPIC_API_KEY` unset.

### Owner allowlist

| Variable | Value |
| --- | --- |
| `OWNER_PHONE_NUMBERS` | E.164 digits, no `+`, comma-separated. e.g. `573507135902` |

**This is a boot SEED, not the authority.** Who is an owner lives in the
`assignments` table, which `router.ts` reads on every message. At boot this
variable is copied into that table for phones that have **no row yet**, and
then it stops mattering.

> 🔴 **Removing a phone from this variable does NOT revoke it.** Only
> `role-assignments set <phone> customer` does (§7). The asymmetry is
> deliberate: the observed failure mode of the variable is *empty*, and a sync
> would turn that into a restart silently revoking the owner of a live store.

An empty value on a **first** deploy means no owner is seeded and every phone —
yours included — reads as a customer.

### Provider routing — DeepSeek

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` |
| `MODEL` | `deepseek-v4-flash` |
| `SMALL_FAST_MODEL` | `deepseek-v4-flash` |
| `AGENT_EXTRA_BODY` | `{"output_config":{"effort":"high"}}` |
| `MAX_THINKING_TOKENS` | leave empty — DeepSeek ignores it |

> ⚠️ **`AGENT_EXTRA_BODY`: paste the raw JSON with NO surrounding quotes.**
> `env.deepseek` wraps it in single quotes because that file is sourced by
> POSIX `sh`. Coolify passes the field through verbatim, so quotes there become
> part of the value, `JSON.parse` fails, and the container refuses to boot.
> Loud and immediate by design — but a mystery if you have not seen this note.

To stay on Anthropic instead, leave all five unset and set `ANTHROPIC_API_KEY`.

### URLs

| Variable | Notes |
| --- | --- |
| `PUBLIC_BASE_URL` | The server's own public URL. Only used by the `/media` route for inbound owner photos in transit — product photos live in Shopify. |

### Optional — all have working defaults

| Variable | Default |
| --- | --- |
| `SHOPIFY_API_VERSION` | `2026-01` (the pin in `config.ts`) |
| `SHOPIFY_LOCATION_ID` | empty — only needed with more than one location |
| `CATALOG_CACHE_TTL_MS` | ranking cache only; `0` disables |
| `WHATSAPP_GRAPH_VERSION` | `v23.0` |
| `WHATSAPP_GRAPH_BASE_URL` | `https://graph.facebook.com` |
| `SESSION_MAX_AGE_DAYS` | `7` |
| `RATE_LIMIT_PER_PHONE_PER_HOUR` | `20` (owners exempt) |
| `RATE_LIMIT_GLOBAL_PER_DAY` | `500` (owners exempt) |
| `CUSTOMER_AGENT_ENABLED` | `true` |
| `BATCH_DEBOUNCE_MS` / `BATCH_MAX_WAIT_MS` | `8000` / `45000` |
| `BATCH_MEDIA_DEBOUNCE_MS` / `BATCH_MEDIA_MAX_WAIT_MS` | `45000` / `120000` |
| `TRANSCRIPTION_API_KEY` | empty — voice notes then get "please write instead", never silence |
| `TRANSCRIPTION_BASE_URL` | `https://api.groq.com/openai/v1` |
| `TRANSCRIPTION_MODEL` | `whisper-large-v3-turbo` |
| `TRANSCRIPTION_MAX_BYTES` | `26214400` (25 MB) — bounds cost per message, **not** a rate limiter |

`CUSTOMER_AGENT_ENABLED=false` is the kill switch: non-owners get a static
reply and never reach the model. Worth considering for a first deploy where
only the owner path is being exercised.

---

## 3. Optional but recommended: prove the transport first

`ECHO_MODE=true` answers every inbound message with a canned reply and runs
**nothing** else — no agent turn, no model call, no Shopify request. It also
relaxes the Shopify and model credential checks, so it boots with neither.

It exists because on a first deploy the store, the model and the transport are
all new at once, and a silent failure has three candidate causes. With echo
mode on, a reply arriving proves signature → inbox → debounce → worker →
outbound send, on its own.

It sits **ahead of** the customer kill switch and the rate limiter on purpose —
neither is protecting anything when no model call is made.

> 🔴 **A deployment left in this mode answers real customers with a test
> message.** It is announced loudly at boot and logs per message. Turn it off
> (`ECHO_MODE=false`) and redeploy before §6.

---

## 4. Deploy, and read the boot log

Deploy. A healthy first boot looks like this — five lines, in this order:

```
WhatsApp transport: Meta Cloud API (phone number id <id>, v23.0)
knowledge base ready for vitrina-inventario  (indexedChunks: 11)
knowledge base ready for vitrina-ventas
role assignments ready  (owners:1, seededFromEnv:1, alreadyAssigned:0)
Agent door: CLOSED (no rows in agent_registry). POST /agents/:id/messages refuses every request.
Vitrina server listening on :3001
```

Check each one:

| Line | What it proves | If it is wrong |
| --- | --- | --- |
| `WhatsApp transport: Meta Cloud API` | `WHATSAPP_PROVIDER=cloud` took effect | Says `bridge`? The variable is missing. |
| `knowledge base ready` ×2 | The agent definitions in `agents/` loaded and validated | A boot failure here means the image is missing `agents/`. |
| `role assignments ready`, `owners:1` | Your phone was seeded as owner | `owners:0` means `OWNER_PHONE_NUMBERS` was empty or misformatted. |
| `Agent door: CLOSED` | The second door ships shut | Anything else means credentials exist in the registry already. |

On **DeepSeek** you will also see one WARN, and it is expected:

```
could not verify ANTHROPIC_AUTH_TOKEN at boot — HTTP 404: .../v1/models is not
served by this endpoint. Expected when ANTHROPIC_BASE_URL points somewhere
other than Anthropic.
```

The credential is fine; only the *check* is Anthropic-shaped.

### Health

`GET /health` must return 200. Coolify's healthcheck already polls it every 30s
with a 10s start period.

---

## 5. Register the webhook with Meta

**Three separate actions in Meta's panel, and missing any one of them looks
identical from our side — zero POSTs, exactly like a network failure.**

1. **App level — set the Callback URL and verify token.** URL is
   `https://<your-domain>/webhook`, token is your `WHATSAPP_VERIFY_TOKEN`.
   Meta immediately runs a GET handshake; it must return your challenge.
2. **App level — subscribe to the `messages` field.** Saving the URL does not
   subscribe you to anything.
3. **WABA level — subscribe the app to the WhatsApp Business Account.** This is
   a different screen from the two above and is the one most often missed.

Verify the handshake is wired correctly before moving on:

```bash
# Wrong token must NOT return 200
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<your-domain>/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=1"
# expect: 403

# Unsigned POST must be refused
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your-domain>/webhook \
  -H 'content-type: application/json' -d '{"object":"whatsapp_business_account","entry":[]}'
# expect: 401
```

> **The 24-hour window is a hard error.** A free-form reply more than 24h after
> the person's last message is rejected with code `131047` — no template, no
> delivery. `statuses` callbacks are the only place a send that Meta accepted
> and then failed to deliver ever shows up, which is why they are logged.

---

## 6. Verify against the real store

Send the owner number a message from WhatsApp:

```
¿qué productos tengo?
```

The reply must match the Shopify admin. Then check the turn in the logs:

```json
{"msg":"agent turn complete","servedModel":"deepseek-v4-flash",
 "tools":"search_catalog","resultSubtype":"success","durationMs":15474}
```

Three fields carry the whole verification:

- **`servedModel`** — not optional to check. **DeepSeek resolves an
  unrecognised model id to its own default silently**, so a typo in `MODEL`
  produces perfectly good replies from a model you did not choose. This is the
  only evidence of what actually answered.
- **`tools`** — a turn that answered about products with `tools: (none)` means
  the agent invented them.
- **`resultSubtype: success`** — anything else means the turn ended without
  words and the person got the `NO_ANSWER_FALLBACK`.

A `Listing products failed` reply means the Shopify credentials or their scopes
are wrong. Required scopes: `read/write_products`, `read/write_inventory`,
`read_locations`.

There is nothing to seed — the catalog is whatever the Shopify store holds.

---

## 7. Day-two operations

All of these run as one-off containers against the live volume. On Coolify, run
them from the application's terminal / command runner.

```bash
# Who is an owner. The TABLE, not the variable.
docker compose --profile ops run --rm role-assignments list
docker compose --profile ops run --rm role-assignments set 573001112233 owner
docker compose --profile ops run --rm role-assignments set 573001112233 customer   # revoke
docker compose --profile ops run --rm role-assignments remove 573001112233

# The agent door: who may call POST /agents/:id/messages, and what they may reach
docker compose --profile ops run --rm agent-credentials list
docker compose --profile ops run --rm agent-credentials add super-agent --reach vitrina-inventario
docker compose --profile ops run --rm agent-credentials rotate super-agent

# Consistent SQLite snapshot, safe under writes
docker compose --profile backup run --rm backup

# Drop customer conversation histories (keeps owner sessions)
docker compose --profile purge run --rm purge-sessions
```

> **The agent-door token is printed ONCE** and only its SHA-256 is stored. A
> lost token is replaced with `rotate`, never looked up. The registry table
> **is** the switch — with no rows the door answers 401 to everything, and
> there is deliberately no second enabling flag, because two switches for one
> thing is how one of them ends up in the wrong position.

> **`purge-sessions` refuses to run on an empty owner allowlist**, precisely
> because an empty allowlist is the observed failure mode and it would
> otherwise delete the owner's in-progress work.

---

## 8. Rollback

| Scope | How | Rebuild? |
| --- | --- | --- |
| **Model provider** | Clear `ANTHROPIC_BASE_URL`, `MODEL`, `SMALL_FAST_MODEL`, `AGENT_EXTRA_BODY`; set `ANTHROPIC_API_KEY`. Restart. | No |
| **WhatsApp transport** | Set `WHATSAPP_PROVIDER=bridge`, supply `BRIDGE_WEBHOOK_SECRET` + `BRIDGE_API_TOKEN`, deploy the `bridge` service with a persistent `vitrina-whatsapp` volume, and re-pair the number. | Yes, bridge image |
| **Whole release** | Redeploy the previous commit. `vitrina-data` survives; the schema migrations are additive. | Yes |

Both transports sit behind `WhatsAppChannel`, which is what makes the choice a
variable and a restart rather than a revert. But note the asymmetry: once the
number is registered with Meta, the bridge's pairing is dead and reconnecting
it means re-pairing by hand. Transport rollback is not free.

> 🔒 **If you ever deploy the bridge: it must never be reachable from the
> internet.** No domain, no published port. Anyone who can reach `/send` can
> send WhatsApp messages as the business. If Coolify offers it a domain,
> decline.

---

## Secrets

Coolify holds its own copies of every value in §2, entered in its UI.
`scripts/with-secrets.sh` is a **local developer convenience only** and is not
used in deployment — do not try to make Coolify run it.

---

## Related

- [whatsapp-cloud-api.md](./whatsapp-cloud-api.md) — the Meta app, the three subscription steps, the 24-hour window
- [puerta-agente.md](./01-arquitectura/puerta-agente.md) — the agent door and the four rules that keep it shut
- [base-conocimiento.md](./01-arquitectura/base-conocimiento.md) — the knowledge base and its invariants
- [provider-swap.md](./provider-swap.md) — every provider variable and the parity gaps
- [shopify-setup.md](./shopify-setup.md) — the Dev Dashboard app and its scopes
