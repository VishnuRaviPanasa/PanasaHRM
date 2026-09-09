#!/bin/sh
# =============================================================================
# ART HRM - generate the deployment environment file
# =============================================================================
#
# RUN THIS ON THE SERVER. That is the entire point.
#
# The secrets this deployment needs must never travel through chat, email or a
# ticket. A PostgreSQL owner password gives full control of every record; the
# MinIO secret key is equivalent to a bulk export of every employee document
# and payslip in the system. Anything sent over a messaging channel lands in
# message history, mail archives and backups nobody involved controls, and it
# cannot be un-sent - rotating it later does not remove the copies.
#
# So no secret is written down by a person or shared by anyone. This script
# generates them with `openssl rand` on the host that will use them, writes the
# file 0600, and prints only the values that are NOT secret.
#
#   sudo mkdir -p /etc/art-hrm
#   sudo sh scripts/make-env.sh /etc/art-hrm/env
#
# Then set the two values only you know - see the summary it prints.
#
# There is deliberately no `.env.example` in this repository, and this script is
# not one: it contains no values, only the means to make them.
# =============================================================================

set -eu

OUT="${1:-/etc/art-hrm/env}"

if [ -z "${OUT}" ]; then
  echo "usage: sh scripts/make-env.sh <output-path>" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# REFUSE TO OVERWRITE. This is not politeness.
#
# Regenerating over a live file rotates the database password in the file while
# the database still expects the old one, so the next deploy fails to connect -
# and rotates the MinIO key while the existing objects are still under the old
# credential. Recovering means knowing what the previous values were, which by
# design nobody does.
# ---------------------------------------------------------------------------
if [ -e "${OUT}" ]; then
  echo "REFUSING: ${OUT} already exists." >&2
  echo "" >&2
  echo "Regenerating would rotate the database and object-store credentials while" >&2
  echo "the services still expect the current ones. To rotate deliberately, change" >&2
  echo "the credential in PostgreSQL and MinIO first, then edit this file." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "REFUSING: openssl not found. It is needed to generate the secrets." >&2
  echo "Install it (apk add openssl / apt-get install openssl) and re-run." >&2
  exit 1
fi

# `openssl rand -base64` can emit characters that need quoting in a compose
# environment file. Base64 output is filtered to an alphanumeric set instead -
# 40 characters of [A-Za-z0-9] is about 238 bits, far more than enough, and it
# survives every shell and parser in the path without escaping.
randpw() {
  openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-40
}

OWNER_PW="$(randpw)"
APP_PW="$(randpw)"
MINIO_KEY="$(openssl rand -hex 12)"
MINIO_SECRET="$(randpw)"

umask 077
cat > "${OUT}" <<EOF
# ART HRM deployment environment
# Generated on $(date -u '+%Y-%m-%d %H:%M UTC') by scripts/make-env.sh
#
# Mode 0600. Do not copy this file, do not paste its contents into a message,
# and do not commit it. If it leaks, rotate every value below in PostgreSQL and
# MinIO before replacing them here.

# --- Release ---------------------------------------------------------------
# The image tag or digest being deployed. SET THIS.
HRM_IMAGE_TAG=

# Directory on this host holding fullchain.pem and privkey.pem. SET THIS.
HRM_TLS_DIR=

# --- Database --------------------------------------------------------------
HRM_PG_DATABASE=hrm

# Owns the schema. Used by the postgres and migrate containers ONLY.
HRM_PG_OWNER_USER=hrm_owner
HRM_PG_OWNER_PASSWORD=${OWNER_PW}

# The application role - least privilege. Until section 4 of the runbook is
# done this must equal the owner above, and the payslip Tier-1 isolation has no
# effect. Change BOTH lines together when you switch it.
HRM_PG_APP_USER=hrm_owner
HRM_PG_APP_PASSWORD=${OWNER_PW}

# --- Object storage --------------------------------------------------------
# The secret key is equivalent to a bulk export of every employee document.
HRM_MINIO_ACCESS_KEY=${MINIO_KEY}
HRM_MINIO_SECRET_KEY=${MINIO_SECRET}
HRM_DOC_BUCKET=hrm-documents

# --- Demo data only --------------------------------------------------------
# Required ONLY by the seed profile (runbook section 9). Every demo account
# shares this one password, so treat it as a shared credential on a reachable
# host: set it to something private, share it out of band, and remove the
# deployment when the demonstration is over.
HRM_DEMO_PASSWORD=${APP_PW}
EOF

chmod 600 "${OUT}"

# REPORT THE MODE ACHIEVED, not the one requested.
#
# `chmod` succeeds silently on filesystems that do not implement POSIX
# permissions - a Windows checkout, or a volume mounted without them. Printing
# "mode 0600" regardless would be a claim the script had not checked, and the
# one case where it is false is exactly the case somebody needs to know about.
MODE="$(stat -c '%a' "${OUT}" 2>/dev/null || stat -f '%OLp' "${OUT}" 2>/dev/null || echo '?')"
if [ "${MODE}" != "600" ]; then
  echo "" >&2
  echo "WARNING: ${OUT} is mode ${MODE}, not 600." >&2
  echo "This filesystem did not apply the permission. The file holds the database and" >&2
  echo "object-store credentials in plain text - restrict it before deploying, or move" >&2
  echo "it to a filesystem that supports POSIX permissions." >&2
  echo "" >&2
fi

# ---------------------------------------------------------------------------
# The summary prints NO secret. Everything below is either non-sensitive or a
# path - so this output is safe to paste into a ticket, which is exactly why it
# is separated from the file.
# ---------------------------------------------------------------------------
cat <<EOF

Wrote ${OUT} (mode ${MODE}, $(wc -l < "${OUT}" | tr -d ' ') lines)

  Generated for you, and not printed here:
    HRM_PG_OWNER_PASSWORD    40 chars, alphanumeric
    HRM_PG_APP_PASSWORD      same as owner until the runbook's role step is done
    HRM_MINIO_ACCESS_KEY     24 hex chars
    HRM_MINIO_SECRET_KEY     40 chars, alphanumeric
    HRM_DEMO_PASSWORD        40 chars - only used by the seed profile

  Set by default:
    HRM_PG_DATABASE          hrm
    HRM_PG_OWNER_USER        hrm_owner
    HRM_PG_APP_USER          hrm_owner   <- see runbook section 4
    HRM_DOC_BUCKET           hrm-documents

  STILL TO SET - the two values only you know:
    HRM_IMAGE_TAG            the release being deployed
    HRM_TLS_DIR              directory holding fullchain.pem and privkey.pem

Next:  docker compose --env-file ${OUT} \\
         -f infrastructure/compose/docker-compose.prod.yml config >/dev/null

That validates the file without starting anything. Compose uses \${VAR:?...},
so it names any variable still missing.

EOF
