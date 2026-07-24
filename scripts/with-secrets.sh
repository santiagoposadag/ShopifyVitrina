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

# Export one secret, or fail with the command that would create it. A bare
# `gopass show` failure under `set -e` prints a store error and no clue about
# which variable was wanted or how to fix it.
load_secret() {
  _var="$1"
  _path="$2"
  if ! _val="$(gopass show -o "$_path" 2>/dev/null)"; then
    echo "error: no gopass entry at '$_path' (needed for $_var)" >&2
    echo "       create it with:  gopass generate -n $_path 48" >&2
    echo "       see docs/secrets-management.md" >&2
    exit 1
  fi
  export "$_var=$_val"
}

# Read a variable out of .env. Compose reads that file itself; this script does
# not, so anything it needs to BRANCH on has to be parsed here — and it has to
# parse it the way compose does, or the two disagree. Compose strips surrounding
# quotes and trailing ` #` comments, so both are handled: without that,
# `WHATSAPP_PROVIDER="whatsmeow"` reaches the case below still wearing its quotes
# and lands in the unknown-provider branch, which is a baffling error to debug.
read_dotenv() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env |
    tail -1 |
    sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/[[:space:]]*$//'
}

load_secret ANTHROPIC_API_KEY vitrina/anthropic_api_key

# Only the ACTIVE provider's secrets are fetched, so running the whatsmeow bridge
# does not require a Kapso account to exist in gopass at all, and vice versa.
# Failing HERE rather than letting an empty secret through is the point: compose
# would happily start containers with blank credentials and leave them
# crash-looping, which is much harder to read than one line of shell output.
if [ -z "${WHATSAPP_PROVIDER:-}" ]; then
  WHATSAPP_PROVIDER="$(read_dotenv WHATSAPP_PROVIDER)"
fi

case "${WHATSAPP_PROVIDER:-kapso}" in
  whatsmeow)
    load_secret BRIDGE_WEBHOOK_SECRET vitrina/bridge_webhook_secret
    load_secret BRIDGE_API_TOKEN vitrina/bridge_api_token
    ;;
  kapso)
    load_secret KAPSO_API_KEY vitrina/kapso_api_key
    load_secret KAPSO_PHONE_NUMBER_ID vitrina/kapso_phone_number_id
    load_secret KAPSO_WEBHOOK_SECRET vitrina/kapso_webhook_secret
    ;;
  *)
    echo "error: unknown WHATSAPP_PROVIDER '${WHATSAPP_PROVIDER}' (expected kapso or whatsmeow)" >&2
    exit 1
    ;;
esac

exec "$@"
