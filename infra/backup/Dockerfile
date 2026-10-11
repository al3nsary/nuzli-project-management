# Daily encrypted PostgreSQL backups (brief §3.1, §13; docs/backup-restore.md, ADR-069).
# pg_dump -Fc  →  gpg AES-256 + MDC (authenticated)  →  /backups (named volume) + .sha256
# Optional upload to a SEPARATE S3-compatible bucket (OCI) with the AWS CLI.
# openssl stays for restoring legacy *.sql.gz.enc backups.
FROM postgres:16-alpine

RUN apk add --no-cache gnupg openssl aws-cli tzdata coreutils

COPY common.sh scheduler.sh backup.sh restore.sh /usr/local/bin/
# Scripts owned by root and read/execute-only for the runtime user (security review L9).
RUN chmod 0755 /usr/local/bin/common.sh /usr/local/bin/scheduler.sh /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
 && mkdir -p /backups \
 && chown postgres:postgres /backups

ENV TZ=UTC \
    BACKUP_DIR=/backups \
    BACKUP_TIME=02:00 \
    BACKUP_RETENTION_DAYS=14 \
    HOME=/tmp

USER postgres
VOLUME ["/backups"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f scheduler.sh >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/scheduler.sh"]
