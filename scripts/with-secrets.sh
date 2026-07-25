#!/bin/sh
# Runs a command with Vitrina's secrets exported from gopass.
#
#   ./scripts/with-secrets.sh docker compose up -d
#   ./scripts/with-secrets.sh npm run dev -w server
#
# With a provider profile (see env.anthropic / env.deepseek and
# docs/provider-swap.md), which also decides WHICH credential is exported:
#
#   ./scripts/with-secrets.sh --profile deepseek npm run dev -w server
#
# Secrets live GPG-encrypted in the gopass store (see docs/secrets-management.md).
# Non-secret config (OWNER_PHONE_NUMBERS, PUBLIC_BASE_URL, NEXT_PUBLIC_*) is not
# handled here — set it in the shell or a .env file as before.
set -eu

if ! command -v gopass >/dev/null 2>&1; then
  echo "error: gopass is not installed (brew install gopass)" >&2
  exit 1
fi

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

PROFILE=""
if [ "${1:-}" = "--profile" ]; then
  if [ $# -lt 2 ]; then
    echo "error: --profile needs a name (anthropic | deepseek)" >&2
    exit 1
  fi
  PROFILE="$2"
  shift 2
fi

# Export one secret, or fail with the command that would create it. A bare
# `gopass show` failure under `set -e` prints a store error and no clue about
# which variable was wanted or how to fix it.
#
# The third argument picks the remedy, because the two kinds of secret here are
# created differently: the bridge's are ours to invent (generate), while a
# provider API key is issued by someone else and can only be pasted in (insert).
# Telling someone to `generate` an API key produces 48 random characters that
# authenticate against nothing.
load_secret() {
  _var="$1"
  _path="$2"
  _kind="${3:-generate}"
  if ! _val="$(gopass show -o "$_path" 2>/dev/null)"; then
    echo "error: no gopass entry at '$_path' (needed for $_var)" >&2
    if [ "$_kind" = "insert" ]; then
      echo "       store the key you were issued:  gopass insert -f $_path" >&2
    else
      echo "       create it with:  gopass generate -n $_path 48" >&2
    fi
    echo "       see docs/secrets-management.md" >&2
    exit 1
  fi
  export "$_var=$_val"
}

# The profile is sourced BEFORE the credential is chosen, and the credential is
# chosen BY profile rather than exported unconditionally. A DeepSeek run that
# still carried ANTHROPIC_API_KEY would hand the SDK two credentials for one
# endpoint — see buildAgentEnv in server/src/agent/agent.ts, which strips the
# unused one for the same reason.
if [ -n "$PROFILE" ]; then
  _profile_file="$REPO_ROOT/env.$PROFILE"
  if [ ! -f "$_profile_file" ]; then
    echo "error: no provider profile at '$_profile_file'" >&2
    echo "       available: anthropic, deepseek (see docs/provider-swap.md)" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$_profile_file"
  set +a
fi

case "$PROFILE" in
  deepseek)
    # DeepSeek's Claude Code guide prescribes the Bearer form. Exported under an
    # ANTHROPIC_ name because that is what the Agent SDK reads — these variable
    # names belong to the SDK, not to Anthropic the company.
    load_secret ANTHROPIC_AUTH_TOKEN vitrina/deepseek_api_key insert
    unset ANTHROPIC_API_KEY 2>/dev/null || true
    ;;
  *)
    load_secret ANTHROPIC_API_KEY vitrina/anthropic_api_key insert
    unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || true
    ;;
esac

# Both sides of the bridge read these, and they must agree: the sidecar signs
# inbound events with the first and accepts /send calls with the second.
load_secret BRIDGE_WEBHOOK_SECRET vitrina/bridge_webhook_secret
load_secret BRIDGE_API_TOKEN vitrina/bridge_api_token

exec "$@"
