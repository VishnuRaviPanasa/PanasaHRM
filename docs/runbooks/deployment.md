# ART HRM — deployment runbook

**Audience:** the infrastructure team.
**Status of this build:** works, and is **not production-ready**. Read §1 before scheduling
anything.

Everything below has been executed except the steps that need a server: the three images build,
the API container starts and authenticates against a real PostgreSQL, the nginx configuration
passes `nginx -t`, and the compose file resolves and refuses to start without its secrets.

---

## 1. Read this first — two blockers

### 1.1 A fresh database cannot be logged into

There is **no account-creation path in the application**. The only `INSERT INTO app_user` in the
repository is in `infrastructure/db/seeds/demo.sql`, and the API has no endpoint that creates a
login. `people.employee.create` creates an *employee record*, which is not an account.

So on a clean production database: migrations apply, the containers start, the site loads — and
nobody can sign in. There is no workaround that does not involve either the demo seed or manual
SQL.

**This must be built before the system holds real people.** It is not a configuration gap.

### 1.2 What is missing for production, beyond that

| Gap | Consequence |
|---|---|
| No CI | Images are built by hand. ADR-0013 requires build-in-CI, deploy-by-digest |
| No backups, no restore drill | ADR-0013 amendment (b): the principal accepted risk with no control behind it |
| API connects as the database owner unless §4 is done | Bypasses every grant, including the payslip Tier-1 revokes (OR-29) |
| No virus scanning on uploads | The quarantine gate is structurally sound and epistemically empty (OR-23) |
| Sessions are PostgreSQL rows, not Redis | Revocation works; the ADR-0010 store does not exist yet (OR-21) |
| Authorization retrofit partial | `hr.ts`, `leave.ts` and most of `work.ts` still decide in the controller |
| No ADR accepted | All 19 sit at *Proposed*; nothing has had legal or privacy review |

**A demo deployment is reasonable. A production deployment is not, until 1.1 is built and the
first four rows above are closed.**

---

## 2. What gets deployed

Seven containers on one VM (ADR-0013). Only nginx publishes a port.

```
        :80 :443
           │
        ┌──▼───┐   /api/*   ┌─────┐
        │nginx ├──────────► │ api │──┐
        └──┬───┘            └─────┘  │
           │  /*         ┌─────┐     ├──► postgres   (no published port)
           └────────────►│ web │     ├──► minio      (no published port)
                         └─────┘     └──► redis      (running, unused)

        migrate  — one-shot, runs to completion before api starts
```

| Image | Built from | Size |
|---|---|---|
| `art-hrm-api` | `apps/api/Dockerfile` | 292 MB |
| `art-hrm-web` | `apps/web/Dockerfile` | 319 MB |
| `art-hrm-migrate` | `infrastructure/docker/Dockerfile.migrate` | 244 MB |

Migrations run as a **separate one-shot container**, never on app boot (ADR-0013). `api` has
`depends_on: migrate: service_completed_successfully`, so a failed migration stops the deploy
rather than taking the application down after it starts.

---

## 3. Prerequisites

- A VM with Docker Engine 24+ and the Compose plugin. 4 GB RAM is comfortable for this size.
- DNS pointing at it.
- A TLS certificate: `fullchain.pem` and `privkey.pem` in one directory on the host.
- The host clock in UTC; the containers set `TZ=Asia/Kolkata` where it matters. **Do not change
  that** — `fn_business_date()` resolves the business day in IST, and attendance and payroll both
  derive dates from it. A different timezone silently attributes punches to the wrong day.

---

## 4. Create the least-privilege database role

**Do this before the first deploy.** The API must not connect as the owner.

Migration 0008 already creates `hrm_app` with the right grants, and 0024 revokes it from every
payslip table (Tier-1 isolation: a SQL injection in the leave module must not be able to read
salary). None of that has any effect while the API connects as the owner.

After the first `migrate` run completes, as the owner:

```sql
ALTER ROLE hrm_app WITH LOGIN PASSWORD '<HRM_PG_APP_PASSWORD>';
```

Then set `HRM_PG_APP_USER=hrm_app`. Verify the isolation actually holds:

```sql
-- Must return false. If it returns true, the API can read the salary register.
SELECT has_table_privilege('hrm_app', 'payslip', 'SELECT');
```

> Known issue: `apps/api/src/db.ts` records that switching to `hrm_app` is blocked on an
> unresolved item (the leave-ledger trigger needs a grant the role lacks). **Test this on a
> staging copy first.** If the API fails on a leave write, fall back to the owner and treat OR-29
> as still open — do not silently leave it in production.

---

## 5. Environment variables

There is deliberately **no `.env.example`** in the repository: the project's own rules forbid
committing any `.env*` file. Create the environment file on the host, `chmod 600`, owned by the
deploy user.

