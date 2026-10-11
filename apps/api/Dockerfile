# syntax=docker/dockerfile:1.7
# Nuzli API — multi-stage build. Build context: the repository root.
#   docker build -f apps/api/Dockerfile -t nuzli-api .
# Stages: manifests → deps → build → (dev | prod-deps → assemble → runtime)

ARG NODE_VERSION=20.18.0
ARG PNPM_VERSION=9.12.0
ARG PRISMA_VERSION=5.22.0

# ─────────────────────────────────────────────────────────── base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TZ=UTC
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ─────────────────────────────────────────────────────────── manifests only (cache friendly)
FROM base AS manifests
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/scheduling/package.json packages/scheduling/

# ─────────────────────────────────────────────────────────── all dependencies
FROM manifests AS deps
# ADR-022: frozen lockfile once pnpm-lock.yaml is committed; until then resolve fresh.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then LOCK=--frozen-lockfile; else LOCK=--no-frozen-lockfile; fi; \
    pnpm install $LOCK --filter "@nuzli/api..."

# ─────────────────────────────────────────────────────────── compile
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/scheduling packages/scheduling
COPY apps/api apps/api
RUN pnpm --filter "@nuzli/api^..." run build \
 && pnpm --filter @nuzli/api exec prisma generate \
 && pnpm --filter @nuzli/api run build

# ─────────────────────────────────────────────────────────── dev (hot reload, docker-compose.dev.yml)
FROM build AS dev
ENV NODE_ENV=development
RUN chown -R node:node /repo/apps/api
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
ENV PATH=/repo/apps/api/node_modules/.bin:$PATH
CMD ["sh", "-c", "prisma migrate deploy && nest build && node dist/seed/seed.js && exec nest start --watch --preserveWatchOutput"]

# ─────────────────────────────────────────────────────────── production dependencies only
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then LOCK=--frozen-lockfile; else LOCK=--no-frozen-lockfile; fi; \
    pnpm install $LOCK --prod --filter "@nuzli/api..."

FROM prod-deps AS assemble
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/scheduling/dist packages/scheduling/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
COPY apps/api/docker-entrypoint.sh apps/api/docker-entrypoint.sh

# ─────────────────────────────────────────────────────────── runtime
FROM base AS runtime
ARG PRISMA_VERSION
ENV NODE_ENV=production \
    PORT=3000
# The Prisma CLI (a devDependency) is needed at runtime for `prisma migrate deploy`.
RUN npm install -g prisma@${PRISMA_VERSION} && npm cache clean --force
COPY --from=assemble /repo /repo
# Generate the client into the production node_modules (engines for debian-openssl-3.0.x).
RUN prisma generate --schema /repo/apps/api/prisma/schema.prisma \
 && chmod 0755 /repo/apps/api/docker-entrypoint.sh \
 && chown -R node:node /repo/apps/api
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/repo/apps/api/docker-entrypoint.sh"]
