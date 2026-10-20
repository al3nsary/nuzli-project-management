#!/bin/sh
# API container start (brief §3.1): migrations → idempotent seed → server.
#
# A12 (ADR-143): two database roles.
#   DATABASE_URL      — the migrator / schema owner: runs `prisma migrate deploy` and the seed.
#   APP_DATABASE_URL  — the API's role `nuzli_app` (created by the A12 migration; no superuser, no
#                       BYPASSRLS), so PostgreSQL Row Level Security applies to every request.
# Without APP_DATABASE_URL the server keeps using DATABASE_URL and logs that RLS is bypassed;
# DB_REQUIRE_RLS=true turns that into a refusal to start.
set -eu
cd /repo/apps/api

echo "[entrypoint] prisma migrate deploy"
prisma migrate deploy --schema ./prisma/schema.prisma

echo "[entrypoint] system seed (workspaces, settings, palette, calendar, card sizes, bootstrap owner, nuzli_app login)"
node dist/seed/seed.js

if [ -n "${APP_DATABASE_URL:-}" ]; then
  echo "[entrypoint] the API connects as the application role (APP_DATABASE_URL)"
  export DATABASE_URL="$APP_DATABASE_URL"
elif [ "${DB_REQUIRE_RLS:-false}" = "true" ]; then
  echo "[entrypoint] ERROR: DB_REQUIRE_RLS=true but APP_DATABASE_URL is not set (docs/deployment-rls.md)" >&2
  exit 1
else
  echo "[entrypoint] WARNING: APP_DATABASE_URL is not set — the API uses the migrator role and RLS may be bypassed (docs/a12-isolation-design.md)"
fi

echo "[entrypoint] starting API on port ${PORT:-3000}"
exec node dist/main.js
