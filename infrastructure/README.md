# infrastructure/

| Path | Holds |
|---|---|
| `db/migrations/` | **Numbered `.sql` files - the source of truth for the schema.** The Drizzle TS schema is a mirror, verified by drift detection |
| `db/seeds/` | Dev and demo seed data |
| `compose/` | `docker-compose.{dev,prod}.yml`, plus `prod.env.template` (the deploy secrets template - the real `prod.env` is gitignored) |
| `docker/` | Dockerfiles - `api`, `web` and the one-shot `migrate` runner. All three build from the REPOSITORY ROOT, because this is an npm-workspaces monorepo |
| `nginx/` | The edge reverse proxy: security headers, rate limiting, body-size caps. **TLS is NOT here** - the host nginx terminates it and proxies to `127.0.0.1:4787` |

## Migration rules

- **Forward-only in production.** Expand/contract: a column rename is three deploys - add and
  dual-write, backfill and switch reads, drop old. Never a single rename.
- Destructive statements need an explicit `-- IRREVERSIBLE:` marker and a fresh verified backup.
- Migrations run as a **separate one-shot container**, never on app boot - an app-boot migration
  means replicas race, and a failure takes down the app.
- Rollback = deploy the previous image, which must still work against the new schema. That is
  what makes expand/contract non-optional.

Writing here is in the `ask` permission list.

## Deploying

`../DEPLOY.md` is the runbook; `../deploy.sh` is the script. In one line:

```bash
cp compose/prod.env.template compose/prod.env   # fill in the three secrets
../deploy.sh
```

The stack publishes **one** host port - `127.0.0.1:4787` on the edge nginx. PostgreSQL and MinIO
have no host port at all.
