#!/bin/bash
# pack.sh [shard-folder] [output-file]
#
# Packs a Vetro shard folder into a .vplugin bundle: one JSON file holding the
# manifest and every text file of the shard. This is the file Vetro installs
# ("Install from a file" in the dashboard) and the one attached to releases.
#
# Defaults: folder "homekit", output dist/<id>-<version>.vplugin.
# Prints "<id> <sha256> <output-file>" on stdout and the file names on stderr.
#
# manifest.json becomes the "manifest" object (it is not repeated in "files").
# Dot-files and dot-directories are skipped. config.json is never packed: on a
# TV it holds private keys.

PY=/opt/homebrew/bin/python3
[ -x "$PY" ] || PY=python3
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARD=${1:-$HERE/homekit}
if [ ! -f "$SHARD/manifest.json" ]; then
  echo "error: $SHARD/manifest.json not found" >&2
  exit 2
fi

"$PY" -I -c '
import hashlib, json, os, re, sys
folder, out, here = sys.argv[1], sys.argv[2], sys.argv[3]
LIMIT = 512 * 1024
MAX_FILES = 20
with open(os.path.join(folder, "manifest.json"), "rb") as f:
    manifest = json.loads(f.read().decode("utf-8"))
mid = manifest.get("id")
if not isinstance(mid, str) or not re.match(r"^[a-z][a-z0-9-]{1,31}$", mid):
    sys.exit("error: manifest id is missing or invalid: %r" % (mid,))
version = manifest.get("version")
if not isinstance(version, str) or not re.match(r"^\d+\.\d+\.\d+$", version):
    sys.exit("error: manifest version is missing or not of the form 1.2.3: %r" % (version,))
files = {}
for root, dirs, names in os.walk(folder):
    dirs[:] = sorted(d for d in dirs if not d.startswith("."))
    for name in sorted(names):
        if name.startswith("."):
            continue
        full = os.path.join(root, name)
        rel = os.path.relpath(full, folder).replace(os.sep, "/")
        if rel == "manifest.json":
            continue
        if rel == "config.json":
            print("skipped config.json (never packed)", file=sys.stderr)
            continue
        with open(full, "rb") as f:
            files[rel] = f.read().decode("utf-8")
        print("file:", rel, file=sys.stderr)
if not files:
    sys.exit("error: no files to pack")
if len(files) > MAX_FILES:
    sys.exit("error: %d files, over the limit of %d" % (len(files), MAX_FILES))
total = sum(len(v.encode("utf-8")) for v in files.values())
if total > LIMIT:
    sys.exit("error: files total %d bytes, over the 512 KiB bundle limit" % total)
body = json.dumps({"format": "vetro-plugin", "version": 1, "manifest": manifest, "files": files}).encode("ascii")
if not out:
    out = os.path.join(here, "dist", "%s-%s.vplugin" % (mid, version))
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, "wb") as f:
    f.write(body)
print(mid, hashlib.sha256(body).hexdigest(), out)
' "$SHARD" "${2:-}" "$HERE"