| Variable | Required | Notes |
|---|---|---|
| `HRM_IMAGE_TAG` | yes | The release being deployed, e.g. `rc1` |
| `HRM_TLS_DIR` | yes | Host directory holding `fullchain.pem` and `privkey.pem` |
| `HRM_PG_DATABASE` | no | Defaults to `hrm` |
| `HRM_PG_OWNER_USER` | yes | Owns the schema. Used by `postgres` and by `migrate` only |
| `HRM_PG_OWNER_PASSWORD` | yes | `openssl rand -base64 32` |
| `HRM_PG_APP_USER` | yes | `hrm_app` once §4 is done |
| `HRM_PG_APP_PASSWORD` | yes | `openssl rand -base64 32` |
| `HRM_MINIO_ACCESS_KEY` | yes | `openssl rand -hex 16` |
| `HRM_MINIO_SECRET_KEY` | yes | `openssl rand -base64 32`. Equivalent to a bulk document export — treat as a top-tier secret |
| `HRM_DOC_BUCKET` | no | Defaults to `hrm-documents` |

`HRM_SECURE_COOKIES=true` is set in the compose file itself, not the environment file. It makes
the session cookie `__Host-hrm_session` with `Secure`. **Do not turn it off behind TLS** — and
note it cannot be on without TLS, because a browser refuses a `Secure` cookie over HTTP.

Compose uses `${VAR:?...}`, so a missing secret aborts the deploy instead of falling back to a
development default.

---

## 6. Build

On a build host, never on the production host (ADR-0013). Build context is the **repository
root** for all three — the API and web both depend on the `packages/authz` workspace.

```bash
git checkout <release-tag>

docker build -f apps/api/Dockerfile                  -t art-hrm-api:$TAG     .
docker build -f apps/web/Dockerfile                  -t art-hrm-web:$TAG     .
docker build -f infrastructure/docker/Dockerfile.migrate -t art-hrm-migrate:$TAG .
```

Push to your registry and record the digests. ADR-0013 requires deploying **by digest**; the
compose file uses tags for readability, so change `image: art-hrm-api:${HRM_IMAGE_TAG}` to
`image: <registry>/art-hrm-api@sha256:...` before this is a real production deployment.

Nothing secret may be passed to `docker build`. A Next build inlines what it can see into the
client bundle; every value this application needs is read at runtime.

---

## 7. Deploy

```bash
cd infrastructure/compose
docker compose --env-file /etc/art-hrm/env -f docker-compose.prod.yml up -d
```

Order is enforced by the file: `postgres` becomes healthy → `migrate` runs to completion →
`api` starts → `nginx` starts.

Watch the migration:

```bash
docker compose -f docker-compose.prod.yml logs migrate
```

It applies pending migrations and **refuses any file whose checksum differs from what was
applied**. A checksum failure means someone edited an applied migration; do not force past it.

---

## 8. Verify

```bash
# 1. The edge is up
curl -sS https://<host>/healthz

# 2. TLS and headers
curl -sSI https://<host>/ | grep -Ei 'strict-transport|x-frame|x-content-type|permissions-policy'

# 3. Unauthenticated API is refused, not open
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/auth/me      # expect 401

# 4. The session cookie is the hardened form
curl -sSi -X POST https://<host>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"...","password":"..."}' \
  | grep -i set-cookie
# expect: __Host-hrm_session=...; Secure; HttpOnly; SameSite=Lax; Path=/

# 5. Object storage is NOT publicly readable
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>:9000/hrm-documents   # expect no route

# 6. Migration state
docker compose -f docker-compose.prod.yml run --rm migrate status
```

Checks 3, 4 and 5 are the ones worth failing the deploy over.

---

## 9. Demo deployments only

If this is going up for a demonstration rather than for real use, the demo seed is the only way
to get a login (§1.1). Run it with a private password:

```bash
HRM_DEMO_PASSWORD='<a strong value you share out of band>' node scripts/seed.mjs
```

The seed **wipes and recreates** all demo data, so never run it against anything you want to
keep. It creates five fictional employees; the data is synthetic. Take the deployment down when
the demo is over rather than leaving it running.

---

## 10. Rollback

The application is stateless; the database is not.

```bash
HRM_IMAGE_TAG=<previous> docker compose -f docker-compose.prod.yml up -d api web
```

**Migrations are forward-only and there are no down-migrations.** Rolling images back does not
roll the schema back. If a release included a migration, the previous image must still be able to
run against the new schema — which is why changes are expand/contract and a rename is three
deploys. If it cannot, the only recovery is a database restore, and **no backup or restore
procedure exists yet** (§1.2).

---

## 11. Operational notes

- **Logs:** `docker compose logs -f api`. The API logs to stdout. It never logs PII or secrets;
  audit records go to the `audit_event` table, which is append-only and partitioned.
- **Audit retention:** decade-scale by design. Partitions are created ahead of time; a write past
  the last partition fails loudly rather than silently landing in a default partition.
- **Backups (not built):** at minimum `pg_dump` plus the MinIO `hrm-documents` bucket, encrypted
  and off-host, with a *restore drill* — an untested backup is not a backup. Document uploads are
  the only application data outside PostgreSQL.
- **Certificate renewal:** nginx must reload after renewal —
  `docker compose exec nginx nginx -s reload`. HSTS is deliberately set to a short `max-age`;
  raise it only once renewal is proven, because a long value cannot be withdrawn from the server
  side.
