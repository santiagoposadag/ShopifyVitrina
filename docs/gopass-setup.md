# gopass Setup — State & Machine Onboarding

> Operational companion to `docs/secrets-management.md` (which records the
> decision and policy). This file records what was actually set up, where
> everything lives, and how to onboard a new machine.
>
> Last updated: 2026-07-11.

## What exists today (set up on the Mac mini, 2026-07-10)

| Piece | Value |
|---|---|
| GPG key | `E587738DDEF385E88733189154DC0653E02896C1` — ed25519 primary [SC] + cv25519 subkey [E], expires 2028-07-09 |
| Identity | `Santiago Posada <santiago90dell@gmail.com>` |
| gopass store | `~/.local/share/gopass/stores/root` (git repo, branch `main`) |
| Vault remote | `https://github.com/santiagoposadag/secrets-vault` (private) |
| Public key copy | committed inside the vault at `.public-keys/santiago.asc` |
| Pinentry | `pinentry-mac` (GUI dialogs), wired in `~/.gnupg/gpg-agent.conf` |
| Repo integration | `scripts/with-secrets.sh` + compose `${VAR}` interpolation — committed on `feat/docker-compose` (`d02a3f5`) |

## The two artifacts that ARE the backup

Losing both halves means losing every secret, forever. Keep them in
**separate** services:

1. **Private key file** → `gpg-private-key-backup.asc` (armored export,
   passphrase-protected). Store in Google Drive (and ideally a second place:
   USB / encrypted volume). Never commit it to any repo, including the vault.
2. **Passphrase** → iCloud Passwords entry.

The revocation certificate at
`~/.gnupg/openpgp-revocs.d/E587738DDEF385E88733189154DC0653E02896C1.rev` is
worth backing up too — but anyone holding it can kill the key, so treat it
with the same care as the private key.

## Pending (as of last update)

- [ ] Store `gpg-private-key-backup.asc` in Google Drive (file currently only
      in the session scratchpad on the Mac mini — a temp directory).
- [ ] Insert the four secrets (vault is still EMPTY):
      `gopass insert vitrina/anthropic_api_key`,
      `gopass insert vitrina/kapso_api_key`,
      `gopass insert vitrina/kapso_phone_number_id`,
      `gopass insert vitrina/kapso_webhook_secret`
- [ ] `gopass git push` after inserting.
- [ ] End-to-end verify: delete/rename `.env`, then
      `./scripts/with-secrets.sh docker compose up -d` and check
      `curl localhost:3001/health` + storefront.
- [ ] Brain test: with the real `ANTHROPIC_API_KEY` injected, fire a signed
      simulated WhatsApp webhook at `localhost:3001` and confirm a Claude
      reply lands in SQLite.

## Onboarding a new machine (e.g. the laptop)

```sh
# 1. Tooling
brew install gnupg gopass pinentry-mac
echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ~/.gnupg/gpg-agent.conf
gpgconf --kill gpg-agent

# 2. Identity — copy gpg-private-key-backup.asc from Google Drive, then:
gpg --import gpg-private-key-backup.asc
# Mark the key as your own (ultimate ownertrust), non-interactively:
echo "E587738DDEF385E88733189154DC0653E02896C1:6:" | gpg --import-ownertrust

# 3. Vault
gh auth login        # if not already authenticated on the laptop
gopass clone https://github.com/santiagoposadag/secrets-vault.git

# 4. Verify — the passphrase dialog should appear once, then gpg-agent caches
gopass ls
gopass show -o vitrina/anthropic_api_key

# 5. Project
git clone https://github.com/santiagoposadag/vitrina.git
cd vitrina && git checkout feat/docker-compose
npm install
./scripts/with-secrets.sh docker compose up -d
```

Delete the `.asc` copy from the laptop's Downloads once imported — the
canonical backup lives in Google Drive.

## Daily use (any machine)

```sh
./scripts/with-secrets.sh docker compose up -d     # run with secrets injected
./scripts/with-secrets.sh npm run dev -w server    # local dev
gopass insert vitrina/<name>                       # add or rotate a secret
gopass git push                                    # sync vault after changes
gopass git pull                                    # pick up changes from the other machine
```

`.env` remains a supported fallback everywhere (compose interpolates a
repo-root `.env`); gopass is the preferred path, not a hard dependency.
