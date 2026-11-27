#!/bin/bash
# Builds the relay image for linux/amd64 and linux/arm64.
#   relay/build.sh                 one image file per architecture in relay/dist/
#                                  (import the one that matches the NAS)
#   relay/build.sh push <name>     one multi-architecture image pushed to a registry
#                                  you are signed in to, e.g. registry.example/vetro-homekit-relay
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -e 'console.log(require("./homekit/manifest.json").version)')
if [ "$1" = push ]; then
  [ -n "$2" ] || { echo "usage: relay/build.sh push <registry/name>"; exit 2; }
  docker buildx build --platform linux/amd64,linux/arm64 --build-arg VERSION="$VERSION" -f relay/Dockerfile -t "$2:$VERSION" -t "$2:latest" --push .
  echo "pushed $2:$VERSION and $2:latest"
  exit 0
fi
mkdir -p relay/dist
for arch in amd64 arm64; do
  out=relay/dist/vetro-homekit-relay-$VERSION-$arch.tar
  docker buildx build --platform linux/$arch --build-arg VERSION="$VERSION" -f relay/Dockerfile -t vetro-homekit-relay:$VERSION -t vetro-homekit-relay:latest --output type=docker,dest=$out .
  echo "built $out"
done
