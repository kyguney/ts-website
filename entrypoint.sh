#!/bin/sh
set -e

# Production entrypoint.
#
# 1. Applies pending database migrations with `prisma migrate deploy`
#    (idempotent, no interactive prompts, safe to run on every boot).
# 2. Then launches the Next.js standalone server (the container CMD).
#
# The Prisma CLI lives in ./prisma-cli/node_modules (a self-contained install
# built in the `prisma-cli` Docker stage), so we invoke its binary directly.

PRISMA_BIN="./prisma-cli/node_modules/.bin/prisma"
SCHEMA="./prisma/schema.prisma"

run_migrations() {
  if [ -z "$DATABASE_URL" ]; then
    echo "[entrypoint] WARNING: DATABASE_URL is not set; skipping migrations."
    return 0
  fi
  if [ ! -x "$PRISMA_BIN" ]; then
    echo "[entrypoint] WARNING: Prisma CLI not found at $PRISMA_BIN; skipping migrations."
    return 0
  fi

  echo "[entrypoint] Applying database migrations (prisma migrate deploy)..."
  # Retry so we survive a database that is still accepting connections late
  # (common on first boot of a fresh Coolify Postgres service).
  n=0
  until [ "$n" -ge 10 ]; do
    if "$PRISMA_BIN" migrate deploy --schema "$SCHEMA"; then
      echo "[entrypoint] Migrations applied."
      return 0
    fi
    n=$((n + 1))
    echo "[entrypoint] DB not ready or migrate failed (attempt $n/10); retrying in 3s..."
    sleep 3
  done

  echo "[entrypoint] ERROR: migrations did not complete after 10 attempts."
  # Exit non-zero so the deployment surfaces the failure rather than starting
  # an app against an un-migrated database.
  exit 1
}

run_migrations

echo "[entrypoint] Starting server: $*"
exec "$@"
