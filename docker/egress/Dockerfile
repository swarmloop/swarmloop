FROM node:22-bookworm-slim
ARG SOURCE_URL=unknown
ARG REVISION=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION
COPY proxy.mjs /app/proxy.mjs
# Any user reads it: the proxy runs as whoever owns the policy files.
RUN chmod 0444 /app/proxy.mjs
USER node
EXPOSE 3128 3129
ENTRYPOINT ["node", "/app/proxy.mjs"]
