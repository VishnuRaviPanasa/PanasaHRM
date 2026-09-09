# --- PanasaHRM API: NestJS 11 on Node 24 ---
#
# Build context is the REPOSITORY ROOT, not this directory: the API is an npm workspace
# (`apps/api`) that depends on another workspace (`packages/authz`), so the lockfile and both
# package manifests have to be in the context.
#
#   docker build -f infrastructure/docker/api.Dockerfile .

FROM node:24-bookworm-slim AS build
WORKDIR /repo

# Manifests first so `npm ci` is cached independently of source changes. Every workspace
# manifest is copied even though only two are built: `npm ci` reconciles the lockfile against
# the whole workspace set, and a missing manifest makes it declare the tree out of sync.
COPY package.json package-lock.json ./
COPY apps/api/package.json     apps/api/package.json
COPY apps/web/package.json     apps/web/package.json
COPY packages/authz/package.json packages/authz/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/authz packages/authz
COPY apps/api       apps/api

# authz first - the API imports its emitted .d.ts, so the order is a real dependency.
RUN npm run authz:build && npm run api:build

# --- runtime -------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# A second, dev-free install rather than copying the build stage's node_modules: that tree
# carries the Nest CLI, TypeScript and the schematics, none of which may be on a production host.
COPY package.json package-lock.json ./
COPY apps/api/package.json     apps/api/package.json
COPY apps/web/package.json     apps/web/package.json
COPY packages/authz/package.json packages/authz/package.json
#
# This installs every workspace's production dependencies, not just the API's, so Next and React
# land in this image unused (~200 MB). `npm ci --workspace @panasa/api --workspace @panasa/authz`
# would trim it, but workspace-filtered installs are fussier about lockfile sync and a deploy
# that fails at image-build time on a single VM is worth more than 200 MB of disk.
RUN npm ci --omit=dev && npm cache clean --force

# The workspace symlink node_modules/@panasa/authz -> packages/authz already exists from the
# install above; this fills in the dist/ it points at.
COPY --from=build /repo/packages/authz/dist packages/authz/dist
COPY --from=build /repo/apps/api/dist       apps/api/dist

# `authz-matrix.yaml` is read at runtime by the policy-coverage assertion, so it ships too.
COPY packages/authz/authz-matrix.yaml packages/authz/authz-matrix.yaml

USER node
WORKDIR /repo/apps/api
EXPOSE 4000

# No migrations on boot (ADR-0013): the `migrate` one-shot service has already run and exited
# by the time this container starts. An app-boot migration means replicas race and a failed
# migration takes the app down with it.
CMD ["node", "dist/main.js"]
