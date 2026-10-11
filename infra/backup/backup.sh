#!/bin/sh
# One encrypted logical backup of the database.
#   pg_dump (plain SQL, --clean --if-exists) | gzip | openssl AES-256-CBC (PBKDF2)
# Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (set by docker-compose.yml).
# Optional upload: BACKUP_S3_ENABLED=true + S3_ENDPOINT/S3_REGION and BACKUP_S3_BUCKET
# (defaults to S3_BUCKET) with BACKUP_S3_ACCESS_KEY/SECRET_KEY (default S3_ACCESS_KEY/SECRET_KEY).
set -eu
set -o pipefail

: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
PBKDF2_ITER="${BACKUP_PBKDF2_ITER:-200000}"

umask 077
ts=$(date -u +%Y%m%dT%H%M%SZ)
name="nuzli-${PGDATABASE:-nuzli}-${ts}.sql.gz.enc"
out="${BACKUP_DIR}/${name}"
tmp="${out}.partial"

echo "[backup] dumping ${PGDATABASE:-?}@${PGHOST:-?} → ${name}"
pg_dump --no-owner --no-privileges --clean --if-exists --quote-all-identifiers \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter "$PBKDF2_ITER" -salt \
      -pass env:BACKUP_ENCRYPTION_PASSPHRASE -out "$tmp"
mv "$tmp" "$out"
(cd "$BACKUP_DIR" && sha256sum "$name" > "${name}.sha256")
echo "[backup] wrote ${out} ($(du -h "$out" | cut -f1))"

if [ "${BACKUP_S3_ENABLED:-false}" = "true" ]; then
  bucket="${BACKUP_S3_BUCKET:-${S3_BUCKET:?S3_BUCKET or BACKUP_S3_BUCKET required for upload}}"
  prefix="${BACKUP_S3_PREFIX:-backups/}"
  export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-${S3_ACCESS_KEY:-}}"
  export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-${S3_SECRET_KEY:-}}"
  export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
  # OCI's S3 API rejects the newer default checksum headers of AWS CLI v2.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  endpoint_arg=""
  if [ -n "${S3_ENDPOINT:-}" ]; then endpoint_arg="--endpoint-url ${S3_ENDPOINT}"; fi
  # shellcheck disable=SC2086
  aws s3 cp --only-show-errors $endpoint_arg "$out" "s3://${bucket}/${prefix}${name}"
  # shellcheck disable=SC2086
  aws s3 cp --only-show-errors $endpoint_arg "${out}.sha256" "s3://${bucket}/${prefix}${name}.sha256"
  echo "[backup] uploaded to s3://${bucket}/${prefix}${name}"
fi

# Local retention (remote retention: configure a lifecycle rule on the bucket).
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'nuzli-*.sql.gz.enc*' -mtime +"$RETENTION" -print -delete \
  | sed 's/^/[backup] pruned /'
echo "[backup] done"
