#!/bin/sh
# Fire a signed, Meta-shaped inbound event at a running server.
#
#   WHATSAPP_APP_SECRET=... ./scripts/simulate-cloud-inbound.sh 573009998877 "hola"
#
# The Cloud API twin of simulate-inbound.sh, and it earns its own file because
# the two payloads have nothing in common: Meta nests messages under
# entry[].changes[].value, signs with the APP SECRET, and always sends the
# "sha256=" prefixed header.
#
# This exercises signature verification, the parser, inbox dedupe, the batcher,
# the agent turn and the outbound reply WITHOUT the number being registered — so
# it is how the cut-over gets rehearsed before the point of no return, and how a
# message gets reproduced afterwards without a phone.
set -eu

PHONE="${1:-573009998877}"
TEXT="${2:-hola, tienen camisas azules?}"
URL="${WEBHOOK_URL:-http://localhost:3001/webhook}"

if [ -z "${WHATSAPP_APP_SECRET:-}" ] && [ -f .env ]; then
  WHATSAPP_APP_SECRET="$(sed -n 's/^[[:space:]]*WHATSAPP_APP_SECRET[[:space:]]*=[[:space:]]*//p' .env |
    tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
fi
if [ -z "${WHATSAPP_APP_SECRET:-}" ]; then
  echo "error: WHATSAPP_APP_SECRET is not set (export it, or put it in .env)" >&2
  exit 1
fi

escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# A unique wamid per run. Pass MESSAGE_ID to test dedupe on purpose: send the
# same id twice and the second must NOT create a row.
ID="${MESSAGE_ID:-wamid.sim-$(date +%s)-$$}"
PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID:-1234567890}"

BODY="{\"object\":\"whatsapp_business_account\",\"entry\":[{\"id\":\"WABA\",\"changes\":[{\"field\":\"messages\",\"value\":{\"messaging_product\":\"whatsapp\",\"metadata\":{\"display_phone_number\":\"$(escape "$PHONE")\",\"phone_number_id\":\"$(escape "$PHONE_NUMBER_ID")\"},\"contacts\":[{\"profile\":{\"name\":\"Simulado\"},\"wa_id\":\"$(escape "$PHONE")\"}],\"messages\":[{\"from\":\"$(escape "$PHONE")\",\"id\":\"$(escape "$ID")\",\"timestamp\":\"$(date +%s)\",\"type\":\"text\",\"text\":{\"body\":\"$(escape "$TEXT")\"}}]}}]}]}"

# Sign the EXACT bytes we send, as Meta does — X-Hub-Signature-256 is HMAC-SHA256
# of the raw body keyed with the app secret.
SIGNATURE="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" -hex | sed 's/.*= //')"

echo "→ POST $URL"
echo "  id=$ID from=$PHONE"
curl -sS -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "x-hub-signature-256: sha256=$SIGNATURE" \
  -d "$BODY" \
  -w '\n  http %{http_code}\n'
