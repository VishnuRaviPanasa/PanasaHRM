# ART HRM — deployment runbook

**Audience:** the infrastructure team.
**Status of this build:** works, and is **not production-ready**. Read §1 before scheduling
anything.

**Everything below has been executed.** The full seven-container stack was brought up locally
behind nginx with TLS, migrations applied, the demo dataset loaded through the seed profile, and
every screen's data verified through the edge for both an HR and an employee account. The one
thing not exercised is a real host: DNS, a real certificate, and the least-privilege database
role in §4.

It also found two bugs that only a run surfaces, both now fixed: the PostgreSQL 18 data volume
must mount at `/var/lib/postgresql`, not `.../data`, or the server refuses to start reporting a
version mismatch; and the seed shipped in no image at all, so the deployed stack had no way to
get any data into it.

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

For a **demonstration** there is now a supported path: §9 loads the demo dataset through a
compose profile. That gives five fictional employees, four departments, four designations, three
issued payslips each with a downloadable PDF, attendance history and nine working reports. It is
demo data, not a substitute for account management.

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

Seven containers on one VM (ADR-0013). Only nginx publishes a port. The `migrate` image
also carries the demo seed (§9); it is the only image with a dependency of its own, the
pinned MinIO client the seed needs to upload payslip PDFs.

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
| `art-hrm-migrate` | `infrastructure/docker/Dockerfile.migrate` | 266 MB |

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

### Generate it on the server — do not send it to anyone

```bash
sudo mkdir -p /etc/art-hrm
sudo sh scripts/make-env.sh /etc/art-hrm/env
```

**The secrets must never travel through chat, email or a ticket.** The PostgreSQL owner password
gives full control of every record, and the MinIO secret key is equivalent to a bulk export of
every employee document and payslip. Anything sent over a messaging channel lands in message
history, mail archives and backups nobody involved controls — and it cannot be un-sent, because
rotating it later does not remove the copies.

So nobody writes a secret down and nobody shares one. `scripts/make-env.sh` generates them with
`openssl rand` on the host that will use them, writes the file `0600`, and prints only the values
that are **not** secret — so its output is safe to paste into a ticket. It refuses to overwrite an
existing file, because regenerating would rotate the credentials in the file while the services
still expect the current ones.

Two values it cannot know are left blank for you: `HRM_IMAGE_TAG` and `HRM_TLS_DIR`.

Validate without starting anything:

```bash
docker compose --env-file /etc/art-hrm/env   -f infrastructure/compose/docker-compose.prod.yml config >/dev/null
```

Compose uses `${VAR:?...}`, so it names any variable still missing.

### The full list

There is deliberately **no `.env.example`** in the repository: the project's own rules forbid
committing any `.env*` file, and a template invites someone to fill it in and then send it.

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

## 9. Demo data (demonstrations only)

A fresh database has no accounts (§1.1). For a demonstration, load the demo dataset:

```bash
docker compose --env-file /etc/art-hrm/env   -f docker-compose.prod.yml --profile seed run --rm seed
```

**The seed sits behind a compose profile, so `up -d` can never run it.** Loading demo data takes
a differently-shaped command on purpose: the seed is destructive — it wipes and recreates every
table it touches — so it must not be reachable by the command somebody types to restart the stack
at 2am.

Two guards must be opened deliberately, and both are declared in the compose file rather than
hidden in the script:

| Variable | Why it is required |
|---|---|
| `HRM_SEED_ALLOW_NONDEV` | The seed refuses any target that is not `127.0.0.1:55432`. Set to `i-understand` in the seed service |
| `HRM_DEMO_PASSWORD` | Every demo account shares one password. Unset, it falls back to the value committed in the repository — a public credential on a reachable host. Compose refuses to start the seed without it |

The seed runs as the **owner**, because clearing effective-dated and append-only tables means
disabling their triggers, which only the owner can do.

### What you get

| | |
|---|---|
| Accounts | 5, all sharing `HRM_DEMO_PASSWORD` |
| `deepa.suresh@panasatech.com` | hr_admin — masters, reports, payslip administration |
| `priya.menon@panasatech.com` | manager — approvals, team effort |
| `vishnu.ravi@panasatech.com` | employee — the one to demonstrate ESS with |
| Organisation | 4 departments (one nested), 4 designations |
| Payslips | 3 issued per employee for 2 employees, each with a real downloadable PDF in MinIO |
| Attendance | History from 31 August to yesterday. **Today is deliberately left open**, so a punch can be demonstrated live |
| Work | 3 projects, 9 tasks, work logs, an approved and a draft timesheet |
| Documents | Uploaded documents for 2 employees |

The employee data is fictional. Take the deployment down when the demo is over rather than
leaving it running.

### Verified end to end

This procedure was executed against the full stack — nginx with TLS, all seven containers — not
inferred. Confirmed working through the edge: login returns
`__Host-hrm_session; HttpOnly; Secure`; the employee sees 3 issued payslips and downloads a
656-byte PDF from MinIO; HR sees 5 employees, 4 departments, 4 designations and 8 reports; and
every screen's data endpoint returns 200 for both roles.

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
