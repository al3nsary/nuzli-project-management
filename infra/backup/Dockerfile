# Daily encrypted PostgreSQL backups (brief §3.1, §13).
# pg_dump | gzip | openssl enc -aes-256-cbc -pbkdf2  →  /backups (named volume)
# Optional upload to an S3-compatible bucket (OCI) with the AWS CLI.
FROM postgres:16-alpine

RUN apk add --no-cache openssl aws-cli tzdata coreutils

COPY scheduler.sh backup.sh restore.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/scheduler.sh /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
 && mkdir -p /backups \
 && chown postgres:postgres /backups

ENV TZ=UTC \
    BACKUP_DIR=/backups \
    BACKUP_TIME=02:00 \
    BACKUP_RETENTION_DAYS=14

USER postgres
VOLUME ["/backups"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f scheduler.sh >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/scheduler.sh"]
