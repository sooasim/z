# syntax=docker/dockerfile:1.7
# JETPOOL API image — one image, several commands (see infra/docker/api-entrypoint.sh):
#   docker run IMAGE api              # HTTP API (default)
#   docker run IMAGE worker           # outbox dispatcher + scheduled sweeps
#   docker run IMAGE migrate          # forward-only migrations (packages/db/migrate.mjs), one-shot
#   docker run IMAGE migrate-verify   # apply twice on a scratch DB (G2)
# Build from the repo root:  docker build -f apps/api/Dockerfile -t jetpool-api .
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.28.0

# ---------- base: node + pinned pnpm ----------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------- fetch: download every package in the lockfile (cached by lockfile only) ----------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

# ---------- build: full (dev) install + tsc ----------
FROM fetch AS build
# whole workspace (filtered by .dockerignore) so the lockfile importers all resolve
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @jetpool/api --filter @jetpool/db
RUN pnpm --filter @jetpool/api build && test -f apps/api/dist/server.js && test -f apps/api/dist/worker.js

# ---------- prod-deps: production-only node_modules for api + db ----------
FROM fetch AS prod-deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter @jetpool/api --filter @jetpool/db

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0 NODE_OPTIONS=--enable-source-maps
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node packages/db/package.json packages/db/migrate.mjs ./packages/db/
COPY --chown=node:node packages/db/migrations ./packages/db/migrations
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node infra/docker/api-entrypoint.sh /usr/local/bin/jetpool
COPY --chown=node:node infra/docker/healthcheck.mjs /usr/local/lib/jetpool-healthcheck.mjs
RUN chmod 0555 /usr/local/bin/jetpool
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="jetpool-api" \
      org.opencontainers.image.source="https://github.com/jetpool/jetpool" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV JETPOOL_RELEASE=${GIT_SHA}
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/lib/jetpool-healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jetpool"]
CMD ["api"]
