#!/usr/bin/env bash
# Bring the local dev stack up and print the webhook URL.
#
#   ./scripts/dev-up.sh              # server + tunnel + a log window
#   ./scripts/dev-up.sh --echo       # ECHO_MODE: no agent, no Shopify, no model
#   ./scripts/dev-up.sh --no-window  # skip opening Terminal
#   ./scripts/dev-up.sh --down       # stop both
#
# IDEMPOTENT: whatever is already running is left alone, so re-running it just
# reprints the URL. That matters because a cloudflared quick tunnel gets a NEW
# subdomain every start, and every restart means editing the callback URL in
# Meta's panel by hand.
#
# Deliberately bash 3.2 compatible: macOS ships 3.2, and a script nobody can run
# is not a script.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

PORT="${PORT:-3005}"
DIR=data/dev
SERVER_LOG="$DIR/server.log"
TUNNEL_LOG="$DIR/tunnel.log"
ECHO_MODE=false
OPEN_WINDOW=true

for arg in "$@"; do
  case "$arg" in
    --echo)       ECHO_MODE=true ;;
    --no-window)  OPEN_WINDOW=false ;;
    --down)
      pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null
      PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)
      [ -n "$PID" ] && kill $PID 2>/dev/null
      echo "stopped (port $PORT)"
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$DIR"

# --- server ------------------------------------------------------------------
# A /health that answers is NOT proof our server is the one answering: another
# project on the same port responds too, and tunnelling to it points Meta at the
# wrong application. Ours returns {status,time} and nothing else.
health() { curl -sf --max-time 3 "http://localhost:$PORT/health" 2>/dev/null; }
is_ours() { health | grep -q '"time"' && ! health | grep -q '"adapters"'; }

if is_ours; then
  echo "server  : already up on :$PORT"
elif health >/dev/null; then
  echo "ERROR: something else is listening on :$PORT — it answers /health but is not Vitrina." >&2
  echo "       Pick another port:  PORT=3010 ./scripts/dev-up.sh" >&2
  exit 1
else
  echo "server  : starting on :$PORT$([ "$ECHO_MODE" = true ] && echo ' (ECHO_MODE)')"
  ECHO_MODE="$ECHO_MODE" WHATSAPP_PROVIDER=cloud PORT="$PORT" \
    nohup npx tsx server/src/index.ts > "$SERVER_LOG" 2>&1 &
  for _ in $(seq 1 45); do is_ours && break; sleep 1; done
  if ! is_ours; then
    echo "ERROR: the server did not come up. Last lines of $SERVER_LOG:" >&2
    tail -n 15 "$SERVER_LOG" >&2
    exit 1
  fi
fi

# --- tunnel ------------------------------------------------------------------
tunnel_url() { grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1; }

if pgrep -f "cloudflared tunnel --url http://localhost:$PORT" >/dev/null 2>&1 && [ -n "$(tunnel_url)" ]; then
  echo "tunnel  : already up"
else
  echo "tunnel  : starting"
  : > "$TUNNEL_LOG"
  nohup cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
  for _ in $(seq 1 45); do [ -n "$(tunnel_url)" ] && break; sleep 1; done
fi

URL="$(tunnel_url)"
if [ -z "$URL" ]; then
  echo "ERROR: the tunnel produced no URL. Last lines of $TUNNEL_LOG:" >&2
  tail -n 15 "$TUNNEL_LOG" >&2
  exit 1
fi

# --- verify through the tunnel -----------------------------------------------
# Through the PUBLIC path, not localhost: that is the path Meta uses, and it is
# the only one that proves anything. Resolved via 1.1.1.1 on purpose — a router
# with DNS-rebind protection NXDOMAINs a freshly created trycloudflare host,
# which breaks this check while Meta reaches it perfectly well.
HOST="${URL#https://}"
IP=""
for _ in $(seq 1 15); do
  IP=$(nslookup "$HOST" 1.1.1.1 2>/dev/null | awk '/^Address: /{print $2; exit}')
  [ -n "$IP" ] && break
  sleep 2
done

CODE=000
if [ -n "$IP" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$HOST:443:$IP" "$URL/health")
fi
echo "reachable: http $CODE (through the tunnel)"

VERIFY=$(sed -n 's/^[[:space:]]*WHATSAPP_VERIFY_TOKEN[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | tail -1 | tr -d '"'"'"' \r')
if [ -n "$VERIFY" ] && [ -n "$IP" ]; then
  GOT=$(curl -s --max-time 20 --resolve "$HOST:443:$IP" \
    "$URL/webhook?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=vitrina-check")
  [ "$GOT" = "vitrina-check" ] \
    && echo "handshake: OK — Meta will accept this URL" \
    || echo "handshake: FAILED (got: ${GOT:0:60}) — check WHATSAPP_VERIFY_TOKEN"
fi

# --- log window --------------------------------------------------------------
if [ "$OPEN_WINDOW" = true ] && [ "$(uname)" = "Darwin" ]; then
  cat > "$DIR/follow.command" <<EOF
#!/bin/bash
cd "$(pwd)"
printf '\033]0;Vitrina — live log\007'
clear
echo "Vitrina · live log · :$PORT · $HOST      (Ctrl-C to quit)"
echo
tail -n 40 -f "$SERVER_LOG" | python3 scripts/dev-log.py
EOF
  chmod +x "$DIR/follow.command"
  open -a Terminal "$DIR/follow.command"
  echo "log     : opened a Terminal window"
else
  echo "log     : tail -f $SERVER_LOG | python3 scripts/dev-log.py"
fi

echo
echo "═══ WEBHOOK URL — paste into Meta ═══"
echo "$URL/webhook"
echo
echo "A quick tunnel gets a NEW subdomain on every start, so this changes each"
echo "time it restarts. The 'messages' field and the number-level toggle survive"
echo "a URL edit — you only re-verify the URL itself."
