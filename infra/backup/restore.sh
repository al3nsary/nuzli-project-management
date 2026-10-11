#!/bin/sh
# Restore an encrypted backup made by backup.sh.
#
#   restore.sh <file|s3://bucket/key> [--yes]            restore INTO $PGDATABASE (destructive)
#   restore.sh <file|s3://bucket/key> --verify           restore into a throw-away database,
#                                                        check it, drop it (safe; use in CI/drills)
#
# Run inside the backup container (it has psql, openssl and the AWS CLI):
#   docker compose exec backup restore.sh /backups/nuzli-nuzli-20261012T020000Z.sql.gz.enc --verify
#   docker compose stop api
#   docker compose exec backup restore.sh /backups/<file> --yes
#   docker compose start api
set -eu
set -o pipefail

usage() { sed -n '2,13p' "$0"; exit 2; }
[ $# -ge 1 ] || usage

src="$1"; shift
mode="interactive"
for arg in "$@"; do
  case "$arg" in
    --yes) mode="yes" ;;
    --verify) mode="verify" ;;
    *) usage ;;
  esac
done

: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
PBKDF2_ITER="${BACKUP_PBKDF2_ITER:-200000}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

file="$src"
case "$src" in
  s3://*)
    export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-${S3_ACCESS_KEY:-}}"
    export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-${S3_SECRET_KEY:-}}"
    export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
    export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
    export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
    endpoint_arg=""
    if [ -n "${S3_ENDPOINT:-}" ]; then endpoint_arg="--endpoint-url ${S3_ENDPOINT}"; fi
    file="$work/$(basename "$src")"
    # shellcheck disable=SC2086
    aws s3 cp --only-show-errors $endpoint_arg "$src" "$file"
    # shellcheck disable=SC2086
    aws s3 cp --only-show-errors $endpoint_arg "${src}.sha256" "${file}.sha256" 2>/dev/null || true
    ;;
esac

[ -f "$file" ] || { echo "[restore] not found: $file" >&2; exit 1; }

if [ -f "${file}.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256")
else
  echo "[restore] warning: no .sha256 next to the backup; integrity not verified" >&2
fi

decrypt() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter "$PBKDF2_ITER" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$file" | gunzip
}

if [ "$mode" = "verify" ]; then
  target="nuzli_restore_check_$(date -u +%s)"
  echo "[restore] verify: restoring into temporary database ${target}"
  psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"${target}\""
  if decrypt | psql -q -v ON_ERROR_STOP=1 --single-transaction -d "$target" >/dev/null; then
    migrations=$(psql -tA -d "$target" -c 'SELECT count(*) FROM "_prisma_migrations"')
    users=$(psql -tA -d "$target" -c 'SELECT count(*) FROM "users"')
    psql -q -d postgres -c "DROP DATABASE \"${target}\""
    echo "[restore] verify OK — migrations: ${migrations}, users: ${users}"
    exit 0
  fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS \"${target}\""
  echo "[restore] verify FAILED" >&2
  exit 1
fi

if [ "$mode" != "yes" ]; then
  printf '[restore] This REPLACES database "%s" on %s. Type the database name to continue: ' "${PGDATABASE}" "${PGHOST:-localhost}"
  read -r answer
  [ "$answer" = "$PGDATABASE" ] || { echo "[restore] aborted"; exit 1; }
fi

echo "[restore] restoring into ${PGDATABASE} — stop the api service first"
decrypt | psql -q -v ON_ERROR_STOP=1 --single-transaction -d "$PGDATABASE"
echo "[restore] done. Start the api service again; it re-runs migrations and the idempotent seed."
