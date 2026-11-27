#!/bin/bash
# Shows the shard's state on the TV and whether the Mac can see it over Bonjour.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/tools/local.env" ] && . "$ROOT/tools/local.env"
TV=${VETRO_HOST:-${TV_HOST:?set TV_HOST in tools/local.env}}
curl -s -m 5 "http://$TV:8099/plugins/homekit/api/state" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
log = d.pop("log", [])
print(json.dumps(d, indent=1))
print("--- log (newest last)")
print("\n".join(log[-25:]))
'
echo "--- Bonjour browse _hap._tcp (6 s)"
perl -e 'alarm 6; exec @ARGV' script -q /dev/null dns-sd -B _hap._tcp local. 2>&1 | tr -d '\r' | grep -v -E "^DATE|STARTING"
echo "--- resolve"
NAME=$(curl -s -m 5 "http://$TV:8099/plugins/homekit/api/state" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); m=d.get("mdns") or {}; print((m.get("detail") or {}).get("name") or d.get("name"))')
perl -e 'alarm 4; exec @ARGV' script -q /dev/null dns-sd -L "$NAME" _hap._tcp local. 2>&1 | tr -d '\r' | grep -v -E "^DATE|STARTING" | head -4
