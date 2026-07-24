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

load_secret ANTHROPIC_API_KEY vitrina/anthropic_api_key
# Both sides of the bridge read these, and they must agree: the sidecar signs
# inbound events with the first and accepts /send calls with the second.
load_secret BRIDGE_WEBHOOK_SECRET vitrina/bridge_webhook_secret
load_secret BRIDGE_API_TOKEN vitrina/bridge_api_token

exec "$@"
