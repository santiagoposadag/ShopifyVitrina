#!/bin/sh
# Fire a signed, bridge-shaped inbound event at a running server.
#
#   BRIDGE_WEBHOOK_SECRET=... ./scripts/simulate-inbound.sh 573009998877 "hola"
#
# This exercises everything the bridge would trigger — signature verification,
# inbox dedupe, the batcher, the agent turn, the outbound reply — WITHOUT a
# paired WhatsApp number. It is the only way to test the pipeline before pairing,
# and it stays useful afterwards for reproducing a message without a phone.
#
# It does NOT test whatsmeow itself: pairing, LID resolution, media decryption and
# real delivery all need a live session. See "Assumptions to verify" in README.md.
set -eu

PHONE="${1:-573009998877}"
TEXT="${2:-hola, busco apartamento}"
URL="${WEBHOOK_URL:-http://localhost:3001/webhook}"

if [ -z "${BRIDGE_WEBHOOK_SECRET:-}" ] && [ -f .env ]; then
  BRIDGE_WEBHOOK_SECRET="$(sed -n 's/^[[:space:]]*BRIDGE_WEBHOOK_SECRET[[:space:]]*=[[:space:]]*//p' .env |
    tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
fi
if [ -z "${BRIDGE_WEBHOOK_SECRET:-}" ]; then
  echo "error: BRIDGE_WEBHOOK_SECRET is not set (export it, or put it in .env)" >&2
  exit 1
fi

# Escape the two characters that would break out of the JSON string. Anything
# fancier belongs in a real client, not a smoke-test script.
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# A unique id per run, so repeated calls are separate messages rather than
# duplicates the inbox correctly refuses. Pass MESSAGE_ID to test dedupe on
# purpose: send the same id twice and the second must NOT create a row.
ID="${MESSAGE_ID:-sim-$(date +%s)-$$}"

BODY="{\"provider\":\"whatsmeow\",\"id\":\"$(escape "$ID")\",\"from\":\"$(escape "$PHONE")\",\"timestamp\":$(date +%s),\"type\":\"text\",\"text\":\"$(escape "$TEXT")\"}"

# Sign the EXACT bytes we send, as bridge/delivery.go does.
SIGNATURE="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$BRIDGE_WEBHOOK_SECRET" -hex | sed 's/.*= //')"

echo "→ POST $URL"
echo "  id=$ID from=$PHONE"
curl -sS -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "x-webhook-signature: $SIGNATURE" \
  -d "$BODY" \
  -w '\n  http %{http_code}\n'
