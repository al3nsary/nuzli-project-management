#!/bin/sh
# Restore an encrypted backup made by backup.sh (docs/backup-restore.md, ADR-069).
#
#   restore.sh <file|s3://bucket/key> --verify   restore into a scratch database, check it,
#                                                drop it (safe; use for drills and CI)
#   restore.sh <file|s3://bucket/key> [--yes]    restore into a NEW database, check it, then
#                                                swap it in for $PGDATABASE (the previous one
#                                                is kept as <db>_pre_restore_<ts>)
#
# Fail-closed order (security review M7, L1): checksum file required and matching → decrypt
# to a private temp file (gpg MDC: tampered/truncated input fails) → archive fully readable
# (pg_restore --list / gzip -t + dump trailer) → restore in ONE transaction into a fresh
# database → sanity checks → rename swap. Nothing touches $PGDATABASE before the swap.
#
# Run inside the backup container (psql, pg_restore, gpg and the AWS CLI are there):
#   docker compose exec backup restore.sh /backups/nuzli-nuzli-20261012T020000Z.dump.gpg --verify
#   docker compose stop api
#   docker compose exec backup restore.sh /backups/<file> --yes
#   docker compose start api
# Legacy backups (*.sql.gz.enc, openssl AES-256-CBC, before ADR-069) are still accepted.
set -eu
set -o pipefail

. /usr/local/bin/common.sh

usage() { sed -n '2,21p' "$0"; exit 2; }
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
: "${PGDATABASE:?PGDATABASE is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
PBKDF2_ITER="${BACKUP_PBKDF2_ITER:-200000}"
umask 077
# On the backups volume, not in /tmp: a decrypted dump can be larger than a tmpfs.
work=$(mktemp -d "${BACKUP_DIR}/.restore.XXXXXX")
target=""
cleanup() {
  status=$?
  if [ -n "$target" ] && [ "$status" -ne 0 ]; then
    psql -q -d postgres -c "DROP DATABASE IF EXISTS \"${target}\"" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
export GNUPGHOME="$work/gnupg"
mkdir -p "$GNUPGHOME"
pass=$(passphrase_file "$work")

fail() { echo "[restore] FAILED: $*" >&2; exit 1; }

# ── 1. fetch ────────────────────────────────────────────────────────────────
file="$src"
case "$src" in
  s3://*)
    s3_setup
    file="$work/$(basename "$src")"
    # shellcheck disable=SC2086
    aws s3 cp --only-show-errors $S3_ENDPOINT_ARG "$src" "$file"
    # shellcheck disable=SC2086
    aws s3 cp --only-show-errors $S3_ENDPOINT_ARG "${src}.sha256" "${file}.sha256" \
      || fail "no ${src}.sha256 next to the backup"
    ;;
esac
[ -f "$file" ] || fail "not found: $file"

# ── 2. checksum (mandatory) ─────────────────────────────────────────────────
[ -f "${file}.sha256" ] || fail "no $(basename "$file").sha256 next to the backup; refusing to restore an unverified file"
(cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256") || fail "checksum mismatch for $(basename "$file")"
echo "[restore] checksum OK"

# ── 3. decrypt to a temp file and validate the archive ──────────────────────
case "$file" in
  *.dump.gpg)
    format=custom
    gpg_decrypt "$pass" "$file" "$work/db.dump" || fail "decryption / integrity check (gpg MDC) failed"
    pg_restore --list "$work/db.dump" > "$work/toc.txt" || fail "archive is truncated or corrupt"
    [ -s "$work/toc.txt" ] || fail "archive has an empty table of contents"
    ;;
  *.sql.gz.enc)
    format=legacy
    echo "[restore] legacy openssl backup: no MAC, relying on checksum + gzip + dump trailer" >&2
    openssl enc -d -aes-256-cbc -pbkdf2 -iter "$PBKDF2_ITER" \
      -pass "file:$pass" -in "$file" -out "$work/db.sql.gz" || fail "decryption failed"
    gzip -t "$work/db.sql.gz" || fail "gzip stream is truncated or corrupt"
    gunzip -c "$work/db.sql.gz" > "$work/db.sql"
    rm -f "$work/db.sql.gz"
    tail -n 5 "$work/db.sql" | grep -q 'PostgreSQL database dump complete' \
      || fail "dump trailer missing: the backup is incomplete"
    ;;
  *) fail "unknown backup format: $(basename "$file") (expected .dump.gpg or .sql.gz.enc)" ;;
