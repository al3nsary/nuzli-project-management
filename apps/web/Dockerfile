# syntax=docker/dockerfile:1.7
# Nuzli web app + reverse proxy (the `proxy` service). Build context: the repository root.
#   docker build -f apps/web/Dockerfile -t nuzli-proxy .
# Builds the React app, then serves it with an unprivileged nginx that also terminates TLS
# and proxies /api to the API (infra/nginx/nginx.conf).

ARG NODE_VERSION=20.18.0
ARG PNPM_VERSION=9.12.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

COPY package.json pnpm-workspace.yaml .npmrc ./
COPY pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/scheduling/package.json packages/scheduling/
COPY packages/ui-print/package.json packages/ui-print/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then LOCK=--frozen-lockfile; else LOCK=--no-frozen-lockfile; fi; \
    pnpm install $LOCK --filter "@nuzli/web..."

COPY tsconfig.base.json ./
COPY packages packages
# Demo fixtures (ADR-020) live outside the app; the regular build may still reference them.
COPY seed seed
COPY apps/web apps/web
# Builds shared → scheduling → ui-print → web in topological order. Output: apps/web/dist.
RUN pnpm --filter "@nuzli/web..." run build

# ─────────────────────────────────────────────────────────── runtime (nginx, non-root, uid 101)
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
USER root
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /etc/nginx/snippets /etc/nginx/certs /var/www/acme \
 && chown -R nginx:nginx /var/www/acme
USER nginx
EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
