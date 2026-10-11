#!/bin/sh
# API container start (brief §3.1): migrations → idempotent seed → server.
set -eu
cd /repo/apps/api

echo "[entrypoint] prisma migrate deploy"
prisma migrate deploy --schema ./prisma/schema.prisma

echo "[entrypoint] system seed (settings, palette, calendar, card sizes, bootstrap admin)"
node dist/seed/seed.js

echo "[entrypoint] starting API on port ${PORT:-3000}"
exec node dist/main.js
