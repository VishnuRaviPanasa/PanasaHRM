# =============================================================================
# PanasaHRM - web image (Next.js 16 App Router, standalone server)
# =============================================================================
#
# BUILD CONTEXT IS THE REPOSITORY ROOT (npm workspaces - see api.Dockerfile):
#
#     docker build -f infrastructure/docker/web.Dockerfile -t panasahrm/web:<tag> .
#
# NOTHING SECRET MAY BE PASSED AS A BUILD ARG. A Next build inlines anything it
# can see into the client bundle, so a secret given to `docker build` ends up in
# JavaScript served to the browser. The two args below are both public by
# nature - a URL prefix and an in-cluster hostname.
# =============================================================================

FROM node:24-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/authz/package.json packages/authz/
COPY apps/api/package.json       apps/api/
COPY apps/web/package.json       apps/web/

RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json* ./
COPY apps/web apps/web

# The public path the app is served under. BUILD-time, because Next resolves
# basePath and assetPrefix during the build and no runtime variable can change
# them. Empty (the default) = served at the root of the published port; the
# path-routed deployment passes /panasa-hrm. See DEPLOY.md.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

# ALSO build-time, and this one is a trap: Next evaluates `rewrites()` in
# next.config.ts during the build and serialises the result into
# routes-manifest.json. A runtime HRM_API_ORIGIN does NOTHING - the container
# dialled 127.0.0.1:4000 and failed until this arg existed. In the production
# stack nginx routes /api/ itself, so this is the fallback being correct rather
# than the hot path.
ARG HRM_API_ORIGIN=http://api:4000
ENV HRM_API_ORIGIN=$HRM_API_ORIGIN

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @panasa/web

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /repo

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
ENV PORT=3100
# Bind every interface: the default of localhost makes the server unreachable
# from outside its own container.
ENV HOSTNAME=0.0.0.0

# The three pieces `output: 'standalone'` splits its output into. `static` and
# `public` are NOT inside the standalone bundle and must be copied alongside it,
# or the app serves HTML with no CSS and no images.
#
# The traced tree mirrors the repository because next.config.ts sets
# outputFileTracingRoot to the repo root, so the entrypoint is apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public           ./apps/web/public

USER node
EXPOSE 3100

CMD ["node", "apps/web/server.js"]
