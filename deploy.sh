#!/bin/bash
# deploy.sh <shard-folder>
#
# Installs a Vetro shard folder on the TV over the HTTP plugin API (port 8099)
# as an unsigned bundle, then enables it. Sequence:
#   1. GET  /plugins                -> developer mode must be on (switched on only if it is off)
#   2. GET  /plugins/<id>           -> if installed (HTTP 200): POST /plugins/<id>/disable
#   3. POST /plugins/install        -> bundle JSON built from the folder
#   4. POST /plugins/<id>/enable
# Every call prints its HTTP status and response body. Stops at the first failure.
#
# The bundle is built by pack.sh (the same .vplugin file that releases carry).
# config.json is never sent: it holds private keys and the TV keeps its own copy on update.
#
# Auth: none is needed while Vetro pairing is off (LAN calls with no Origin header
# are accepted). If pairing is turned on, export VETRO_TOKEN=<64 hex key> first;
# it is sent as "Authorization: Bearer".
#
# Where the TV is: VETRO_HOST, or TV_HOST in tools/local.env (see tools/local.env.example).
# VETRO_PORT defaults to 8099.

PY=/opt/homebrew/bin/python3
[ -x "$PY" ] || PY=python3

if [ $# -ne 1 ]; then
  echo "usage: $0 <shard-folder>" >&2
  exit 2
fi
SHARD=$1
if [ ! -f "$SHARD/manifest.json" ]; then
  echo "error: $SHARD/manifest.json not found" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/tools/local.env" ] && . "$HERE/tools/local.env"
HOST=${VETRO_HOST:-${TV_HOST:-}}
if [ -z "$HOST" ]; then
  echo "error: set VETRO_HOST, or TV_HOST in tools/local.env, to the TV's address" >&2
  exit 2
fi
BASE="http://$HOST:${VETRO_PORT:-8099}"
AUTH_ARGS=()
if [ -n "${VETRO_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $VETRO_TOKEN")
fi

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "error: $*" >&2
  exit 1
}

# Build the bundle (pack.sh prints "<id> <sha256> <file>" on stdout, file names on stderr).
BUILD_OUT=$(bash "$HERE/pack.sh" "$SHARD" "$WORK/bundle.json") || fail "could not build bundle from $SHARD"
read -r ID SHA _ <<<"$BUILD_OUT"
echo "bundle: id=$ID bytes=$(wc -c <"$WORK/bundle.json" | tr -d ' ') sha256=$SHA"

# call LABEL METHOD PATH [extra curl args...]
# Sets CODE (HTTP status, 000 if no connection) and BODY; prints both.
call() {
  local label=$1 method=$2 path=$3 rc
  shift 3
  CODE=$(curl -sS -m 60 -X "$method" ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
    -H 'Content-Type: application/json' -o "$WORK/resp" -w '%{http_code}' "$@" "$BASE$path" 2>"$WORK/err")
  rc=$?
  if [ $rc -ne 0 ]; then
    CODE=000
    echo "[$label] curl error (rc $rc): $(cat "$WORK/err")"
  fi
  BODY=$(cat "$WORK/resp" 2>/dev/null)
  echo "[$label] $method $path -> HTTP $CODE"
  echo "$BODY"
}

# True if the last call returned HTTP 200 with JSON {"ok": true}.
ok_json() {
  [ "$CODE" = 200 ] || return 1
  printf '%s' "$BODY" | "$PY" -I -c 'import json, sys
sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)' 2>/dev/null
}

# 1. Developer mode (needed for unsigned installs). Only switched on if currently off.
call list GET /plugins
[ "$CODE" = 200 ] || fail "cannot read GET /plugins (HTTP $CODE)"
DEV=$(printf '%s' "$BODY" | "$PY" -I -c 'import json, sys
print("yes" if json.load(sys.stdin).get("developer") is True else "no")') || fail "cannot parse GET /plugins"
if [ "$DEV" = yes ]; then
  echo "[developer] already on, not changed"
else
  call developer POST /plugins/developer --data-binary '{"on":true}'
  ok_json || fail "could not switch developer mode on"
fi

# 2. Disable the shard if it is installed (install refuses to replace a running shard).
call status GET "/plugins/$ID"
if [ "$CODE" = 200 ]; then
  call disable POST "/plugins/$ID/disable"
  ok_json || fail "could not disable $ID"
elif [ "$CODE" = 404 ]; then
  echo "[disable] skipped: $ID is not installed"
else
  fail "unexpected HTTP $CODE from GET /plugins/$ID"
fi

# 3. Install the bundle (shard lands switched off).
call install POST /plugins/install --data-binary "@$WORK/bundle.json" -H "x-vetro-sha256: $SHA"
ok_json || fail "install of $ID failed"

# 4. Enable.
call enable POST "/plugins/$ID/enable"
ok_json || fail "could not enable $ID"

echo "deployed $ID"
