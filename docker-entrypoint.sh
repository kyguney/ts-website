#!/bin/sh
set -e

# Apply the Prisma schema to the database before starting the app.
# `db push` is idempotent and needs no migration files — ideal for this
# single-table waitlist. Retries a few times so it survives a DB that is
# still booting (common on first `docker compose up` and on Coolify).
if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] Syncing database schema with prisma db push..."
  n=0
  until [ "$n" -ge 10 ]; do
    if npx prisma db push --skip-generate; then
      echo "[entrypoint] Database schema is in sync."
      break
    fi
    n=$((n + 1))
    echo "[entrypoint] DB not ready yet (attempt $n/10), retrying in 3s..."
    sleep 3
  done
else
  echo "[entrypoint] WARNING: DATABASE_URL is not set; skipping schema sync."
fi

exec "$@"
