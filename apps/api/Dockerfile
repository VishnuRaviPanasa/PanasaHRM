# =============================================================================
# ART HRM - API image
# =============================================================================
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not apps/api. The API depends on the
# `@panasa/authz` workspace, so a context rooted at apps/api cannot see the code
# it needs. Build with:
#
#     docker build -f apps/api/Dockerfile -t art-hrm-api:<tag> .
#
# The manifests are copied before the sources so that `npm ci` is cached against
# package-lock.json alone - editing a controller then costs a compile, not a
# dependency install.
# =============================================================================

FROM node:24-alpine AS build
WORKDIR /repo

# Manifests first, for the dependency-install cache layer.
COPY package.json package-lock.json ./
COPY packages/authz/package.json packages/authz/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# `npm ci` from the lockfile, never `npm install`: a deploy must build the
# dependency tree that was tested, not resolve a fresh one.
RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json* ./
COPY packages/authz packages/authz
COPY apps/api apps/api

RUN npm run build --workspace @panasa/authz \
 && npm run build --workspace @panasa/api

# Rebuild the dependency tree with ONLY what the API needs at runtime.
#
# `npm prune --omit=dev --workspaces` was the first attempt and left an 881 MB
# image: the build installs every workspace, so Next and React were still in the
# tree of an API container that will never render a page. Naming the two
# workspaces the runtime actually uses drops them, which is both smaller and a
# smaller attack surface - a dependency that is not installed cannot be reached.
RUN rm -rf node_modules  && npm ci --omit=dev       --workspace @panasa/api       --workspace @panasa/authz       --include-workspace-root  && npm cache clean --force


FROM node:24-alpine AS runtime
WORKDIR /repo

# Runs as the `node` user, not root. A container that does not need to write to
# its own filesystem should not be able to.
ENV NODE_ENV=production
ENV PORT=4000

COPY --from=build --chown=node:node /repo/node_modules       ./node_modules
COPY --from=build --chown=node:node /repo/package.json       ./package.json
COPY --from=build --chown=node:node /repo/packages/authz     ./packages/authz
COPY --from=build --chown=node:node /repo/apps/api/dist      ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json

USER node
EXPOSE 4000

# No shell form: the process must be PID 1 so it receives SIGTERM directly and
# the container stops promptly instead of waiting out the kill timeout.
CMD ["node", "apps/api/dist/main.js"]
