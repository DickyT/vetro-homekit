# vetro-homekit relay. Pure Node, no dependencies, so the same build works on
# linux/amd64 and linux/arm64. Build from the repository root (see build.sh):
#   docker buildx build -f relay/Dockerfile .
FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="vetro-homekit-relay" \
      org.opencontainers.image.description="Keeps a Samsung TV in Apple Home while it is fully asleep, and wakes it when it is turned on in Home. Companion of the Vetro HomeKit plugin." \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.source="https://github.com/dickyt/vetro-homekit" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://hub.docker.com/r/dickyt/vetro-homekit-relay"
WORKDIR /app
# The relay, and the parts of the TV plugin it shares: the link protocol and the HomeKit stack.
COPY relay/relay.js ./relay.js
COPY homekit/relaylink.js ./homekit/relaylink.js
COPY homekit/hap ./homekit/hap
ENV NODE_ENV=production
USER node
# 8125 (TCP and UDP): the TV finds and talks to the relay. 8126: HomeKit, while standing in.
# Bonjour also uses UDP 5353.
EXPOSE 8125/tcp 8125/udp 8126/tcp 5353/udp
HEALTHCHECK --interval=60s --timeout=5s --start-period=5s CMD wget -qO- "http://127.0.0.1:${RELAY_PORT:-8125}/info" >/dev/null || exit 1
CMD ["node", "relay.js"]
