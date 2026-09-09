# =============================================================================
# ART HRM - web image
# =============================================================================
#
# BUILD CONTEXT IS THE REPOSITORY ROOT (npm workspaces):
#
#     docker build -f apps/web/Dockerfile -t art-hrm-web:<tag> .
#
# Relies on `output: 'standalone'` in next.config.ts, which emits a server
# bundle carrying only the files the server actually reaches. Without it the
# runtime image has to ship the whole node_modules tree.
#
# NOTE ON BUILD-TIME CONFIGURATION: nothing secret may be passed here. A Next
# build inlines anything it can see into the client bundle, so a secret given to
# `docker build` ends up in JavaScript served to the browser. Every value this
# app needs is read at RUNTIME instead.
# =============================================================================

FROM node:24-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/authz/package.json packages/authz/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --workspaces --include-workspace-root

COPY packages/authz packages/authz
COPY apps/web apps/web

RUN npm run build --workspace @panasa/web


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Bind to every interface: the default of localhost would make the server
# unreachable from outside its own container.
ENV HOSTNAME=0.0.0.0

# The three pieces `standalone` splits its output into. `static` and `public`
# are NOT inside the standalone bundle and must be copied alongside it, or the
# app serves HTML with no CSS and no images.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public           ./apps/web/public

USER node
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
