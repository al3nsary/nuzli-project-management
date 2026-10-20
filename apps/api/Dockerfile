# syntax=docker/dockerfile:1.7
# Nuzli API — multi-stage build. Build context: the repository root.
#   docker build -f apps/api/Dockerfile -t nuzli-api .
# Stages: manifests → deps → build → (dev | prod-deps → assemble → runtime)
#
# Reproducible (ADR-168): every install is `npm ci` from the committed package-lock.json (npm
# workspaces). The build fails when package.json and the lockfile disagree — nothing is resolved
# at build time. The Prisma CLI (needed by `prisma migrate deploy`) comes from the lockfile too.

ARG NODE_VERSION=20.18.0

# ─────────────────────────────────────────────────────────── base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    TZ=UTC \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ─────────────────────────────────────────────────────────── manifests only (cache friendly)
# npm ci checks the lockfile against EVERY workspace manifest, so all five are copied.
FROM base AS manifests
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/scheduling/package.json packages/scheduling/
COPY packages/ui-print/package.json packages/ui-print/

# ─────────────────────────────────────────────────────────── all dependencies of the API and its packages
FROM manifests AS deps
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci -w @nuzli/api -w @nuzli/shared -w @nuzli/scheduling

# ─────────────────────────────────────────────────────────── compile
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/scheduling packages/scheduling
COPY apps/api apps/api
# Prisma client + query engines for every binaryTarget of schema.prisma (native,
# debian-openssl-3.0.x, linux-musl-openssl-3.0.x) land in /repo/node_modules/.prisma.
RUN npm run build -w @nuzli/shared \
 && npm run build -w @nuzli/scheduling \
 && cd apps/api \
 && npx prisma generate \
 && npx nest build

# ─────────────────────────────────────────────────────────── dev (hot reload, docker-compose.dev.yml)
FROM build AS dev
ENV NODE_ENV=development \
    PATH=/repo/node_modules/.bin:$PATH
RUN chown -R node:node /repo/apps/api
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["sh", "-c", "prisma migrate deploy && nest build && node dist/seed/seed.js && exec nest start --watch --preserveWatchOutput"]

# ─────────────────────────────────────────────────────────── production dependencies only
# `prisma` (CLI + schema engine) is a production dependency of the lockfile, so migrate deploy
# works without a global install; @prisma/engines downloads the schema engine for this platform.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci --omit=dev -w @nuzli/api

FROM prod-deps AS assemble
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/scheduling/dist packages/scheduling/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/node_modules/.prisma node_modules/.prisma
COPY apps/api/prisma apps/api/prisma
COPY apps/api/docker-entrypoint.sh apps/api/docker-entrypoint.sh
# ADR-169: the production image carries no demo seed and no demo data. `npm run seed:demo`
# cannot run here at all (and refuses NODE_ENV=production elsewhere unless ALLOW_DEMO_SEED=true).
RUN rm -f apps/api/dist/seed/seed-demo.js apps/api/dist/seed/seed-demo.js.map \
 && test ! -e /repo/seed \
 && test -f node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node \
 && test -x node_modules/.bin/prisma

# ─────────────────────────────────────────────────────────── runtime
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PATH=/repo/node_modules/.bin:$PATH \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    NPM_CONFIG_CACHE=/tmp/.npm
COPY --from=assemble /repo /repo
# Security review L9: the code stays owned by root and only readable by the runtime user, so a
# compromised process cannot rewrite dist/ or node_modules. Compose also mounts the root
# filesystem read-only with a tmpfs /tmp (docker-compose.yml); nothing below writes elsewhere.
RUN chown -R root:root /repo \
 && chmod -R a+rX,go-w /repo \
 && chmod 0755 /repo/apps/api/docker-entrypoint.sh
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/repo/apps/api/docker-entrypoint.sh"]
