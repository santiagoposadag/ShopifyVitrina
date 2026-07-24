# Secrets Management — Evaluation & Decision

> Evaluated: 2026-07-07
> Problem: Vitrina (Fastify server + Next.js web) needs `ANTHROPIC_API_KEY` and Kapso API keys without committing or hand-sharing raw `.env` files.

## Verdict on onecli

**Not adopted.** [onecli](https://github.com/onecli/onecli) is not a secrets manager — it is a self-hosted **MITM HTTPS gateway for AI agents** (Rust proxy + Next.js dashboard + PostgreSQL). Agents receive a placeholder key and route traffic through the gateway via `HTTPS_PROXY`; the gateway intercepts TLS and injects the real credential server-side, so the agent process never sees the key.

### Why it does not fit our problem

Our problem is **secret distribution** (getting keys to dev machines and the production server safely). onecli solves a **proxy-boundary** problem (keeping keys away from semi-trusted agent processes). Using it here would mean:

1. Running Postgres + a TLS-intercepting proxy in front of all outbound production traffic, and making Node trust a self-signed MITM CA (`NODE_EXTRA_CA_CERTS`).
2. The gateway itself still needs `DATABASE_URL` and `SECRET_ENCRYPTION_KEY` on its host — the secret-bootstrapping problem is relocated, not eliminated.
3. It adds a latency and availability single point of failure on every Anthropic/Kapso API call.
4. Team features (organizations, invitations, roles) are cloud-only in the OSS schema; self-hosted sharing is thin.
5. Maturity risk: ~4 months old, single primary maintainer (248/300 commits), no security audit.

### Credit where due

- Storage crypto is solid: AES-256-GCM, random per-record IV, auth tags, encryption key persisted with `chmod 600`.
- The OSS edition does not phone home; telemetry stays in your own Postgres.
- Optional Bitwarden/1Password integrations avoid server-side storage entirely.

### When to revisit

If Vitrina later runs **autonomous AI agents** that need scoped, revocable, logged access to Kapso/Anthropic/Gmail without ever holding a real key, onecli's per-agent tokens + request logs + approvals model is exactly that use case. Re-evaluate after it has another 6–12 months of maturity.

## Recommended alternatives (for our actual problem)

| Option | How it works | Fit |
|--------|--------------|-----|
| **Doppler** (SaaS) or **Infisical** (self-hostable) | `doppler run -- node server.js` injects env vars at runtime; same workflow in dev and prod; per-environment configs, rotation, audit log | **Closest match** — team secret distribution is its core job |
| **1Password CLI** | Commit `op://vault/item/field` references in a template; `op run --env-file=.env.tpl -- npm run dev` resolves them at runtime | Best if the team already pays for 1Password |
| **sops + age** | Encrypted `.env` committed to git; each developer holds an age key; decrypt on checkout/run | Zero infrastructure; more manual (no rotation UX, no runtime injection) |
| **direnv + gitignored `.env`** | Local-only env loading per directory | Fine solo; does not solve team sharing or rotation |

## Decision

- **Now (solo/pilot):** ~~keep gitignored `.env` + `env.sample`~~ **superseded 2026-07-10 — adopted gopass, see below.**
- **When the team grows or prod deploys:** adopt **Doppler or Infisical** for runtime env injection in dev and prod. If the team standardizes on 1Password, `op run` is an equal alternative.
- **Do not** use onecli as a `.env` replacement.

## Adopted: gopass (2026-07-10)

> Replaces the hand-populated plaintext `.env` for the solo/pilot phase. Trigger:
> working from a second machine that had no `.env`, plus raw API keys sitting
> unencrypted on disk.

**What**: [gopass](https://github.com/gopasspw/gopass) — each secret is a
GPG-encrypted file inside a git repo (the "store"), synced to a **private
GitHub repo**. No server, no SaaS.

### Layout

| Secret | gopass path | Provider |
|--------|-------------|----------|
| `ANTHROPIC_API_KEY` | `vitrina/anthropic_api_key` | always |
| `KAPSO_API_KEY` | `vitrina/kapso_api_key` | `kapso` |
| `KAPSO_PHONE_NUMBER_ID` | `vitrina/kapso_phone_number_id` | `kapso` |
| `KAPSO_WEBHOOK_SECRET` | `vitrina/kapso_webhook_secret` | `kapso` |
| `BRIDGE_WEBHOOK_SECRET` | `vitrina/bridge_webhook_secret` | `whatsmeow` |
| `BRIDGE_API_TOKEN` | `vitrina/bridge_api_token` | `whatsmeow` |

`WHATSAPP_PROVIDER` selects which set the wrapper fetches, so running one
provider never requires the other's credentials to exist in the vault. Both
bridge secrets are ours to invent rather than issued by anyone, so generate them:

```sh
gopass generate -n vitrina/bridge_webhook_secret 48   # signs bridge → server events
gopass generate -n vitrina/bridge_api_token 48        # guards the bridge's /send
gopass git push
```

Treat `BRIDGE_API_TOKEN` as the most sensitive value here: anyone holding it can
send WhatsApp messages as the business, with no Meta account in the loop to
revoke. Rotating it means restarting both containers together — they must agree.

Non-secret config (`OWNER_PHONE_NUMBERS`, `PUBLIC_BASE_URL`, `NEXT_PUBLIC_*`,
`WHATSAPP_PROVIDER`, `BRIDGE_PAIR_PHONE`) stays out of the vault — shell env or
`.env` fallback.

### Daily use

```sh
./scripts/with-secrets.sh docker compose up -d      # full stack
./scripts/with-secrets.sh npm run dev -w server     # local dev
gopass insert vitrina/<name>                        # add/rotate a secret
gopass git push                                     # sync the vault
```

The wrapper script exports each secret under the exact env-var name
`server/src/config.ts` expects (`gopass env` was rejected: its path→name
mapping prefixes the subtree, producing `VITRINA_*` names).

### Key management policy

- **GPG key passphrase** → iCloud Passwords (E2E-encrypted keychain).
- **GPG private key backup** → exported `.asc` file stored OUTSIDE this repo
  and outside the vault (encrypted volume / iCloud Drive / USB). Losing the
  key without this backup loses every secret.
- **Vault sync** → private GitHub repo; GitHub only ever sees `.gpg`
  ciphertext.
- **New machine** → `gopass clone <vault-repo>` + `gpg --import` the key
  backup + its passphrase from iCloud Passwords.

### When to revisit

Unchanged: when a second person needs the keys or prod deploys, move to
Doppler/Infisical (rotation, audit, per-environment configs). gopass has
neither rotation UX nor audit logging — acceptable solo, not for a team.
