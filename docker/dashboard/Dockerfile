FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
RUN npm ci --workspace dashboard --include-workspace-root=false
COPY dashboard/ ./dashboard/
# Rewrites are stored at build time, so the API host has to exist before next build.
ENV SWARMLOOP_API_URL=http://server:3920
ENV NEXT_PUBLIC_SWARMLOOP_SOCKET=http://127.0.0.1:3920
ENV PORT=3921
RUN npm run build --workspace dashboard
WORKDIR /app/dashboard
EXPOSE 3921
CMD ["npm", "start"]
