# syntax=docker/dockerfile:1.7
#
# One image, three roles, chosen by the command:
#   node dist/server.js          API (default)
#   node dist/worker.js          background worker
#   node dist/db/migrate.js      apply database migrations and exit
#
# Multi-stage: TypeScript and dev tooling exist only in the build stage. The runtime image
# gets compiled JavaScript and production dependencies, and runs as an unprivileged user.

FROM node:24-slim AS base
WORKDIR /app

# ---- production dependencies (native modules like sharp and argon2 get linux binaries here)
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- compile TypeScript
FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime
FROM base AS runtime
ENV NODE_ENV=production
# tini as PID 1 forwards SIGTERM to Node (so graceful shutdown actually runs) and reaps zombies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

USER node
EXPOSE 3000
# Readiness: database and Redis reachable, and not shutting down.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
