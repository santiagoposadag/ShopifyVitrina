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
export KAPSO_API_KEY="$(gopass show -o vitrina/kapso_api_key)"
export KAPSO_PHONE_NUMBER_ID="$(gopass show -o vitrina/kapso_phone_number_id)"
export KAPSO_WEBHOOK_SECRET="$(gopass show -o vitrina/kapso_webhook_secret)"

exec "$@"
