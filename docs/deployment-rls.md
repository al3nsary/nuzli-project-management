# Deploying with Row Level Security (A12 — ADR-143, ADR-152)

The API and the database migrations use **two PostgreSQL roles**:

| Role | URL (env/api.env) | Used by | Rights |
|---|---|---|---|
| the migrator / schema owner (`POSTGRES_USER` of env/db.env, e.g. `nuzli`) | `DATABASE_URL` | `prisma migrate deploy` and the seed, at every container start | owns the schema; a superuser in the stock postgres image |
| `nuzli_app` | `APP_DATABASE_URL` | the API server | DML on every table, **no superuser, no BYPASSRLS** — Row Level Security applies to every request |

`nuzli_app` is created by the A12 migration (`NOLOGIN`). Nothing has to be run by hand:

1. Pick a password for it (URL-safe characters):
   `openssl rand -base64 32 | tr -d '+/=' | cut -c1-32`
2. In `env/api.env` set
   ```
   DATABASE_URL=postgresql://nuzli:<db password>@db:5432/nuzli?schema=public
   APP_DATABASE_URL=postgresql://nuzli_app:<app password>@db:5432/nuzli?schema=public
   ```
3. Start the stack. `apps/api/docker-entrypoint.sh` runs the migrations and the seed as the migrator;
   the seed gives `nuzli_app` LOGIN with the password taken from `APP_DATABASE_URL` (idempotent; a
   changed password applies at the next start; the password is passed as a bound parameter and never
   logged) and re-grants DML on every table (needed after a restore with `--no-privileges`). The
   entrypoint then starts the API with `DATABASE_URL=$APP_DATABASE_URL`.
4. `docker-compose.prod.yml` sets `DB_REQUIRE_RLS=true`: the entrypoint exits when `APP_DATABASE_URL` is
   missing, and the API refuses to start when its role bypasses RLS (superuser or BYPASSRLS).
   Development (`docker-compose.dev.yml`) keeps `DB_REQUIRE_RLS=false`: without `APP_DATABASE_URL` the
   API logs a warning and runs as the migrator.

Check after the first start:
```
docker compose logs api | grep -E "nuzli_app|entrypoint"
#   [seed] nuzli_app can log in (password from APP_DATABASE_URL); the API connects with it.
#   [entrypoint] the API connects as the application role (APP_DATABASE_URL)
docker compose exec db psql -U nuzli -d nuzli -c "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nuzli_app'"
#   nuzli_app | t | f | f
```

If the migrator may not alter roles (a managed PostgreSQL without superuser), create and configure the
role once with an administrative account:
```sql
ALTER ROLE nuzli_app LOGIN PASSWORD '<app password>';
```
The seed then only logs that it could not configure the role; everything else works.

**What RLS is (and is not):** a second line of defence under the application's own workspace filter:
a forgotten filter in the API cannot return or change another workspace's rows. Since the A12 security
review (L2, ADR-165) `nuzli_app` cannot bypass it either: the maintenance bypass (`app.bypass_rls = on`)
is honoured only for roles that are not `nuzli_app` (or a member of it), so even an injected statement
that sets the setting itself stays inside the request's workspace. Operator CLIs that must span
workspaces (national-ID key rotation, owner recovery) connect as the migrator (`DATABASE_URL`, which is
what `docker compose exec api …` gets). Backups (`docs/backup-restore.md`) are taken as the migrator.

## First owner

`BOOTSTRAP_OWNER_USERNAME=mmansary` in `env/api.env` is enough on an empty system. Leave
`BOOTSTRAP_OWNER_PASSWORD` empty to get a random temporary password printed **once** in the API log of
the first start (`docker compose logs api | grep "Temporary password"`); only its hash is stored and the
owner must change it at first login. Remove any password from env/api.env after the first start.

**First boot only (security review H1, ADR-163).** `BOOTSTRAP_OWNER_USERNAME` / `BOOTSTRAP_OWNER_EMAIL` act only
while the system has no owner. Restarting never promotes anyone again: a removed owner stays removed, and an
account that later takes a listed username or e-mail is not promoted (the seed logs a warning that the list is
ignored). You may leave the variables in place.

## Recovering an owner

When no owner can sign in (every owner removed or suspended, a lost password), an operator with server access
restores one explicitly — never by restarting:

```sh
docker compose exec api npm run owner:recover -- --username mmansary --dry-run          # shows what would change
docker compose exec api npm run owner:recover -- --username mmansary                    # makes the account an OWNER
docker compose exec api npm run owner:recover -- --username mmansary --reset-password   # + a one-time password, printed once
```

The account must have been approved (ACTIVE or SUSPENDED; a suspended one is reactivated and any login lock is
lifted). With `--reset-password` the temporary password must be changed at the next sign-in and every session
of the account ends. The action is audited as `owner.recovered` at account level (owners see it under
«سجل الحسابات والأقسام»). The script connects with `DATABASE_URL` (the migrator) inside the container.
