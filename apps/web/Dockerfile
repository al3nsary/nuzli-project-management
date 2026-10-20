# syntax=docker/dockerfile:1.7
# Nuzli web app + reverse proxy (the `proxy` service). Build context: the repository root.
#   docker build -f apps/web/Dockerfile -t nuzli-proxy .
# Builds the React app, then serves it with an unprivileged nginx that also terminates TLS
# and proxies /api to the API (infra/nginx/nginx.conf).

ARG NODE_VERSION=20.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV CI=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /repo

# Reproducible (ADR-168): npm ci from the committed package-lock.json. npm ci checks the lockfile
# against every workspace manifest, so all five are copied.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/scheduling/package.json packages/scheduling/
COPY packages/ui-print/package.json packages/ui-print/
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci -w @nuzli/web -w @nuzli/shared -w @nuzli/scheduling -w @nuzli/ui-print

COPY tsconfig.base.json ./
COPY packages packages
# Demo fixtures (ADR-020) are type-checked with the app; the production bundle never includes
# the demo data (ADR-027, the DemoApi is behind VITE_DEMO) — checked below.
COPY seed seed
COPY apps/web apps/web
# shared → scheduling → ui-print → web, in dependency order. Output: apps/web/dist.
RUN npm run build -w @nuzli/shared \
 && npm run build -w @nuzli/scheduling \
 && npm run build -w @nuzli/ui-print \
 && npm run build -w @nuzli/web \
 && if grep -rq "NuzliDemo2026" apps/web/dist; then echo "demo data found in the production bundle" >&2; exit 1; fi

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
