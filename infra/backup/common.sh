#!/bin/sh
# Shared helpers for backup.sh / restore.sh / scheduler.sh (sourced, POSIX sh).

# Security review H1/L1: refuse the example placeholder and short passphrases.
check_passphrase() {
  : "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required (env/backup.env)}"
  if printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" | grep -qi 'change[_-]\{0,1\}me'; then
    echo "[backup] BACKUP_ENCRYPTION_PASSPHRASE is still the CHANGE_ME placeholder; generate one: openssl rand -base64 48" >&2
    exit 1
  fi
  if [ "${#BACKUP_ENCRYPTION_PASSPHRASE}" -lt 40 ]; then
    echo "[backup] BACKUP_ENCRYPTION_PASSPHRASE must be at least 40 characters of random data (openssl rand -base64 48)" >&2
    exit 1
  fi
}

# Security review M6: uploads use their OWN bucket and credentials, never the app's.
s3_setup() {
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required when BACKUP_S3_ENABLED=true (a separate bucket)}"
  : "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required when BACKUP_S3_ENABLED=true}"
  : "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required when BACKUP_S3_ENABLED=true}"
  export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
  export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
  export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
  # OCI's S3 API rejects the newer default checksum headers of AWS CLI v2.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  # OCI's S3 compatibility API is addressed path-style (https://<ns>.compat…/<bucket>/<key>);
  # the AWS CLI has no environment variable for it, so a private config file (tmpfs) says so.
  export AWS_CONFIG_FILE="${TMPDIR:-/tmp}/nuzli-aws-config"
  printf '[default]\ns3 =\n    addressing_style = path\n' > "$AWS_CONFIG_FILE"
  S3_ENDPOINT_ARG=""
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then S3_ENDPOINT_ARG="--endpoint-url ${BACKUP_S3_ENDPOINT}"; fi
}

# Writes the passphrase to a private file for gpg (never on a command line, never in ps).
passphrase_file() {
  dir="$1"
  umask 077
  printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" > "$dir/.pass"
  echo "$dir/.pass"
}

# gpg symmetric encryption: AES-256 with the MDC integrity check (a tampered or truncated file
# fails to decrypt instead of producing partial output). GNUPGHOME lives in a private temp dir.
gpg_encrypt() { # <passfile> <in|-> <out>   ("-" = standard input)
  if [ "$2" = "-" ]; then
    gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
      --passphrase-file "$1" --symmetric --cipher-algo AES256 \
      --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none \
      --output "$3"
  else
    gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
      --passphrase-file "$1" --symmetric --cipher-algo AES256 \
      --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none \
      --output "$3" "$2"
  fi
}

# Decrypts and verifies the MDC; gpg exits non-zero on a wrong passphrase, a tampered or a
# truncated file. With <out> = "-" the plaintext streams to stdout BEFORE the check finishes,
# so callers that stream must run under `set -o pipefail`.
gpg_decrypt() { # <passfile> <in> <out|->
  gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
    --passphrase-file "$1" --decrypt --output "$3" "$2"
}
