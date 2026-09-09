# =============================================================================
# PanasaHRM - migration runner AND demo seed (one-shot)
# =============================================================================
#
# ADR-0013: migrations run as a SEPARATE one-shot container, never on app boot.
# An app-boot migration means replicas race each other, and a failed migration
# takes the application down with it instead of just failing the deploy.
#
#     docker build -f infrastructure/docker/migrate.Dockerfile \
#       -t panasahrm/migrate:<tag> .
#
# It needs BOTH node and psql: scripts/migrate.mjs is Node, and it shells out to
# `psql` deliberately, so the migration path has no driver dependency of its own
# and the SQL that runs is the SQL in the file.
# =============================================================================

FROM node:24-alpine

# postgresql CLIENT only - no server. Pinned to 18 to match the server major
# version: psql 17 against an 18 cluster is a mismatch nobody notices until it
# matters. (Alpine 3.24 carries postgresql18-client 18.6.)
RUN apk add --no-cache postgresql18-client

WORKDIR /repo

# migrate.mjs resolves 'infrastructure/db/migrations' and 'testing/db' relative
# to the working directory, so the layout under /repo mirrors the repository.
COPY scripts/migrate.mjs          scripts/migrate.mjs
COPY scripts/seed.mjs             scripts/seed.mjs
COPY infrastructure/db/migrations infrastructure/db/migrations
COPY infrastructure/db/seeds      infrastructure/db/seeds
COPY testing/db                   testing/db

# THE ONE DEPENDENCY, and only the seed needs it.
#
# The demo seed uploads a generated payslip PDF per record to MinIO, because a
# payslip whose document 404s is worse demo data than none - the product looks
# broken rather than empty. That step needs the MinIO client; everything else
# here is Node's standard library.
#
# Pinned to the exact version apps/api uses, so the two cannot drift.
RUN npm install --no-save --no-package-lock --omit=dev minio@8.0.7 \
 && npm cache clean --force

USER node

# No ENTRYPOINT, so one image serves both jobs and the COMMAND says which:
#   node scripts/migrate.mjs up       apply migrations   (the deploy gate)
#   node scripts/migrate.mjs status   report state
#   node scripts/seed.mjs             load DEMO data     (DESTRUCTIVE)
#
# The default is the safe one. Exits non-zero on failure, which is what makes it
# usable as a deploy gate.
CMD ["node", "scripts/migrate.mjs", "up"]
