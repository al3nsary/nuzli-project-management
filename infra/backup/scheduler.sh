#!/bin/sh
# Runs backup.sh once a day at BACKUP_TIME (HH:MM, UTC). A plain sleep loop instead of crond,
# so the container needs no root. BACKUP_ON_START=true also takes one backup at start-up.
set -eu

: "${BACKUP_TIME:=02:00}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required (see .env.example)}"

case "$BACKUP_TIME" in
  [0-2][0-9]:[0-5][0-9]) ;;
  *) echo "[backup] BACKUP_TIME must be HH:MM (UTC), got '$BACKUP_TIME'" >&2; exit 1 ;;
esac

echo "[backup] scheduler started — daily at ${BACKUP_TIME} UTC, retention ${BACKUP_RETENTION_DAYS:-14} days"

if [ "${BACKUP_ON_START:-false}" = "true" ]; then
  /usr/local/bin/backup.sh || echo "[backup] start-up backup FAILED" >&2
fi

while true; do
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) ${BACKUP_TIME}:00" +%s)
  if [ "$target" -le "$now" ]; then
    target=$((target + 86400))
  fi
  sleep $((target - now))
  /usr/local/bin/backup.sh || echo "[backup] scheduled backup FAILED at $(date -u +%FT%TZ)" >&2
done
