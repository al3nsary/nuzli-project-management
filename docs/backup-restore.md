# Backups, restore and key rotation

Runbook for the `backup` container (`infra/backup/`) and for rotating the national-ID keys.
Decisions: ADR-068 (per-service env files), ADR-069 (backup format and restore), ADR-070
(key rotation). Background: security review 2026-10 (M6, M7, L1).

## 1. What is backed up, and how

| Item | Value |
|---|---|
| Content | The whole PostgreSQL database (`pg_dump --format=custom --compress=9 --no-owner --no-privileges`). Object storage (photos, logos, attachments) is **not** in the dump; protect the bucket with versioning / replication on the provider side. |
| Schedule | Daily at `BACKUP_TIME` (UTC, default `02:00` = 05:00 Riyadh), plus one at start-up when `BACKUP_ON_START=true`. |
| Encryption | `gpg --symmetric --cipher-algo AES256` (S2K SHA-512, 65M iterations) with the MDC integrity check. A wrong passphrase, a modified byte or a truncated file makes decryption fail; there is no partial output to restore by mistake. The dump is streamed from `pg_dump` into `gpg`: plaintext never touches the disk. |
| Read-back check | Every new backup is decrypted and listed with `pg_restore --list` before it is kept. A backup that fails this check is never written. |
| Files | `/backups/nuzli-<db>-<UTC timestamp>.dump.gpg` and `<same>.sha256` (named volume `backups`). |
| Retention | Local: `BACKUP_RETENTION_DAYS` (default 14). Remote: a lifecycle rule or object lock on the backup bucket. |
| Off-site copy | Off by default. `BACKUP_S3_ENABLED=true` plus every `BACKUP_S3_*` value in `env/backup.env`: a **separate bucket** and **write-only credentials** (no delete), ideally with object lock. The app bucket and the app's keys are never used. |
| Secrets | `env/backup.env` only: `PG*` and `BACKUP_*`. It contains no JWT secret, national-ID key or app S3 key. `env/api.env` contains no backup passphrase. |

The passphrase (`BACKUP_ENCRYPTION_PASSPHRASE`) must be at least 40 characters of random data
(`openssl rand -base64 48`). The container refuses to start with the `CHANGE_ME` placeholder
or a shorter value. **Keep a copy outside the server** (password manager and a sealed copy
with the system owner). Without it, no backup can be restored.

Backups taken before ADR-069 (`*.sql.gz.enc`, openssl AES-256-CBC) can still be restored.
`restore.sh` checks them with the checksum, `gzip -t` and the pg_dump trailer, because that
format has no MAC. They age out after `BACKUP_RETENTION_DAYS`.

### Before the A12 migration (workspaces, 2026-10)

The A12 migration (`20261023000000_a12_workspaces`) rewrites every business table. **Take a backup and
verify it before deploying it:** `docker compose exec backup backup.sh`, then
`restore.sh <file> --verify`. The migration runs in one transaction, checks the row count of every
table before and after (printed as NOTICEs in the `migrate deploy` output) and rolls back entirely on
any mismatch — see `docs/a12-isolation-design.md` §8.

After a restore: dumps are taken with `--no-privileges`, so the API role `nuzli_app` loses its table
grants; the seed re-grants them at the next API start (the role itself is cluster-wide and survives).
Row Level Security policies are part of the schema and are restored with it.

## 2. Restore

`restore.sh` fails closed at every step, and it never writes to the live database before the
final swap:

1. The `.sha256` file is **required** and must match. A missing checksum stops the restore.
2. The backup is decrypted into a private temporary directory on the backups volume. gpg
   checks integrity (MDC).
3. The archive must be complete. `pg_restore --list` must succeed; for legacy files, `gzip -t`
   and the `-- PostgreSQL database dump complete` trailer are checked.
4. The data is restored into a **new** database (`<db>_restore_<timestamp>`) in a single
   transaction (`pg_restore --exit-on-error --single-transaction`).
5. Sanity checks run on the new copy: applied Prisma migrations, the `users` table, and at
   least one owner (`account_role = 'OWNER'`; in a dump taken before A12: an admin). Before the
   A12 final step this looked for the legacy `users.role = 'ADMIN'`, which is empty on a fresh
   install — every backup of a new system would have been refused (fixed, ADR-169).
6. Only then are the databases swapped. Both renames run in one transaction: `<db>` becomes
   `<db>_pre_restore_<timestamp>` and the new copy becomes `<db>`. The previous database is
   kept until you drop it.

