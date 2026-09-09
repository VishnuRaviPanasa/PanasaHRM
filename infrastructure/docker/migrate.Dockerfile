# --- PanasaHRM migration runner: a one-shot container that applies SQL migrations and exits ---
#
# ADR-0013: migrations NEVER run on app boot. This image is the separate one-shot the ADR
# requires - `docker-compose.prod.yml` runs it to completion before the API is allowed to start.
#
# Based on the postgres image rather than node because `scripts/migrate.mjs` is a psql driver:
# it shells out to `psql` with ON_ERROR_STOP=1 rather than depending on a Node driver, so it
# works before `npm install` and in CI. The client version therefore has to match the server -
# postgres:18-alpine gives psql 18 for free, and Alpine's nodejs package runs the script.

FROM postgres:18-alpine

# nodejs only - no npm, no dependencies: migrate.mjs deliberately imports nothing outside
# node:crypto / node:fs / node:child_process / node:path.
RUN apk add --no-cache nodejs

WORKDIR /repo

# migrate.mjs resolves 'infrastructure/db/migrations' and 'testing/db' relative to the working
# directory, so the layout under /repo has to mirror the repository.
COPY scripts/migrate.mjs        scripts/migrate.mjs
COPY infrastructure/db/migrations infrastructure/db/migrations
COPY testing/db                 testing/db

# The base image's entrypoint is the PostgreSQL server bootstrap; this image is not a server.
ENTRYPOINT ["node", "scripts/migrate.mjs"]
CMD ["up"]
