#!/usr/bin/env bash
#
# PanasaHRM production deploy (ADR-0013: Docker Compose on a single VM).
#
#   host nginx (TLS :7777) --/panasa-hrm/-->  127.0.0.1:4788  -->  nginx --> web :3100
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
  echo "  # then set the owner/app DB passwords, the MinIO keys and the Redis password" >&2
  exit 1
fi

# A blank required value is worse than a missing file: compose would substitute an empty string
# and PostgreSQL would come up with trust authentication.
# A plain string rather than an array: `${#arr[@]}` on an empty array is an unbound-variable
# error under `set -u` on bash 4.2, which is still what some LTS hosts ship.
missing=""
for var in HRM_PG_OWNER_USER HRM_PG_OWNER_PASSWORD HRM_PG_APP_USER HRM_PG_APP_PASSWORD PGDATABASE HRM_MINIO_ACCESS_KEY HRM_MINIO_SECRET_KEY HRM_REDIS_PASSWORD; do
  value="$(grep -E "^${var}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [ -n "$value" ] || missing="$missing $var"
done
if [ -n "$missing" ]; then
  echo "These are empty in $ENV_FILE and have no safe default:$missing" >&2
  exit 1
fi

# The AI assistant (ADR-0020) is off unless prod.env turns it on. When it IS on, the key file has
# to exist and be readable BEFORE compose starts, because both ways of getting that wrong fail
# silently at the wrong layer: Docker creates a DIRECTORY at a missing bind source, and a
# root-owned 0400 file is unreadable by the container's `node` user (uid 1000). Either way the API
# comes up healthy and refuses every question, which reads like a code problem and is not.
assistant_on="$(grep -E '^HRM_ASSISTANT_ENABLED=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
if [ "$assistant_on" = "true" ]; then
  keypath="$(grep -E '^HRM_LLM_KEY_HOST_PATH=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  # Compose strips surrounding quotes from an env-file value, so this has to as well - otherwise a
  # perfectly good quoted path is reported as a file that does not exist.
  keypath="${keypath%\"}"; keypath="${keypath#\"}"
  keypath="${keypath%\'}"; keypath="${keypath#\'}"
  if [ -z "$keypath" ]; then
    echo "HRM_ASSISTANT_ENABLED=true but HRM_LLM_KEY_HOST_PATH is empty in $ENV_FILE." >&2
    echo "  The provider key is file-backed; there is no plain-variable path in this stack." >&2
    exit 1
  fi
  if [ ! -f "$keypath" ]; then
    echo "HRM_LLM_KEY_HOST_PATH does not name an existing file: $keypath" >&2
    echo "  Create it FIRST - Docker would otherwise bind-mount a new directory:" >&2
    echo "    sudo install -o 1000 -g 1000 -m 0400 /dev/null '$keypath'" >&2
    echo "    sudo sh -c 'printf %s \"sk-...\" > $keypath'" >&2
    exit 1
  fi
  if [ ! -s "$keypath" ]; then
    echo "HRM_LLM_KEY_HOST_PATH names an EMPTY file: $keypath" >&2
    echo "  An empty key file is the same as no key - the assistant would refuse every" >&2
    echo "  question while reporting itself enabled." >&2
    exit 1
  fi
  echo "NOTE: the AI assistant is ENABLED in $ENV_FILE."
  echo "      ADR-0020's release gate is a 100% assistant:redteam score with no waiver, and the"
  echo "      answer is written from result rows, which sends them to the provider (DEC-140)."
fi

# Read the published port back out of the env file so the health check below cannot drift from
# what compose actually publishes.
PORT="$(grep -E '^HRM_PUBLISH_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
PORT="${PORT:-4788}"
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
$DC run --rm migrate

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
# curl already prints `000` as %{http_code} when it gets no response at all, so there is NO
# `|| echo 000` fallback here: that appended a second value to curl's own, and a healthy probe
# came back as "200000" - a deploy that reported failure while the stack was fine.
probe() {
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}$1" 2>/dev/null)" || true
  printf '%s' "${code:-000}"
}

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
printf '  edge  /healthz                %s  (expect 200)\n' "$edge"
printf '  api   %-24s%s  (expect 401 - no session)\n' "${BASE}/api/auth/me" "$apiz"
printf '  web   %-24s%s  (expect 200)\n' "${BASE}/login" "$webz"
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
