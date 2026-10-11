#!/bin/sh
# One encrypted logical backup of the database (docs/backup-restore.md, ADR-069).
#   pg_dump -Fc (custom format, compressed)  →  gpg AES-256 + MDC  →  <name>.dump.gpg + .sha256
# Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (env/backup.env).
# Optional upload: BACKUP_S3_ENABLED=true with BACKUP_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/
# SECRET_KEY — a separate bucket with write-only keys; the app bucket and keys are never used.
set -eu
set -o pipefail

. /usr/local/bin/common.sh
check_passphrase

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"

umask 077
work=$(mktemp -d "${BACKUP_DIR}/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
export GNUPGHOME="$work/gnupg"
mkdir -p "$GNUPGHOME"
pass=$(passphrase_file "$work")

ts=$(date -u +%Y%m%dT%H%M%SZ)
name="nuzli-${PGDATABASE:-nuzli}-${ts}.dump.gpg"
out="${BACKUP_DIR}/${name}"

echo "[backup] dumping ${PGDATABASE:-?}@${PGHOST:-?} → ${name}"
# Streamed: the plaintext dump never touches the disk. pipefail fails the run if pg_dump fails.
pg_dump --format=custom --compress=9 --no-owner --no-privileges   | gpg_encrypt "$pass" - "$work/$name"
# Read-back check: the MDC verifies and pg_restore can list the whole archive, or nothing ships.
gpg_decrypt "$pass" "$work/$name" - | pg_restore --list > /dev/null
mv "$work/$name" "$out"
(cd "$BACKUP_DIR" && sha256sum "$name" > "${name}.sha256")
echo "[backup] wrote ${out} ($(du -h "$out" | cut -f1))"

if [ "${BACKUP_S3_ENABLED:-false}" = "true" ]; then
  s3_setup
  prefix="${BACKUP_S3_PREFIX:-backups/}"
  # shellcheck disable=SC2086
  aws s3 cp --only-show-errors $S3_ENDPOINT_ARG "$out" "s3://${BACKUP_S3_BUCKET}/${prefix}${name}"
  # shellcheck disable=SC2086
  aws s3 cp --only-show-errors $S3_ENDPOINT_ARG "${out}.sha256" "s3://${BACKUP_S3_BUCKET}/${prefix}${name}.sha256"
  echo "[backup] uploaded to s3://${BACKUP_S3_BUCKET}/${prefix}${name}"
fi

# Local retention (remote retention: lifecycle rule / object lock on the backup bucket).
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'nuzli-*.dump.gpg*' -o -name 'nuzli-*.sql.gz.enc*' \) \
  -mtime +"$RETENTION" -print -delete | sed 's/^/[backup] pruned /'
echo "[backup] done"
