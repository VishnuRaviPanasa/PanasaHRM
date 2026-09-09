# =============================================================================
# PanasaHRM - API image (NestJS 11 on Node 24)
# =============================================================================
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not apps/api. The API depends on the
# `@panasa/authz` workspace, so a context rooted at apps/api cannot see the code
# it needs:
#
#     docker build -f infrastructure/docker/api.Dockerfile -t panasahrm/api:<tag> .
#
# Manifests are copied before the sources so `npm ci` caches against
# package-lock.json alone - editing a controller then costs a compile, not a
# dependency install.
# =============================================================================

FROM node:24-alpine AS build
WORKDIR /repo

# Every workspace manifest, even the two that are not built here: `npm ci`
# reconciles the lockfile against the whole workspace set, and a missing
# manifest makes it declare the tree out of sync.
COPY package.json package-lock.json ./
COPY packages/authz/package.json packages/authz/
COPY apps/api/package.json       apps/api/
COPY apps/web/package.json       apps/web/

# `npm ci` from the lockfile, never `npm install`: a deploy must build the
# dependency tree that was tested, not resolve a fresh one.
RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json* ./
COPY packages/authz packages/authz
COPY apps/api       apps/api

# authz first - the API compiles against its emitted .d.ts, so the order is a
# real dependency, not a preference.
RUN npm run build --workspace @panasa/authz \
 && npm run build --workspace @panasa/api

# Rebuild the dependency tree with ONLY what the API needs at runtime.
#
# `npm prune --omit=dev --workspaces` leaves Next and React in the tree of a
# container that will never render a page, because the build installed every
# workspace. Naming the two workspaces the runtime actually uses drops them:
# smaller, and a smaller attack surface - a dependency that is not installed
# cannot be reached.
RUN rm -rf node_modules \
 && npm ci --omit=dev \
      --workspace @panasa/api \
      --workspace @panasa/authz \
      --include-workspace-root \
 && npm cache clean --force

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /repo

ENV NODE_ENV=production
ENV PORT=4000

# `packages/authz` ships whole: node_modules/@panasa/authz is a workspace
# symlink into it, so the directory has to exist for the require to resolve.
# (authz-matrix.yaml travels with it but is NOT read at runtime - only the
# matrix test reads it.)
COPY --from=build --chown=node:node /repo/node_modules          ./node_modules
COPY --from=build --chown=node:node /repo/package.json          ./package.json
COPY --from=build --chown=node:node /repo/packages/authz        ./packages/authz
COPY --from=build --chown=node:node /repo/apps/api/dist         ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json

# Not root. A container that never writes to its own filesystem should not be
# able to.
USER node
EXPOSE 4000

# No migrations on boot (ADR-0013): the one-shot `migrate` service has already
# run and exited. An app-boot migration means replicas race and a failed
# migration takes the app down with it.
#
# Exec form, so the process is PID 1 and receives SIGTERM directly instead of
# waiting out the kill timeout.
CMD ["node", "apps/api/dist/main.js"]