If any step fails, the new database is dropped and the live one is untouched.

### Restore steps (production)

```sh
# 0. Pick the backup (local volume or the backup bucket).
docker compose exec backup ls -l /backups
# 1. Check it without touching anything (scratch database, dropped afterwards).
docker compose exec backup restore.sh /backups/nuzli-nuzli-20261012T020000Z.dump.gpg --verify
# 2. Stop the API so nothing writes during the swap.
docker compose stop api
# 3. Restore and swap (asks for the database name unless --yes is given).
docker compose exec backup restore.sh /backups/nuzli-nuzli-20261012T020000Z.dump.gpg
# 4. Start the API: it runs `prisma migrate deploy` and the idempotent seed.
docker compose start api
# 5. After checking the app, drop the previous database (the name is printed by restore.sh).
docker compose exec backup psql -d postgres -c 'DROP DATABASE "nuzli_pre_restore_20261012093000"'
```

From the backup bucket: `restore.sh s3://<backup-bucket>/backups/<file>.dump.gpg --verify`. This
uses `BACKUP_S3_*` and also downloads the `.sha256` file.

The national-ID keys in `env/api.env` must be the ones that were in use when the backup was
taken. Keep older keys in `NATIONAL_ID_ENC_KEYS_OLD` until no backup inside the retention period
still needs them (see §4).

## 3. Restore drill (monthly, and after every change to `infra/backup`)

1. `docker compose exec backup backup.sh` takes a fresh backup.
2. `docker compose exec backup restore.sh /backups/<newest>.dump.gpg --verify` must print
   `verify OK`.
3. Negative test 1 (truncated backup, the M7 failure mode). Inside the container:
   ```sh
   f=/backups/<newest>.dump.gpg
   head -c $(( $(stat -c %s "$f") * 6 / 10 )) "$f" > /backups/drill.dump.gpg
   (cd /backups && sha256sum drill.dump.gpg > drill.dump.gpg.sha256)   # so the checksum passes
   restore.sh /backups/drill.dump.gpg --verify                         # must FAIL at decryption
   psql -d postgres -c '\l'                                            # no nuzli_restore_check_* left
   rm /backups/drill.dump.gpg*
   ```
4. Negative test 2: delete the `.sha256` file of a copy. `--verify` must refuse to start.
5. Record the date, the file and the durations in the operations log.

## 4. National-ID key rotation (ADR-011, ADR-070)

National IDs are stored as AES-256-GCM ciphertext (`national_id_enc`, prefixed with the key
version) plus an HMAC-SHA256 blind index (`national_id_hash`, used for exact search and
uniqueness).

### Rotate the encryption key (routine, for example yearly, or after a suspected leak)

1. Take a backup and confirm it with `--verify`.
2. Generate the new key: `echo "v2:$(openssl rand -base64 32)"`. Use the next version number.
3. In `env/api.env`: set `NATIONAL_ID_ENC_KEY=v2:…` and add the previous key to
   `NATIONAL_ID_ENC_KEYS_OLD=v1:…`. Restart the API. New writes now use v2, and old rows still
   decrypt with v1.
4. Re-encrypt the existing rows in batches. The run is idempotent and can be repeated:
   ```sh
   docker compose exec api node dist/scripts/rotate-national-id-key.js --dry-run
   docker compose exec api node dist/scripts/rotate-national-id-key.js --batch-size=500
   ```
5. Keep `v1` in `NATIONAL_ID_ENC_KEYS_OLD` for as long as backups taken before step 4 are
   within retention. After that, remove it and restart the API.

### Rotate the HMAC (blind-index) key (only after a suspected leak)

The hash is used for lookups and the unique index, so the API must be stopped:

1. Take a backup and confirm it with `--verify`. `docker compose stop api`.
2. Set the new `NATIONAL_ID_HMAC_KEY` (`openssl rand -base64 32`, different from the
   encryption key) in `env/api.env`, rotating the encryption key at the same time if wanted.
3. `docker compose run --rm api node dist/scripts/rotate-national-id-key.js` recomputes every
   hash (and re-encrypts rows that are not on the current version).
4. `docker compose start api`.

A restore of an older backup brings back the old hashes. If you restore one, run the script
again with the current keys before starting the API.

## 5. Checklist

- [ ] `env/backup.env` passphrase stored outside the server, at least 40 random characters.
- [ ] Off-site upload: separate bucket, write-only keys, object lock / lifecycle.
- [ ] Monthly drill (§3) recorded.
- [ ] Old encryption keys kept until the backups that need them have expired.
