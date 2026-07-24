#!/bin/sh
# Runs a command with Vitrina's secrets exported from gopass.
#
#   ./scripts/with-secrets.sh docker compose up -d
#   ./scripts/with-secrets.sh npm run dev -w server
#
# Secrets live GPG-encrypted in the gopass store (see docs/secrets-management.md).
# Non-secret config (OWNER_PHONE_NUMBERS, PUBLIC_BASE_URL, NEXT_PUBLIC_*) is not
# handled here — set it in the shell or a .env file as before.
set -eu

if ! command -v gopass >/dev/null 2>&1; then
  echo "error: gopass is not installed (brew install gopass)" >&2
  exit 1
fi

export ANTHROPIC_API_KEY="$(gopass show -o vitrina/anthropic_api_key)"

# Only the ACTIVE provider's secrets are fetched, so running the whatsmeow bridge
# does not require a Kapso account to exist in gopass at all (and vice versa).
# WHATSAPP_PROVIDER usually lives in .env, which compose reads but this script
# does not — so pick it up from there when the shell has not set it.
if [ -z "${WHATSAPP_PROVIDER:-}" ] && [ -f .env ]; then
  WHATSAPP_PROVIDER="$(sed -n 's/^[[:space:]]*WHATSAPP_PROVIDER[[:space:]]*=[[:space:]]*//p' .env | tail -1)"
fi

case "${WHATSAPP_PROVIDER:-kapso}" in
  whatsmeow)
    export BRIDGE_WEBHOOK_SECRET="$(gopass show -o vitrina/bridge_webhook_secret)"
    export BRIDGE_API_TOKEN="$(gopass show -o vitrina/bridge_api_token)"
    ;;
  kapso)
    export KAPSO_API_KEY="$(gopass show -o vitrina/kapso_api_key)"
    export KAPSO_PHONE_NUMBER_ID="$(gopass show -o vitrina/kapso_phone_number_id)"
    export KAPSO_WEBHOOK_SECRET="$(gopass show -o vitrina/kapso_webhook_secret)"
    ;;
  *)
    echo "error: unknown WHATSAPP_PROVIDER '${WHATSAPP_PROVIDER}' (expected kapso or whatsmeow)" >&2
    exit 1
    ;;
esac

exec "$@"
