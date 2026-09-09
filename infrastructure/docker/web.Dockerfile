# --- PanasaHRM web: Next.js 16 (App Router), standalone server ---
#
# Build context is the REPOSITORY ROOT (npm workspaces - see api.Dockerfile for why).
#
#   docker build -f infrastructure/docker/web.Dockerfile .

FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json     apps/api/package.json
COPY apps/web/package.json     apps/web/package.json
COPY packages/authz/package.json packages/authz/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/web apps/web

# The public path the app is served under, baked in at BUILD time because Next resolves
# basePath and assetPrefix during the build - it cannot be changed by an env var at runtime.
# Empty (the default) = served at the root of the published port.
# The host nginx path-routing case passes /panasa-hrm here; see DEPLOY.md.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

# ALSO build-time, and this one is a trap: Next evaluates next.config.ts `rewrites()` during the
# build and serialises the result into routes-manifest.json. A runtime HRM_API_ORIGIN therefore
# does NOTHING - the container was still dialling 127.0.0.1:4000 until this arg existed. In the
# production stack nginx routes /api/ itself and this rewrite is never exercised, so this is the
# fallback being correct rather than the hot path.
ARG HRM_API_ORIGIN=http://api:4000
ENV HRM_API_ORIGIN=$HRM_API_ORIGIN

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run web:build

# --- runtime -------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# `output: 'standalone'` traces the exact files the server needs and emits its own minimal
# node_modules, so there is no npm install in this stage at all. `outputFileTracingRoot` is set
# to the repository root in next.config.ts, so the traced tree mirrors the repo layout and the
# entrypoint lands at apps/web/server.js.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build /repo/apps/web/public           ./apps/web/public

USER node
ENV PORT=3100 HOSTNAME=0.0.0.0
EXPOSE 3100

CMD ["node", "apps/web/server.js"]
