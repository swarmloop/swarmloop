FROM node:22-bookworm-slim

WORKDIR /app
COPY next/package.json next/package-lock.json ./
RUN npm ci
COPY next/ ./
# Rewrites are stored at build time, so the API host has to exist before next build.
ENV SWARMLOOP_API_URL=http://nest:3920
ENV NEXT_PUBLIC_SWARMLOOP_SOCKET=http://127.0.0.1:3920
ENV PORT=3921
RUN npm run build
EXPOSE 3921
CMD ["npm", "start"]
