# syntax=docker/dockerfile:1.7
# JETPOOL web (Next.js 15) image. Build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.staging.jetpool.kr -t jetpool-web .
# Works whether or not next.config sets `output: 'standalone'`:
#   - .next/standalone present -> minimal runtime: node server.js
#   - standalone absent        -> pruned production node_modules + `next start`
# The chosen mode is written to /app/.jetpool-web-mode and read by infra/docker/web-entrypoint.sh.
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.28.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------- fetch: lockfile-only layer, cached until pnpm-lock.yaml changes ----------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

# ---------- build ----------
FROM fetch AS build
# NEXT_PUBLIC_* values are inlined at build time -> build one image per environment.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NODE_ENV=production
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_ENV=development pnpm install --offline --frozen-lockfile --filter "@jetpool/web..."
RUN pnpm --filter @jetpool/web build
# Assemble /out for whichever runtime mode the build produced.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store set -eu; \
    mkdir -p /out; \
    if [ -d apps/web/.next/standalone ]; then \
      cp -a apps/web/.next/standalone/. /out/; \
      server="$(cd /out && find . -name server.js -not -path '*/node_modules/*' | head -n1)"; \
      test -n "$server"; \
      appdir="$(dirname "$server")"; \
      mkdir -p "/out/$appdir/.next"; \
      cp -a apps/web/.next/static "/out/$appdir/.next/static"; \
      if [ -d apps/web/public ]; then cp -a apps/web/public "/out/$appdir/public"; fi; \
      printf 'standalone %s\n' "$server" > /out/.jetpool-web-mode; \
    else \
      pnpm install --offline --frozen-lockfile --prod --filter "@jetpool/web..."; \
      cp -a node_modules package.json /out/; \
      mkdir -p /out/apps; cp -a apps/web /out/apps/web; \
      rm -rf /out/apps/web/.next/cache /out/apps/web/Dockerfile; \
      printf 'next-start ./apps/web\n' > /out/.jetpool-web-mode; \
    fi; \
    cat /out/.jetpool-web-mode

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node infra/docker/web-entrypoint.sh /usr/local/bin/jetpool-web
RUN chmod 0555 /usr/local/bin/jetpool-web
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="jetpool-web" \
      org.opencontainers.image.source="https://github.com/jetpool/jetpool" \
      org.opencontainers.image.revision="${GIT_SHA}"
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jetpool-web"]
