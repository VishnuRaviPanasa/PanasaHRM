# infrastructure/

| Path | Holds |
|---|---|
| `db/migrations/` | **Numbered `.sql` files - the source of truth for the schema.** The Drizzle TS schema is a mirror, verified by drift detection |
| `db/seeds/` | Dev and demo seed data |
| `compose/` | `docker-compose.{dev,prod}.yml` |
| `docker/` | Dockerfiles |
| `nginx/` | TLS, security headers, rate limiting, body-size caps |

## Migration rules

- **Forward-only in production.** Expand/contract: a column rename is three deploys - add and
  dual-write, backfill and switch reads, drop old. Never a single rename.
- Destructive statements need an explicit `-- IRREVERSIBLE:` marker and a fresh verified backup.
- Migrations run as a **separate one-shot container**, never on app boot - an app-boot migration
  means replicas race, and a failure takes down the app.
- Rollback = deploy the previous image, which must still work against the new schema. That is
  what makes expand/contract non-optional.

Writing here is in the `ask` permission list.
