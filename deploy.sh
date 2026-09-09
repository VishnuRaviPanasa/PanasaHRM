#!/usr/bin/env bash
#
# PanasaHRM production deploy (ADR-0013: Docker Compose on a single VM).
#
#   host nginx (TLS :7777) --/panasa-hrm/-->  127.0.0.1:4787  -->  nginx --> web :3100
#                                                                        `-> api :4000
#
# Usage:
#   ./deploy.sh                 # pull, build, migrate, (re)start, health-check
#   ./deploy.sh --no-pull       # deploy the current checkout, no git pull
#   ./deploy.sh --no-build      # restart the existing images
#   ./deploy.sh --status        # report only; change nothing
#
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="infrastructure/compose/docker-compose.prod.yml"
ENV_FILE="infrastructure/compose/prod.env"
ENV_TEMPLATE="infrastructure/compose/prod.env.template"

PULL=1
BUILD=1
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-pull)  PULL=0 ;;
    --no-build) BUILD=0 ;;
    --status)   STATUS_ONLY=1 ;;
    -h|--help)  sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# docker compose v2 (plugin) preferred, fall back to legacy docker-compose.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose not found. Install Docker first." >&2
  exit 1
fi

DC="$COMPOSE -f $COMPOSE_FILE --env-file $ENV_FILE"

# --- preflight ------------------------------------------------------------------------------

# Secrets are injected at runtime via the env file and are never baked into an image.
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE." >&2
  echo "  cp $ENV_TEMPLATE $ENV_FILE" >&2
  echo "  # then set PGPASSWORD, HRM_MINIO_ACCESS_KEY and HRM_MINIO_SECRET_KEY" >&2
  exit 1
fi

# A blank required value is worse than a missing file: compose would substitute an empty string
# and PostgreSQL would come up with trust authentication.
# A plain string rather than an array: `${#arr[@]}` on an empty array is an unbound-variable
# error under `set -u` on bash 4.2, which is still what some LTS hosts ship.
missing=""
for var in PGUSER PGPASSWORD PGDATABASE HRM_MINIO_ACCESS_KEY HRM_MINIO_SECRET_KEY; do
  value="$(grep -E "^${var}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [ -n "$value" ] || missing="$missing $var"
done
if [ -n "$missing" ]; then
  echo "These are empty in $ENV_FILE and have no safe default:$missing" >&2
  exit 1
fi

# Read the published port back out of the env file so the health check below cannot drift from
# what compose actually publishes.
PORT="$(grep -E '^HRM_PUBLISH_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
PORT="${PORT:-4787}"
BASE="$(grep -E '^NEXT_PUBLIC_BASE_PATH=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
BASE="${BASE%/}"

if [ "$STATUS_ONLY" -eq 1 ]; then
  $DC ps
  exit 0
fi

# --- deploy ---------------------------------------------------------------------------------

if [ "$PULL" -eq 1 ] && [ -d .git ]; then
  echo "==> Pulling latest changes"
  git pull --ff-only
fi

if [ "$BUILD" -eq 1 ]; then
  # ADR-0013 wants images built in CI and deployed by digest; no CI exists yet (amendment (a)),
  # so they are built here. That is the gap, recorded rather than papered over.
  echo "==> Building images"
  $DC build
fi

# ADR-0013: migrations are a one-shot container, never an app-boot step. Running it explicitly
# here (rather than only through depends_on) means a failed migration stops the deploy with its
# own output on screen, before anything is restarted.
echo "==> Applying migrations"
$DC up -d postgres
$DC run --rm migrate up

echo "==> Starting the stack"
$DC up -d

# --- verify ---------------------------------------------------------------------------------
#
# Three separate checks, because "the port answers" has hidden a broken app before:
#   1. the edge nginx is up            -> /healthz, answered by nginx itself
#   2. the API is routing              -> /api/auth/me returns 401 (no session), NOT a 502
#   3. the web app renders             -> /login returns 200
#
echo "==> Waiting for the stack"
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}$1" || echo 000; }

edge=000 apiz=000 webz=000
for _ in $(seq 1 45); do
  edge="$(probe "/healthz")"
  apiz="$(probe "${BASE}/api/auth/me")"
  webz="$(probe "${BASE}/login")"
  [ "$edge" = "200" ] && [ "$apiz" = "401" ] && [ "$webz" = "200" ] && break
  sleep 2
done

echo
$DC ps
echo
printf '  edge  /healthz              %s  (expect 200)\n' "$edge"
printf '  api   %-22s%s  (expect 401 - no session)\n' "${BASE}/api/auth/me" "$apiz"
printf '  web   %-22s%s  (expect 200)\n' "${BASE}/login" "$webz"
echo

if [ "$edge" = "200" ] && [ "$apiz" = "401" ] && [ "$webz" = "200" ]; then
  echo "Deploy complete."
  echo "  local  : http://127.0.0.1:${PORT}${BASE}/"
  echo "  public : https://ai.arttechgroup.com:7777${BASE}/   (once the host nginx block is in place - see DEPLOY.md)"
  exit 0
fi

echo "Stack started but did not reach a healthy state." >&2
if [ "$apiz" = "502" ] || [ "$apiz" = "000" ]; then
  echo "  The API is not answering. Most likely the migration or the database:" >&2
  echo "    $DC logs api" >&2
  echo "    $DC logs postgres" >&2
fi
echo "  All logs:  $DC logs -f" >&2
exit 1
