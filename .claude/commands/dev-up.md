---
description: Bring the local dev stack up (server + cloudflare tunnel + log window) and report the webhook URL
---

Bring up the local development stack for Vitrina and report back.

Run `./scripts/dev-up.sh` from the repo root, passing `--echo` only if the user
asked for echo mode. The script is idempotent: it leaves anything already
running alone, so it is safe to run when you are unsure of the current state.

Then report to the user:

1. **The webhook URL**, on its own line, ready to paste into Meta's panel
   (App → WhatsApp → Configuration → Webhooks → Edit). Say whether the URL is
   new: a cloudflared quick tunnel gets a fresh subdomain on every start, so a
   restarted tunnel means re-verifying the URL in the panel. The `messages`
   field and the number-level toggle survive a URL edit.
2. **Whether the handshake passed.** The script checks it through the public
   tunnel path, which is the only path that proves anything.
3. **Which mode is live** — with `ECHO_MODE` off, real agent turns run, which
   means DeepSeek calls and writes against the real Luminiere store.

If the script exits non-zero, read the log it points at and diagnose rather
than retrying blindly. The three failures it is built to catch:

- **another process on the port** — its `/health` answers but is not Vitrina,
  and tunnelling to it would point Meta at the wrong application.
- **no tunnel URL** — cloudflared failed to register.
- **handshake mismatch** — `WHATSAPP_VERIFY_TOKEN` in `.env` does not match
  what the server loaded.

Do NOT report success on a reachability check you did not see pass. If the
tunnel returns something other than http 200, say so plainly — a URL that
Meta cannot reach looks identical, from the panel, to one that works.

Finally, offer to run `npx tsx` against the Shopify preflight if the user is
about to test catalog operations, since a credential that fails there fails
silently on the first owner message instead.
