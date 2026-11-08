FROM node:22-bookworm-slim

WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
# The dashboard compiles the API contract through ../server/src/contract.
COPY server/src/contract /app/server/src/contract
ENV PORT=3921
RUN npm run build
ARG SOURCE_URL=unknown
ARG REVISION=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION
EXPOSE 3921
CMD ["npm", "start"]
