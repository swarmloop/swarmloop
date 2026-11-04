FROM node:22-bookworm-slim
COPY proxy.mjs /app/proxy.mjs
# Any user reads it: the proxy runs as whoever owns the policy files.
RUN chmod 0444 /app/proxy.mjs
USER node
EXPOSE 3128 3129
ENTRYPOINT ["node", "/app/proxy.mjs"]
