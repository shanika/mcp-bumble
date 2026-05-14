# syntax=docker/dockerfile:1.6

# ---- Build stage ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Prune to production deps for the final image
RUN npm prune --omit=dev

# ---- Runtime stage --------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# busybox supplies crond; tzdata lets SYNC_TZ resolve to a real zone
RUN apk add --no-cache tzdata

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DB_PATH=/data/bumble.db \
    SYNC_CRON_HOUR=2 \
    SYNC_CRON_MINUTE=0 \
    SYNC_TZ=Pacific/Auckland

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["mcp"]
