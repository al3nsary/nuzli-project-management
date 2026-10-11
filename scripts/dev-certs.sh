#!/bin/sh
# Creates a locally trusted development certificate with mkcert (see infra/certs/README.md).
#   sh scripts/dev-certs.sh [extra-host-or-ip ...]
# Writes infra/certs/fullchain.pem and infra/certs/privkey.pem (git-ignored).
set -eu

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'EOF'
mkcert is not installed.
  Windows: choco install mkcert   (or: scoop install mkcert)
  macOS:   brew install mkcert nss
  Linux:   https://github.com/FiloSottile/mkcert/releases  (+ libnss3-tools)
EOF
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/infra/certs"
mkdir -p "$out"

mkcert -install
mkcert -cert-file "$out/fullchain.pem" -key-file "$out/privkey.pem" \
  localhost 127.0.0.1 ::1 "$@"

# nginx runs as uid 101 inside the container and must read the key (dev only).
chmod 0644 "$out/fullchain.pem" "$out/privkey.pem"

echo
echo "Certificates written to infra/certs/. Root CA (install on test phones):"
echo "  $(mkcert -CAROOT)/rootCA.pem"
