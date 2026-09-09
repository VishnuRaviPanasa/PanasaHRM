# Deploying PanasaHRM

Docker Compose on a single company VM (**ADR-0013**), published on loopback and fronted by the
host nginx that terminates TLS and path-routes every app on the box.

```
browser
  │  https
  ▼
host nginx (TLS :7777)  ──/panasa-hrm/──►  127.0.0.1:4788
                                                 │  edge nginx (:80)  — headers, rate limits, body cap
                                                 ├── /api/  ──►  api  :4000   NestJS 11 / Node 24
                                                 └── /      ──►  web  :3100   Next.js 16 (standalone)
                                                                   │
                                       postgres :5432  ◄────────────┤   (no host port)
                                       minio    :9000  ◄────────────┘   (no host port)

                                       migrate  ── one-shot, runs to completion, then exits
```

**4788** is this app's slot on the host. 4765, 4766 and 4767 belong to other apps (4767 is the
resume-filtering agent), and **4787 was found already in use**, so the slot moved up one. Only
the edge nginx publishes a port, and it publishes to `127.0.0.1` only — PostgreSQL, MinIO and
Redis are reachable on the compose network and nowhere else.

| Piece | File |
|---|---|
| Stack definition | `infrastructure/compose/docker-compose.prod.yml` |
| API image | `infrastructure/docker/api.Dockerfile` |
| Web image | `infrastructure/docker/web.Dockerfile` |
| Migration runner | `infrastructure/docker/migrate.Dockerfile` |
| Edge nginx | `infrastructure/nginx/nginx.conf.template` (envsubst, see below), `infrastructure/nginx/hrm_proxy_params` |
| Secrets template | `infrastructure/compose/prod.env.template` |
| Deploy script | `deploy.sh` |

---

## 1. Configure secrets

Secrets are injected at runtime through the compose env file. **Nothing is baked into an image**
— `.dockerignore` excludes every `.env*` from all three build contexts.

```bash
cp infrastructure/compose/prod.env.template infrastructure/compose/prod.env
```

Then fill in the three required values, each with its own freshly generated secret:

| Variable | What it is |
|---|---|
| `HRM_PG_OWNER_PASSWORD` | The PostgreSQL **owner** role. Creates the cluster, and what the migration runner and the seed connect with |
| `HRM_PG_APP_PASSWORD` | What the **API** connects with. Should be least-privilege `hrm_app` — **but set it to the owner for now**, see below |
| `HRM_MINIO_ACCESS_KEY` | MinIO root user (≥ 3 chars) |
| `HRM_MINIO_SECRET_KEY` | MinIO root password (≥ 8 chars) |
| `HRM_REDIS_PASSWORD` | Redis runs but nothing uses it yet (OR-21). Password it anyway |

**The API must still connect as the owner.** Separating the roles is the point of migration 0008,
and while the API is the owner it bypasses every grant including the Tier-1 revokes on the payslip
tables (OR-29). But finding **P3-7** means the leave flow cannot run as `hrm_app` at all — the
ledger trigger needs a grant the role lacks. So `HRM_PG_APP_*` are the owner's credentials today;
the variables are separate so that fixing P3-7 is a config change, not a compose rewrite.

```bash
openssl rand -base64 30 | tr -d '/+=' | cut -c1-32
```

`prod.env` is gitignored. `deploy.sh` refuses to run if it is missing **or if any required value
is blank** — an empty owner password would otherwise bring PostgreSQL up on trust authentication.

> The file is `prod.env`, not `.env`, on purpose: writing to `.env*` is a Forbidden Action in
> `CLAUDE.md` and the guard is worth more than the naming convention.

**The owner password only creates the role on the very first boot**, when the `pgdata` volume is
empty. Changing it later does not change the role's password — `ALTER ROLE hrm PASSWORD …`, then
update the file.

### The session cookie

`HRM_SECURE_COOKIES=true` drives **both** the cookie's `Secure` flag and its `__Host-` name prefix
(ADR-0010). It must be true for anything reached over https. It is deliberately one switch and not
two: a browser refuses a `Secure` cookie over plain HTTP *and* refuses a `__Host-` cookie without
`Secure`, so a half-configured deployment fails loudly at login instead of quietly downgrading.

## 2. Deploy

```bash
./deploy.sh              # pull, build, migrate, start, verify
./deploy.sh --no-pull    # deploy the current checkout
./deploy.sh --no-build   # restart the existing images
./deploy.sh --status     # report only, change nothing
```

Or by hand:

```bash
DC="docker compose -f infrastructure/compose/docker-compose.prod.yml --env-file infrastructure/compose/prod.env"
$DC build
$DC up -d postgres
$DC run --rm migrate up     # one-shot; must exit 0
$DC up -d
```

### What the deploy verifies

Three checks, not one — "the port answers" has hidden a broken app before:

| Probe | Expected | Proves |
|---|---|---|
| `/healthz` | `200` | the edge nginx is up (answered by nginx itself) |
| `/api/auth/me` | **`401`** | the API is running and routing. A `502` means it is down; a `500` means it is up and broken |
| `/login` | `200` | the web app renders |