esac
echo "[restore] archive OK (${format})"

# ── 4. restore into a fresh database ────────────────────────────────────────
stamp=$(date -u +%Y%m%d%H%M%S)
target="${PGDATABASE}_restore_${stamp}"
if [ "$mode" = "verify" ]; then target="nuzli_restore_check_${stamp}"; fi
echo "[restore] restoring into new database ${target}"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "CREATE DATABASE \"${target}\""
if [ "$format" = "custom" ]; then
  pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
    -d "$target" "$work/db.dump" || fail "pg_restore reported an error"
else
  psql -q -v ON_ERROR_STOP=1 --single-transaction -d "$target" -f "$work/db.sql" >/dev/null \
    || fail "psql reported an error"
fi

# ── 5. sanity checks on the restored copy ───────────────────────────────────
migrations=$(psql -tA -d "$target" -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') \
  || fail "no _prisma_migrations table"
users=$(psql -tA -d "$target" -c 'SELECT count(*) FROM "users"') || fail "no users table"
# A12: the system's top accounts are OWNERS (users.account_role); the legacy users.role is NULL for
# every account created after A12 — including the bootstrap owner of a fresh install. Dumps taken
# before A12 have no account_role column and keep the old check.
has_owner_col=$(psql -tA -d "$target" -c "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'account_role'") \
  || fail "cannot inspect the users table"
if [ "$has_owner_col" -gt 0 ]; then
  admins=$(psql -tA -d "$target" -c "SELECT count(*) FROM \"users\" WHERE account_role = 'OWNER'")
else
  admins=$(psql -tA -d "$target" -c "SELECT count(*) FROM \"users\" WHERE role = 'ADMIN'")
fi
[ "$migrations" -gt 0 ] || fail "no applied migrations in the restored copy"
[ "$admins" -gt 0 ] || fail "no owner (or, before A12, admin) account in the restored copy"
echo "[restore] restored copy OK — migrations: ${migrations}, users: ${users}, owners/admins: ${admins}"

if [ "$mode" = "verify" ]; then
  psql -q -d postgres -c "DROP DATABASE \"${target}\""
  target=""
  echo "[restore] verify OK (scratch database dropped)"
  exit 0
fi

# ── 6. swap ─────────────────────────────────────────────────────────────────
if [ "$mode" != "yes" ]; then
  printf '[restore] Swap the restored copy in for "%s" on %s? Type the database name to continue: ' \
    "${PGDATABASE}" "${PGHOST:-localhost}"
  read -r answer
  [ "$answer" = "$PGDATABASE" ] || fail "aborted by operator"
fi
previous="${PGDATABASE}_pre_restore_${stamp}"
echo "[restore] swapping: ${PGDATABASE} → ${previous}, ${target} → ${PGDATABASE} (stop the api first)"
psql -v ON_ERROR_STOP=1 -q -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN ('${PGDATABASE}', '${target}') AND pid <> pg_backend_pid();
-- Both renames commit together or not at all.
BEGIN;
ALTER DATABASE "${PGDATABASE}" RENAME TO "${previous}";
ALTER DATABASE "${target}" RENAME TO "${PGDATABASE}";
COMMIT;
SQL
target=""
echo "[restore] done. Previous database kept as ${previous}; drop it once the app is verified:"
echo "          psql -d postgres -c 'DROP DATABASE \"${previous}\"'"
echo "[restore] Start the api service again; it re-runs migrations and the idempotent seed."
