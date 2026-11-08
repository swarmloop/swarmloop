FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
COPY .env.example /app/.env.example
RUN npm run build && npm prune --omit=dev

# The engine stays on the host. This client talks to the mounted socket.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       arm64) docker_arch=aarch64 ;; \
       amd64) docker_arch=x86_64 ;; \
       *) echo "unsupported ${arch}" && exit 1 ;; \
     esac \
  && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-27.5.1.tgz" -o /tmp/docker.tgz \
  && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker /tmp/docker.tgz \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY skills /app/skills
COPY scripts/agent-env-probe.sh /app/scripts/agent-env-probe.sh

ARG SOURCE_URL=unknown
ARG REVISION=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION

ENV SWARMLOOP_ROOT=/app
EXPOSE 3920
CMD ["node", "dist/api-main.js"]