`401` is the success condition for the API on purpose. There is no unauthenticated health route,
and adding one would need an `authz-matrix.yaml` entry (a Forbidden Action without it) — an
authentication refusal is a perfectly good liveness signal.

### Migrations

`migrate` is a **separate one-shot container** that applies `infrastructure/db/migrations/*.sql`
and exits (ADR-0013). The API's `depends_on` uses `service_completed_successfully`, so a failed
migration means the API never starts against a half-applied schema.

The image is built on `postgres:18-alpine` rather than on Node: `scripts/migrate.mjs` drives
`psql` rather than a Node driver, so the client version must match the server, and the base image
supplies psql 18 for free.

The runner is checksum-enforced (DEC-012): **a defect in an applied migration is fixed by the
next migration, never by editing the applied one.**

## 3. Wire it into the host nginx

The host nginx terminates TLS on `:7777` and routes `/chatbot/`, `/storia/`, `/hr-agent/`, … to
loopback ports. Add PanasaHRM alongside them, in e.g. `/etc/nginx/conf.d/ai.conf`:

```nginx
# --- alongside the other upstream { } blocks ---
upstream panasa_hrm_app {
    server 127.0.0.1:4788;
}

# --- inside the `server { listen 7777 ssl ... }` block ---
location = /panasa-hrm {
    return 301 /panasa-hrm/;
}

location /panasa-hrm/ {
    # NOTE: NO rewrite, unlike /hr-agent/. Next is built with basePath=/panasa-hrm and serves
    # every route and asset under that prefix already; stripping it here would 404 the app.
    proxy_pass http://panasa_hrm_app;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 26m;    # 25 MiB document cap plus the multipart envelope
    proxy_read_timeout   120s;   # document streams through the API (DEC-046)
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Check the port is free on the host first

```bash
ss -ltnp | grep 4788     # must print nothing
```

4788 was chosen because 4765/4766/4767 belong to other apps and 4787 turned out to be in use
too. If something already holds 4788 on the VM, change `HRM_PUBLISH_PORT` in `prod.env` **and**
the `panasa_hrm_app` upstream above — they must agree, and `deploy.sh` reads the port back out of
`prod.env` so its health probes follow automatically.

### The base path is a BUILD-time value

Next resolves `basePath` and `assetPrefix` during the build — no runtime variable can change
them. `NEXT_PUBLIC_BASE_PATH` in `prod.env` is passed as a build arg, so **changing the prefix
means rebuilding the web image** (`./deploy.sh` does).

The host nginx `location`, the `NEXT_PUBLIC_BASE_PATH` value and the upstream port must always
agree. Two of the three agreeing is the failure mode that produces a page whose HTML loads and
whose CSS 404s.

To serve at the root instead (a dedicated hostname or `server {}` block), set
`NEXT_PUBLIC_BASE_PATH=` empty and rebuild.

**The prefix has to match in three places, and two of them are baked into images:**

| Where | How it gets there | Symptom if it disagrees |
|---|---|---|
| The web image | `NEXT_PUBLIC_BASE_PATH` build arg | HTML loads, every asset 404s |
| The edge nginx | `HRM_BASE_PATH` → envsubst over `nginx.conf.template` | **Silent.** The API location stops matching, so `/api/` falls through to Next, which proxies it onward — the app still works, with a Node hop in front of every document stream |
| The host nginx | the `location` block | 404 at the front door |

Compose drives all three from the single `NEXT_PUBLIC_BASE_PATH` value in `prod.env`, so they
cannot drift as long as you change it there and rebuild.

The nginx config is a **template**, not a finished file: the official image runs envsubst over
`/etc/nginx/templates/*.template`, and the compose file points `NGINX_ENVSUBST_OUTPUT_DIR` at
`/etc/nginx` so it lands as `nginx.conf`. `HRM_BASE_PATH` is the only thing substituted — nginx's
own `$variables` are untouched, because envsubst only replaces names that exist in the
environment and none of these do.

To see what nginx actually ended up with:

```bash
$DC exec nginx nginx -T | head -40
```

Next's `basePath` covers `<Link>`, `router.push` and `next/image`. It does **not** cover URLs the
app builds itself as root-absolute strings — `fetch('/api/...')`, a raw `<img src>`, an
assignment to `window.location.href`. Those go through `apps/web/lib/base-path.ts`; use
`withBasePath()` for any new one, and never on a `<Link href>` (Next has already applied it, and
twice gives `/panasa-hrm/panasa-hrm/...`).

## 4. First run — seeding

The migration runner applies schema only. A brand-new database has no users, so nobody can log
in. Seeding is **not** part of `deploy.sh`: `scripts/seed.mjs` deletes and recreates demo data
and must never be pointed at a live database by accident.

The `migrate` image carries `migrate.mjs` only — not `seed.mjs`, which needs `psql` **and** the
MinIO client from `node_modules` to upload the demo documents. So there is no seed container, on
purpose. For a demo or staging instance, publish the two ports temporarily and run the seed from
a checkout on the host:

```bash
# temporary, for seeding only — then remove the published ports and `up -d` again
$DC up -d
docker compose -f infrastructure/compose/docker-compose.prod.yml --env-file infrastructure/compose/prod.env \
  port postgres 5432                       # confirm it is NOT published; add a mapping if you must

PGHOST=127.0.0.1 PGPORT=<mapped> PGUSER=hrm PGPASSWORD=… PGDATABASE=hrm \
HRM_MINIO_HOST=127.0.0.1 HRM_MINIO_PORT=<mapped> \
HRM_MINIO_ACCESS_KEY=… HRM_MINIO_SECRET_KEY=… HRM_DEMO_PASSWORD='<choose one>' \
  npm run db:seed
```

> **Never run the seed against a real instance.** `scripts/seed.mjs` deletes and recreates its
> data, and it has its own dev-target guard for exactly this reason.
>
> For a real go-live the first HR administrator should come from a dedicated bootstrap step, not
> from the demo seed. **That does not exist yet** — see "Before go-live".

## Common operations

```bash
DC="docker compose -f infrastructure/compose/docker-compose.prod.yml --env-file infrastructure/compose/prod.env"

$DC ps                      # container status
$DC logs -f api             # tail one service
$DC logs -f                 # tail everything
$DC run --rm migrate status # which migrations are applied
$DC restart api
$DC down                    # stop the stack, KEEP the data
```

**`docker compose down -v` destroys the database and every uploaded document.** It is in the
denied list in `.claude/settings.json` for that reason. There is no restore procedure yet (see
below), so today that command is unrecoverable data loss.

### Backups — the data path is not where you would look

`DEC-010` / ADR-0013(c): the volume mounts at `/var/lib/postgresql`, **not** `/var/lib/postgresql/data`,
because PG18 places the cluster in a major-version subdirectory so a later `pg_upgrade --link`
works across the mount boundary.

**The live data path is `/var/lib/postgresql/18/docker`.** Any backup or restore must target it
explicitly. Prefer a logical dump anyway:

```bash
$DC exec -T postgres pg_dump -U hrm -d hrm --format=custom > hrm-$(date +%F).dump
```

## Known gaps

Recorded rather than papered over. None is introduced by this deployment; all are visible from it.

| Gap | Detail |
|---|---|
| **No verified restore drill** | ADR-0013 amendment (b). There is no backup script, no restore runbook and no drill. This is the single-VM decision's principal accepted risk, and Phase 9 gates go-live on closing it |
| **Images are built on the host** | ADR-0013 wants CI-built images deployed by digest. No CI exists (amendment (a), task T12). `HRM_IMAGE_TAG` is the seam for it |
| **The audit trail records the proxy, not the employee** | `apps/api/src/auth.ts` takes the client address from `req.socket.remoteAddress`, which behind this proxy is the nginx container. The edge sets `X-Real-IP` and `X-Forwarded-For` correctly; the API needs `trust proxy` and to read them |
| **The session cookie is not yet `__Host-`** | ADR-0010 specifies `__Host-hrm_session`. `Secure` is now set (`HRM_COOKIE_SECURE=true`), which was the missing precondition; the rename remains, and it logs every user out, so it belongs in its own change |
| **Sessions are in PostgreSQL, not Redis** | ADR-0010 makes Redis authoritative for the session record. Redis is therefore deliberately absent from this stack — adding it implies a session migration, and it should land with the BullMQ worker that also needs it |
| **No observability** | ADR-0013 names OpenTelemetry; nothing is instrumented |
| **No virus scanner** | OR-23. The quarantine gate in migration 0018 is enforced by the database, but nothing promotes a version to `clean` by actually scanning it |
| **`HRM_API_ORIGIN` is inert at runtime** | Next bakes `rewrites()` into the routes manifest at build time, so only the build arg matters. Both are set to the same value. Harmless in this stack (nginx routes `/api/` itself) but it will surprise anyone who tries to repoint the API by restarting the container |
| **Authorization retrofit incomplete** | OR-19. `hr.ts`, `leave.ts` and parts of `work.ts` still decide in the controller, which is a standing violation of Must-Know Rule 1. Deploying does not change that, but it does expose it |

## Before go-live

Not a checklist of nice-to-haves — each of these is a decision someone has to make explicitly.

1. A **verified restore drill** from an off-host encrypted backup (ADR-0013 amendment (b)).
2. **First-administrator bootstrap** that is not the demo seed.
3. The **authorization retrofit** (OR-19) and **audit emission** (AUDIT-01, Must-Know Rule 2 is
   still unsatisfied on every write path).
4. **HSTS and the TLS configuration on the host nginx** — this stack sets every other security
   header but cannot set that one, because it does not own the TLS origin.
5. A **restart policy for the host** — `restart: unless-stopped` covers a container crash, not a
   reboot; the Docker daemon must be enabled at boot.
